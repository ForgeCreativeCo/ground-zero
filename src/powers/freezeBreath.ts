import type RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three/webgpu';
import { config } from '../config';
import { inCone } from '../core/geom';
import type { Input } from '../core/input';
import { Rng } from '../core/rng';
import type { DestructionSystem } from '../destruction/destruction';
import { DECAL } from '../fx/decals';
import type { Effects } from '../fx/effects';
import type { FireSystem } from '../fx/fire';
import type { Physics } from '../physics/physics';
import type { PlayerController } from '../player/controller';
import { BreathMeter } from './meters';

const _axis = new THREE.Vector3();
const _end = new THREE.Vector3();
const _n = new THREE.Vector3();
const _p = new THREE.Vector3();
const _along = new THREE.Vector3();
const _origin = { x: 0, y: 0, z: 0 };
const _dir = { x: 0, y: 0, z: 0 };
const _found: number[] = [];

/**
 * Freeze breath (DESIGN.md §6.3): a cone of freezing breath from the mouth toward the reticle,
 * with a breath meter. Facade pieces in the cone frost over and take double blunt damage while
 * frozen; hot pieces cool; fires in the cone go out; surfaces it reaches get frost patches.
 * Frozen things thaw after config.freezeBreath.thawTime (destruction.ts counts it down).
 * People and vehicles freezing solid arrive with them (M5).
 */
export class FreezeBreath {
  readonly meter = new BreathMeter();
  firing = false;
  ramp = 0;
  /** Camera aim (set each rendered frame) and the hero's mouth (from the model). */
  readonly aimOrigin = new THREE.Vector3();
  readonly aimDir = new THREE.Vector3(0, 0, -1);
  readonly mouth = new THREE.Vector3();
  /** Where the cone's axis meets a surface this step (if it does). */
  readonly end = new THREE.Vector3();
  stats = { breathTime: 0, piecesFrozen: 0, firesOut: 0 };

  private ray: RAPIER.Ray;
  private rng = new Rng(0xf2ee);
  private decalTimer = 0;
  private mistAcc = 0;
  private stamp = new Set<number>();
  private excludeBuildings: (c: RAPIER.Collider) => boolean;

