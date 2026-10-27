import type RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three/webgpu';
import { config } from '../config';
import { events } from '../core/events';
import type { Input } from '../core/input';
import type { DebrisItem } from '../destruction/debris';
import type { DestructionSystem } from '../destruction/destruction';
import { KIND, STATE } from '../destruction/pieces';
import type { Physics } from '../physics/physics';
import type { PlayerController } from '../player/controller';

export type HeroAction =
  | 'none'
  | 'punchR'
  | 'punchL'
  | 'finisher'
  | 'uppercutCharge'
  | 'uppercut'
  | 'carry'
  | 'throw'
  | 'slam';

const _o = new THREE.Vector3();
const _d = new THREE.Vector3();
const _hit = new THREE.Vector3();
const _chest = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _ex = new THREE.Vector3();
const _origin = { x: 0, y: 0, z: 0 };
const _dir = { x: 0, y: 0, z: 0 };

/** Anything the hero can hold and throw: a debris chunk or a vehicle (a rigid body). */
export interface Holdable {
  body: RAPIER.RigidBody | null;
  hx: number;
  hy: number;
  hz: number;
  mass: number;
  held: boolean;
  thrown: number;
  sleep: number;
  live: boolean;
}

/** A person or vehicle in front of his fists (M5), found and struck by the game's adapter. */
export interface ExtraTarget {
  kind: 'npc' | 'vehicle';
  id: number;
}

/** People and vehicles as punch/grab targets (implemented by the game; keeps systems decoupled). */
export interface ExtraTargets {
  /** Nearest person or vehicle along the ray within maxT; writes the hit point into out. */
  find(
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    maxT: number,
    out: THREE.Vector3,
  ): ExtraTarget | null;
  strike(
    t: ExtraTarget,
    point: THREE.Vector3,
    push: THREE.Vector3,
    damage: number,
    uppercut: boolean,
  ): void;
  grab(t: ExtraTarget): Holdable | null;
}

interface Target {
  kind: 'piece' | 'debris' | 'npc' | 'vehicle' | 'none';
  piece: number;
  item: DebrisItem | null;
  extra: ExtraTarget | null;
  point: THREE.Vector3;
}

/**
 * Super strength (DESIGN.md §6.1) and ground/dive slams (§6.4): punch combo, uppercut, grab,
 * carry and throw, aimed with the reticle at the centre of the screen.
 */
export class Strength {
  action: HeroAction = 'none';
  /** 0..1 progress of the current action pose. */
  actionT = 0;
  holding: Holdable | null = null;
  /** People and vehicles (set by the game once they exist). */
  extra: ExtraTargets | null = null;
  private actionTime = 0;
  private actionDuration = 0.25;
  private combo = 0;
  private lastPunch = -10;
  private time = 0;
  private pressStart = -1;
  private pendingSlam = false;
  private ray: InstanceType<Physics['R']['Ray']>;
  private target: Target = {
    kind: 'none',
    piece: -1,
    item: null,
    extra: null,
    point: new THREE.Vector3(),
  };
  /** Camera aim (set each rendered frame). */
  readonly aimOrigin = new THREE.Vector3();
  readonly aimDir = new THREE.Vector3(0, 0, -1);
  stats = { punches: 0, uppercuts: 0, grabs: 0, throws: 0, slams: 0 };

