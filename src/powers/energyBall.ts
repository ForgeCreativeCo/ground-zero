import type RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three/webgpu';
import { config } from '../config';
import { events } from '../core/events';
import type { Input } from '../core/input';
import { Rng } from '../core/rng';
import type { DestructionSystem } from '../destruction/destruction';
import type { FireSystem } from '../fx/fire';
import type { InteriorSystem } from '../interiors/interiorSystem';
import type { Physics } from '../physics/physics';
import type { PlayerController } from '../player/controller';

/** A ball in flight. */
export interface Projectile {
  live: boolean;
  pos: THREE.Vector3;
  prev: THREE.Vector3;
  vel: THREE.Vector3;
  charge: number;
  travelled: number;
}

/** A blast front expanding through the pieces it caught (frame-spread). */
interface Blast {
  x: number;
  y: number;
  z: number;
  radius: number;
  damage: number;
  launch: number;
  front: number;
  ids: number[];
  dist: Float32Array;
  next: number;
}

const _dir = new THREE.Vector3();
const _p = new THREE.Vector3();
const _v = new THREE.Vector3();
const _origin = { x: 0, y: 0, z: 0 };
const _rdir = { x: 0, y: 0, z: 0 };
const _ids: number[] = [];
const MAX_BALLS = 4;

/**
 * Energy ball (added at the user's request after M4; not in DESIGN.md). Hold to charge a ball of
 * energy in his hands, release to throw it at the reticle. It bursts on the first thing it hits:
 * inside the core of the blast every piece is blown apart, further out pieces take falling-off
 * damage, windows shatter, furniture is flung and rooms catch fire. A full charge takes a section
 * out of a building, and the structural system does the rest. The blast front expands over a few
 * frames, so even a full charge doesn't stall one.
 */
export class EnergyBall {
  charging = false;
  /** Current charge 0..1 (while charging). */
  charge = 0;
  readonly balls: Projectile[] = [];
  /** Where the ball sits while charging (set each frame from the hero's hands). */
  readonly hand = new THREE.Vector3();
  readonly aimOrigin = new THREE.Vector3();
  readonly aimDir = new THREE.Vector3(0, 0, -1);
  stats = { throws: 0, blasts: 0, piecesDestroyed: 0, lastRadius: 0 };

  private cooldown = 0;
  private blasts: Blast[] = [];
  private ray: RAPIER.Ray;
  private rng = new Rng(0xba11);
  private excludeBuildings: (c: RAPIER.Collider) => boolean;