  constructor(
    private readonly physics: Physics,
    private readonly destruction: DestructionSystem,
    private readonly fire: FireSystem,
    private readonly fx: Effects,
    private readonly player: PlayerController,
  ) {
    this.ray = new physics.R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 });
    const byCollider = destruction.colliders.buildingOfCollider;
    this.excludeBuildings = (c) => !byCollider.has(c.handle);
  }

  setAim(camera: THREE.Camera) {
    this.aimOrigin.copy(camera.position);
    camera.getWorldDirection(this.aimDir);
  }

  fixedUpdate(input: Input | null, dt: number) {
    const c = config.freezeBreath;
    const want = !!input?.action('freezeBreath').down;
    this.firing = this.meter.update(want, dt, c.maxBreathTime, c.refillRate, c.restartAt);
    if (!this.firing) return;
    this.stats.breathTime += dt;

    // Aim: from the mouth toward whatever the reticle is on.
    const target = this.aimTarget(c.range * 3);
    _axis.copy(target).sub(this.mouth);
    if (_axis.lengthSq() < 1e-4) _axis.copy(this.aimDir);
    _axis.normalize();

    // The cone stops a little past the first surface it reaches (breath doesn't go through walls).
    const m = this.mouth;
    const s = this.destruction.city.store;
    const hits = this.destruction.city.raycast(m.x, m.y, m.z, _axis.x, _axis.y, _axis.z, c.range);
    let length = c.range;
    let surface = false;
    let piece = -1;
    if (hits.length > 0) {
      length = Math.min(c.range, hits[0]!.t + 1.5);
      _end.copy(m).addScaledVector(_axis, hits[0]!.t);
      _n.set(0, 0, 0).setComponent(hits[0]!.axis, hits[0]!.sign);
      surface = true;
      piece = hits[0]!.id;
    }
    // The ground (and anything else that isn't a building).
    const wt = this.worldHit(m, _axis, c.range);
    if (wt >= 0 && (!surface || wt < hits[0]!.t)) {
      length = Math.min(length, wt + 1);
      _end.copy(m).addScaledVector(_axis, wt);
      _n.copy(_p);
      surface = true;
      piece = -1;
    }
    this.end.copy(surface ? _end : _p.copy(m).addScaledVector(_axis, length));

    // Freeze every piece in the cone.
    const cosHalf = Math.cos((c.coneAngleDeg * Math.PI) / 180);
    const tanHalf = Math.tan((c.coneAngleDeg * Math.PI) / 180);
    this.stamp.clear();
    _found.length = 0;
    for (let dist = 1.5; dist <= length + 0.01; dist += 3) {
      const r = dist * tanHalf + 1;
      _p.copy(m).addScaledVector(_axis, dist);
      this.destruction.city.forEachPieceInSphere(_p.x, _p.y, _p.z, r, (id) => {
        if (this.stamp.has(id)) return;
        this.stamp.add(id);
        // Nearest point of the piece's box to the axis point beside its centre.
        const along =
          (s.cx[id]! - m.x) * _axis.x + (s.cy[id]! - m.y) * _axis.y + (s.cz[id]! - m.z) * _axis.z;
        const ax = m.x + _axis.x * along;
        const ay = m.y + _axis.y * along;
        const az = m.z + _axis.z * along;
        const qx = Math.max(s.cx[id]! - s.hx[id]!, Math.min(s.cx[id]! + s.hx[id]!, ax));
        const qy = Math.max(s.cy[id]! - s.hy[id]!, Math.min(s.cy[id]! + s.hy[id]!, ay));
        const qz = Math.max(s.cz[id]! - s.hz[id]!, Math.min(s.cz[id]! + s.hz[id]!, az));
        if (inCone(m.x, m.y, m.z, _axis.x, _axis.y, _axis.z, cosHalf, length, qx, qy, qz))
          _found.push(id);
      });
    }
    const amount = (dt * c.thawTime) / Math.max(0.01, c.freezeTime);
    for (const id of _found) {
      if (s.frozen[id]! <= 0) this.stats.piecesFrozen++;
      this.destruction.freezePiece(id, amount, c.coolRate * dt);
    }

    // Fires in the cone go out.
    const before = this.fire.burningCount;
    for (let k = 1; k <= 3; k++) {
      const dist = (length * k) / 3;
      _p.copy(m).addScaledVector(_axis, dist);
      this.fire.extinguish(_p.x, _p.y, _p.z, dist * tanHalf + 1.5);
    }
    this.stats.firesOut += Math.max(0, before - this.fire.burningCount);

    // Frost patches where the breath lands.
    this.decalTimer -= dt;
    if (surface && this.decalTimer <= 0) {
      this.decalTimer = c.frostDecalInterval;
      const spread = Math.min(length, m.distanceTo(_end)) * tanHalf * 0.8;
      _p.copy(_end);
      _along.set(this.rng.range(-1, 1), this.rng.range(-1, 1), this.rng.range(-1, 1));
      _p.addScaledVector(_along, spread);
      // Back onto the surface plane.
      _p.addScaledVector(_n, -_along.dot(_n) * spread);
      const size = c.frostDecalSize * this.rng.range(0.7, 1.3);
      this.fx.decals.add(DECAL.frost, _p, _n, _along, size, size, piece, this.rng.next());
    }

    // Mist pouring out along the cone.
    this.mistAcc += c.mistRate * dt;
    while (this.mistAcc >= 1) {
      this.mistAcc--;
      const sp = c.mistSpeed * this.rng.range(0.7, 1.1);
      const sx = this.rng.range(-1, 1) * tanHalf;
      const sy = this.rng.range(-1, 1) * tanHalf;
      const sz = this.rng.range(-1, 1) * tanHalf;
      this.fx.frostMist.spawn(
        m.x + _axis.x * 0.25,
        m.y + _axis.y * 0.25,
        m.z + _axis.z * 0.25,
        (_axis.x + sx) * sp,
        (_axis.y + sy) * sp,
        (_axis.z + sz) * sp,
        this.rng.range(0.15, 0.3),
        Math.min(3, length * tanHalf * 1.6),
      );
    }
  }

  /** The point under the reticle (or far along the aim). */
  private aimTarget(maxT: number) {
    const o = this.aimOrigin;
    const d = this.aimDir;
    const hits = this.destruction.city.raycast(o.x, o.y, o.z, d.x, d.y, d.z, maxT);
    let t = hits.length > 0 ? hits[0]!.t : maxT;
    const wt = this.worldHit(o, d, t);
    if (wt >= 0) t = Math.min(t, wt);
    return _end.copy(o).addScaledVector(d, t);
  }

  /** Distance to the first non-building surface along a ray (-1 if none); its normal in _p. */
  private worldHit(o: THREE.Vector3, d: THREE.Vector3, maxT: number) {
    _origin.x = o.x;
    _origin.y = o.y;
    _origin.z = o.z;
    _dir.x = d.x;
    _dir.y = d.y;
    _dir.z = d.z;
    this.ray.origin = _origin;
    this.ray.dir = _dir;
    const hit = this.physics.world.castRayAndGetNormal(
      this.ray,
      maxT,
      true,
      this.physics.R.QueryFilterFlags.EXCLUDE_SENSORS,
      undefined,
      this.player.playerCollider,
      undefined,
      this.excludeBuildings,
    );
    if (!hit) return -1;
    _p.set(hit.normal.x, hit.normal.y, hit.normal.z);
    return hit.timeOfImpact;
  }

  frameUpdate(dt: number) {
    const target = this.firing ? 1 : 0;
    this.ramp += (target - this.ramp) * (1 - Math.exp(-10 * dt));
    if (this.ramp < 0.002) this.ramp = 0;
  }
}