  constructor(
    private readonly physics: Physics,
    private readonly destruction: DestructionSystem,
    private readonly player: PlayerController,
    private readonly onSlam: (
      x: number,
      y: number,
      z: number,
      speed: number,
      dive: boolean,
    ) => void,
  ) {
    this.ray = new physics.R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 });
    events.on('player:landing', (e) => {
      const slamSpeed = config.slam.landingSlamSpeed;
      if (this.pendingSlam || (e.hard && (e.dive || e.impactSpeed >= slamSpeed))) {
        this.pendingSlam = false;
        this.setAction('slam', 0.4);
        this.onSlam(e.x, e.y, e.z, e.impactSpeed, true);
      }
    });
  }

  setAim(camera: THREE.Camera) {
    this.aimOrigin.copy(camera.position);
    camera.getWorldDirection(this.aimDir);
  }

  fixedUpdate(input: Input | null, dt: number) {
    this.time += dt;
    if (this.action !== 'none' && this.action !== 'carry' && this.action !== 'uppercutCharge') {
      this.actionTime += dt;
      this.actionT = Math.min(1, this.actionTime / this.actionDuration);
      if (this.actionT >= 1) this.action = this.holding ? 'carry' : 'none';
    }
    this.updateHold(dt);
    if (!input) return;

    const punch = input.action('punch');
    const grab = input.action('grab');
    const slam = input.action('slam');

    if (slam.pressedLatch) this.slam();

    if (grab.pressedLatch) {
      if (this.holding) this.throwHeld();
      else this.tryGrab();
    }

    if (punch.pressedLatch) {
      if (this.holding) this.throwHeld();
      else {
        this.pressStart = this.time;
        this.punch();
      }
    }
    // Hold to wind up an uppercut; release to throw it.
    if (this.pressStart >= 0 && !this.holding) {
      const held = this.time - this.pressStart;
      if (punch.down && held >= config.strength.uppercutHold) {
        this.action = 'uppercutCharge';
        this.actionT = Math.min(1, (held - config.strength.uppercutHold) / 0.3);
      }
      if (punch.releasedLatch || !punch.down) {
        if (held >= config.strength.uppercutHold) this.uppercut();
        this.pressStart = -1;
      }
    }
  }

  private setAction(a: HeroAction, duration: number) {
    this.action = a;
    this.actionTime = 0;
    this.actionT = 0;
    this.actionDuration = duration;
  }

  /** What the reticle is on, if it is within reach of his fists. */
  private findTarget(reachScale = 1): Target {
    const t = this.target;
    t.kind = 'none';
    t.piece = -1;
    t.item = null;
    t.extra = null;
    const p = this.player;
    _chest.set(p.position.x, p.position.y + config.player.height * 0.7, p.position.z);
    const reach = config.strength.reach * reachScale;
    _origin.x = this.aimOrigin.x;
    _origin.y = this.aimOrigin.y;
    _origin.z = this.aimOrigin.z;
    _dir.x = this.aimDir.x;
    _dir.y = this.aimDir.y;
    _dir.z = this.aimDir.z;
    this.ray.origin = _origin;
    this.ray.dir = _dir;
    const maxToi = this.aimOrigin.distanceTo(_chest) + reach + 2;
    const hit = this.physics.world.castRay(
      this.ray,
      maxToi,
      true,
      undefined,
      undefined,
      p.playerCollider,
    );
    // People and vehicles in front of his fists (nearer than whatever the ray hit).
    const ex = this.extra?.find(
      this.aimOrigin,
      this.aimDir,
      hit ? hit.timeOfImpact + 0.3 : maxToi,
      _ex,
    );
    if (ex && _ex.distanceTo(_chest) <= reach) {
      t.kind = ex.kind;
      t.extra = ex;
      t.point.copy(_ex);
      return t;
    }
    if (hit) {
      _hit.copy(this.aimOrigin).addScaledVector(this.aimDir, hit.timeOfImpact);
      if (_hit.distanceTo(_chest) <= reach) {
        const item = this.destruction.debris.itemOfCollider.get(hit.collider.handle);
        if (item) {
          t.kind = 'debris';
          t.item = item;
          t.point.copy(_hit);
          return t;
        }
        // Step a hair inside the surface to find the piece that was hit.
        _tmp.copy(_hit).addScaledVector(this.aimDir, 0.2);
        const id = this.destruction.city.nearestPiece(_tmp.x, _tmp.y, _tmp.z, 1.2);
        if (id >= 0) {
          t.kind = 'piece';
          t.piece = id;
          t.point.copy(_hit);
          return t;
        }
      }
    }
    // Fallback: whatever is right in front of his chest along the aim.
    _tmp.copy(_chest).addScaledVector(this.aimDir, reach * 0.6);
    const id = this.destruction.city.nearestPiece(_tmp.x, _tmp.y, _tmp.z, reach * 0.5);
    if (id >= 0) {
      t.kind = 'piece';
      t.piece = id;
      t.point.copy(_tmp);
    }
    return t;
  }

  private punch() {
    const s = config.strength;
    if (this.time - this.lastPunch < s.punchInterval) return;
    this.combo = this.time - this.lastPunch < s.comboWindow ? (this.combo + 1) % 3 : 0;
    this.lastPunch = this.time;
    const finisher = this.combo === 2;
    this.setAction(
      finisher ? 'finisher' : this.combo === 0 ? 'punchR' : 'punchL',
      finisher ? 0.32 : 0.22,
    );
    this.stats.punches++;
    this.strike(
      finisher ? s.comboFinisherDamage : s.punchDamage,
      s.punchLaunch * (finisher ? 1.6 : 1),
      0,
      false,
    );
  }

  private uppercut() {
    const s = config.strength;
    this.setAction('uppercut', 0.35);
    this.stats.uppercuts++;
    this.strike(s.uppercutDamage, s.punchLaunch, s.uppercutLaunch, true);
  }

  private strike(damage: number, launch: number, lift: number, uppercut: boolean) {
    const t = this.findTarget();
    _d.copy(this.aimDir).multiplyScalar(launch);
    _d.y += lift;
    // Furniture and interior walls in front of his fists (they have no colliders to aim at).
    _tmp.copy(_chest).addScaledVector(this.aimDir, config.strength.reach * 0.6);
    this.destruction.propDamage?.(_tmp.x, _tmp.y, _tmp.z, 1.5, damage * 3, _d.x, _d.y, _d.z);
    if (t.extra) {
      this.extra?.strike(t.extra, t.point, _d, damage, uppercut);
    } else if (t.kind === 'piece') {
      this.destruction.hitAt(t.point.x, t.point.y, t.point.z, 1.3, damage, _d.x, _d.y, _d.z);
    } else if (t.kind === 'debris' && t.item) {
      this.destruction.debris.push(t.item, _d.x, _d.y + (uppercut ? lift * 0.5 : 2), _d.z);
    }
    // Uppercut also sends nearby loose debris skyward.
    if (uppercut) {
      this.destruction.debris.forEachNear(t.point.x, t.point.y, t.point.z, 3, (it) => {
        if (it !== t.item) this.destruction.debris.push(it, _d.x * 0.5, lift, _d.z * 0.5);
      });
    }
    const p = t.kind === 'none' ? _chest.clone().addScaledVector(this.aimDir, 1.5) : t.point;
    events.emit('player:punch', {
      x: p.x,
      y: p.y,
      z: p.z,
      strength: damage,
      target: t.kind,
      uppercut,
    });
    if (t.kind !== 'none') events.emit('camera:shake', { trauma: 0.05 + damage / 1500 });
  }

  private tryGrab() {
    const t = this.findTarget(1.3);
    const s = config.strength;
    let item: Holdable | null = null;
    if (t.extra) {
      const h = this.extra?.grab(t.extra) ?? null;
      if (h && h.mass <= s.maxGrabMass) item = h;
    } else if (t.kind === 'debris' && t.item && t.item.body && t.item.mass <= s.maxGrabMass)
      item = t.item;
    else if (t.kind === 'piece') {
      const st = this.destruction.city.store;
      const kind = st.kind[t.piece]!;
      // Panels and roof gear rip free; structure only once it's been cracked.
      const rippable =
        kind === KIND.panel || kind === KIND.roof || st.state[t.piece]! >= STATE.cracked;
      if (rippable && st.mass[t.piece]! <= s.maxGrabMass) item = this.destruction.ripPiece(t.piece);
    }
    if (!item || !item.body) return;
    this.holding = item;
    item.held = true;
    item.body.setGravityScale(0, true);
    this.setAction('carry', 0.2);
    this.action = 'carry';
    this.stats.grabs++;
    events.emit('player:grab', { mass: item.mass });
  }

  private updateHold(_dt: number) {
    const it = this.holding;
    if (!it) return;
    if (!it.live || !it.body) {
      this.holding = null;
      this.action = 'none';
      return;
    }
    const s = config.strength;
    const p = this.player;
    // Held out in front and above, further out for big objects; it trails and swings (dangles).
    const size = Math.max(it.hx, it.hy, it.hz);
    _tmp.set(this.aimDir.x, 0, this.aimDir.z).normalize();
    _o.set(
      p.position.x + _tmp.x * (s.holdDistance + size),
      p.position.y + config.player.height + s.holdHeight + size * 0.5,
      p.position.z + _tmp.z * (s.holdDistance + size),
    );
    const cur = it.body.translation();
    const k = s.holdFollow;
    it.body.setLinvel(
      {
        x: p.velocity.x + (_o.x - cur.x) * k,
        y: p.velocity.y + (_o.y - cur.y) * k,
        z: p.velocity.z + (_o.z - cur.z) * k,
      },
      true,
    );
    const av = it.body.angvel();
    it.body.setAngvel({ x: av.x * 0.92, y: av.y * 0.92, z: av.z * 0.92 }, true);
    it.sleep = 0;
  }

  private throwHeld() {
    const it = this.holding;
    if (!it || !it.body) return;
    const s = config.strength;
    const p = this.player;
    it.held = false;
    it.body.setGravityScale(1, true);
    it.thrown = s.thrownTime;
    it.body.setLinvel(
      {
        x: p.velocity.x + this.aimDir.x * s.throwSpeed,
        y: p.velocity.y + this.aimDir.y * s.throwSpeed + 2,
        z: p.velocity.z + this.aimDir.z * s.throwSpeed,
      },
      true,
    );
    it.body.setAngvel({ x: 2, y: 4, z: 1 }, true);
    it.body.enableCcd(true);
    this.holding = null;
    this.setAction('throw', 0.3);
    this.stats.throws++;
    events.emit('player:throw', { mass: it.mass, speed: s.throwSpeed });
  }

  private slam() {
    const p = this.player;
    if (p.state === 'grounded') {
      this.setAction('slam', 0.4);
      this.onSlam(p.position.x, p.position.y, p.position.z, 0, false);
    } else {
      // In the air: rocket straight down and slam on impact.
      this.pendingSlam = true;
      p.startSlamDive(config.slam.diveSpeed);
    }
  }

  /** True if a punch or grab would connect right now (reticle feedback). */
  inReach(): boolean {
    if (this.holding) return true;
    return this.findTarget().kind !== 'none';
  }

  /** Counts a slam (called by the game once the slam lands). */
  countSlam() {
    this.stats.slams++;
  }
}