  constructor(
    private readonly physics: Physics,
    private readonly destruction: DestructionSystem,
    private readonly interiors: InteriorSystem,
    private readonly fire: FireSystem,
    private readonly player: PlayerController,
  ) {
    this.ray = new physics.R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 });
    const byCollider = destruction.colliders.buildingOfCollider;
    // Buildings are traced piece by piece; debris doesn't stop the ball (it ploughs through).
    this.excludeBuildings = (c) =>
      !byCollider.has(c.handle) && !destruction.debris.itemOfCollider.has(c.handle);
    for (let i = 0; i < MAX_BALLS; i++) {
      this.balls.push({
        live: false,
        pos: new THREE.Vector3(),
        prev: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        charge: 0,
        travelled: 0,
      });
    }
  }

  setAim(camera: THREE.Camera) {
    this.aimOrigin.copy(camera.position);
    camera.getWorldDirection(this.aimDir);
  }

  /** Ball radius for a charge (m). */
  static radius(charge: number) {
    const e = config.energyBall;
    return e.radiusMin + (e.radiusMax - e.radiusMin) * charge;
  }

  fixedUpdate(input: Input | null, dt: number) {
    const e = config.energyBall;
    this.cooldown -= dt;
    const btn = input?.action('energyBall');
    if (btn?.down && !this.charging && this.cooldown <= 0) {
      this.charging = true;
      this.charge = 0;
    }
    if (this.charging) {
      this.charge = Math.min(1, this.charge + dt / Math.max(0.05, e.chargeTime));
      if (!btn?.down) this.throwBall();
    }
    for (const b of this.balls) if (b.live) this.fly(b, dt);
    for (let i = this.blasts.length - 1; i >= 0; i--) {
      if (this.advance(this.blasts[i]!, dt)) this.blasts.splice(i, 1);
    }
  }

  private throwBall() {
    const e = config.energyBall;
    const c = Math.max(e.minCharge, this.charge);
    this.charging = false;
    this.charge = 0;
    this.cooldown = e.cooldown;
    const b = this.balls.find((q) => !q.live);
    if (!b) return;
    // Toward whatever the reticle is on.
    const t = this.aimDistance(e.range);
    _p.copy(this.aimOrigin).addScaledVector(this.aimDir, t);
    _dir.copy(_p).sub(this.hand);
    if (_dir.lengthSq() < 1) _dir.copy(this.aimDir);
    _dir.normalize();
    b.live = true;
    b.charge = c;
    b.travelled = 0;
    b.pos.copy(this.hand);
    b.prev.copy(this.hand);
    b.vel.copy(_dir).multiplyScalar(e.speed);
    // He's moving too: the ball keeps his momentum.
    b.vel.x += this.player.velocity.x;
    b.vel.y += this.player.velocity.y;
    b.vel.z += this.player.velocity.z;
    this.stats.throws++;
    events.emit('power:energyThrow', { charge: c });
  }

  /** Distance along the aim to the first surface (or maxT). */
  private aimDistance(maxT: number) {
    const o = this.aimOrigin;
    const d = this.aimDir;
    const hits = this.destruction.city.raycast(o.x, o.y, o.z, d.x, d.y, d.z, maxT);
    let t = hits.length > 0 ? hits[0]!.t : maxT;
    const wt = this.worldHit(o, d, t);
    if (wt >= 0) t = Math.min(t, wt);
    return t;
  }

  private worldHit(o: THREE.Vector3, d: THREE.Vector3, maxT: number) {
    _origin.x = o.x;
    _origin.y = o.y;
    _origin.z = o.z;
    _rdir.x = d.x;
    _rdir.y = d.y;
    _rdir.z = d.z;
    this.ray.origin = _origin;
    this.ray.dir = _rdir;
    const hit = this.physics.world.castRay(
      this.ray,
      maxT,
      true,
      this.physics.R.QueryFilterFlags.EXCLUDE_SENSORS,
      undefined,
      this.player.playerCollider,
      undefined,
      this.excludeBuildings,
    );
    return hit ? hit.timeOfImpact : -1;
  }

  private fly(b: Projectile, dt: number) {
    const e = config.energyBall;
    b.prev.copy(b.pos);
    const len = b.vel.length() * dt;
    if (len < 1e-6) return;
    _dir.copy(b.vel).normalize();
    // The ball's surface touches first: trace its leading point.
    const r = EnergyBall.radius(b.charge) * 0.5;
    _p.copy(b.pos);
    const hits = this.destruction.city.raycast(_p.x, _p.y, _p.z, _dir.x, _dir.y, _dir.z, len + r);
    let t = hits.length > 0 ? hits[0]!.t : Infinity;
    const wt = this.worldHit(_p, _dir, len + r);
    if (wt >= 0) t = Math.min(t, wt);
    if (t <= len + r) {
      _p.addScaledVector(_dir, Math.max(0, t - 0.2));
      b.pos.copy(_p);
      this.explode(b, _p.x, _p.y, _p.z);
      return;
    }
    b.pos.addScaledVector(_dir, len);
    b.travelled += len;
    if (b.travelled > e.range) this.explode(b, b.pos.x, b.pos.y, b.pos.z);
  }

  /** Bursts a ball: starts the blast front and the instant effects. */
  explode(b: Projectile, x: number, y: number, z: number) {
    const e = config.energyBall;
    b.live = false;
    const c = b.charge;
    const radius = e.blastRadiusMin + (e.blastRadiusMax - e.blastRadiusMin) * c;
    const damage = e.damage * Math.pow(c, 1.5);
    const launch = e.launch * (0.4 + 0.6 * c);
    const d = this.destruction;
    const s = d.city.store;
    _ids.length = 0;
    d.city.forEachPieceInSphere(x, y, z, radius, (id) => _ids.push(id));
    const dist = new Float32Array(_ids.length);
    const order = _ids.map((_, i) => i);
    _ids.forEach((id, i) => (dist[i] = Math.sqrt(s.distSq(id, x, y, z))));
    order.sort((a, q) => dist[a]! - dist[q]!);
    const blast: Blast = {
      x,
      y,
      z,
      radius,
      damage,
      launch,
      front: 0,
      ids: order.map((i) => _ids[i]!),
      dist: Float32Array.from(order.map((i) => dist[i]!)),
      next: 0,
    };
    this.blasts.push(blast);

    // Furniture and interior walls are flung, loose debris is thrown clear, windows blow out.
    d.propDamage?.(x, y, z, radius, damage * 0.5 + 400, 0, launch * 0.4, 0);
    d.debris.forEachNear(x, y, z, radius * 1.5, (it) => {
      _v.set(it.pos.x - x, Math.max(0.5, it.pos.y - y), it.pos.z - z);
      const k = Math.max(0, 1 - _v.length() / (radius * 1.5));
      _v.normalize().multiplyScalar(launch * k);
      d.debris.push(it, _v.x, _v.y + launch * k * 0.4, _v.z);
    });
    d.shatterWindows(x, y, z, radius * e.windowRadiusScale);
    // Rooms in the blast catch fire.
    for (let i = 0; i < 10; i++) {
      if (this.rng.next() > e.ignition) continue;
      const u = this.interiors.unitAt(
        x + this.rng.range(-radius, radius) * 0.7,
        y + this.rng.range(-radius, radius) * 0.5,
        z + this.rng.range(-radius, radius) * 0.7,
      );
      if (u >= 0) this.fire.ignite(u, 0.5);
    }
    this.stats.blasts++;
    this.stats.lastRadius = radius;
    events.emit('power:energyBlast', { x, y, z, radius, charge: c });
    events.emit('camera:shake', { trauma: 0.25 + 0.6 * c });
  }

  /** Moves a blast front outward; returns true once it has passed every piece it caught. */
  private advance(bl: Blast, dt: number) {
    const e = config.energyBall;
    const d = this.destruction;
    const s = d.city.store;
    bl.front += e.waveSpeed * dt;
    const core = bl.radius * e.coreFraction;
    while (bl.next < bl.ids.length && bl.dist[bl.next]! <= bl.front) {
      const id = bl.ids[bl.next]!;
      const dist = bl.dist[bl.next]!;
      bl.next++;
      if (!s.isStatic(id)) continue;
      _v.set(s.cx[id]! - bl.x, s.cy[id]! - bl.y, s.cz[id]! - bl.z);
      if (_v.lengthSq() < 1e-6) _v.set(0, 1, 0);
      const k = Math.max(0, 1 - dist / bl.radius);
      _v.normalize().multiplyScalar(bl.launch * (0.3 + 0.7 * k));
      _v.y += bl.launch * 0.25 * k;
      if (dist <= core && bl.damage > 0) {
        // The core: blown apart outright.
        d.destroyPiece(id, _v.x, _v.y, _v.z, true, e.fragmentShare);
        this.stats.piecesDestroyed++;
      } else {
        const f = core < bl.radius ? 1 - (dist - core) / (bl.radius - core) : 0;
        if (d.damagePiece(id, bl.damage * f * f, _v.x * 0.6, _v.y * 0.6, _v.z * 0.6))
          this.stats.piecesDestroyed++;
      }
    }
    return bl.next >= bl.ids.length;
  }
}
