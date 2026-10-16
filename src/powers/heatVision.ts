import type RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three/webgpu';
import { config } from '../config';
import { events } from '../core/events';
import { cutAxis } from '../core/geom';
import type { Input } from '../core/input';
import { Rng } from '../core/rng';
import type { DestructionSystem } from '../destruction/destruction';
import { FLAG, KIND, MAT, MATERIAL_NAMES, STATE } from '../destruction/pieces';
import { DECAL } from '../fx/decals';
import type { Effects } from '../fx/effects';
import type { FireSystem } from '../fx/fire';
import type { InteriorSystem } from '../interiors/interiorSystem';
import type { Physics } from '../physics/physics';
import type { PlayerController } from '../player/controller';
import { OverheatMeter } from './meters';

type MatName = (typeof MATERIAL_NAMES)[number];

const _hit = new THREE.Vector3();
const _n = new THREE.Vector3();
const _pt = new THREE.Vector3();
const _v = new THREE.Vector3();
const _along = new THREE.Vector3();
const _mid = new THREE.Vector3();
const _origin = { x: 0, y: 0, z: 0 };
const _dir = { x: 0, y: 0, z: 0 };
const _steel: number[] = [];
const _spot: number[] = [];

/** What the beam is hitting: a building piece, something else solid, or nothing (sky). */
export type BeamTarget = 'piece' | 'world' | 'none';

/**
 * Heat vision (DESIGN.md §6.2). Twin beams from the eyes, aimed at the reticle, continuous while
 * held, with an overheat meter. Every step the beam heats and burns the pieces it crosses:
 * glass shatters at once, concrete and brick scorch, glow and burn through, steel glows and loses
 * strength. The beam carries on through burned-through pieces into the building (part of it gets
 * through unbroken ones), so a facade scar also scorches, breaks and ignites the room behind it.
 * Sweeping it slices the pieces it burns through in two, and cut supports feed the structure.
 */
export class HeatVision {
  readonly meter = new OverheatMeter();
  /** Firing this step. */
  firing = false;
  /** 0..1 visual ramp (eyes and beams). */
  ramp = 0;
  /** Where the beam meets the first surface, its normal, what it is. */
  readonly hit = new THREE.Vector3();
  readonly hitNormal = new THREE.Vector3(0, 1, 0);
  target: BeamTarget = 'none';
  /** Material id of the surface under the beam (-1 for non-building surfaces). */
  hitMaterial = -1;
  /** Camera aim (set each rendered frame). */
  readonly aimOrigin = new THREE.Vector3();
  readonly aimDir = new THREE.Vector3(0, 0, -1);
  stats = { fireTime: 0, piecesBurned: 0, piecesCut: 0, ignitions: 0, overheats: 0 };

  private ray: RAPIER.Ray;
  private prevHit = new THREE.Vector3();
  private hasPrev = false;
  /** Smoothed speed of the impact point across surfaces (m/s): sweeping cuts. */
  private readonly sweep = new THREE.Vector3();
  private scarPos = new THREE.Vector3();
  private scarSlot = -1;
  private scarPiece = -2;
  private structureTimer = 0;
  private rng = new Rng(0x4ea7);
  private sparkAcc = 0;
  private dropAcc = 0;
  /** Units set alight recently (so the beam doesn't re-ignite them every step). */
  private ignited = new Map<number, number>();
  private time = 0;
  private wasLocked = false;
  private excludeBuildings: (c: RAPIER.Collider) => boolean;

  constructor(
    private readonly physics: Physics,
    private readonly destruction: DestructionSystem,
    private readonly interiors: InteriorSystem,
    private readonly fire: FireSystem,
    private readonly fx: Effects,
    private readonly player: PlayerController,
  ) {
    this.ray = new physics.R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 });
    // Buildings are traced piece by piece (cityStructure.raycast); the physics ray finds the rest.
    const byCollider = destruction.colliders.buildingOfCollider;
    this.excludeBuildings = (c) => !byCollider.has(c.handle);
  }

  setAim(camera: THREE.Camera) {
    this.aimOrigin.copy(camera.position);
    camera.getWorldDirection(this.aimDir);
  }

  fixedUpdate(input: Input | null, dt: number) {
    const h = config.heatVision;
    this.time += dt;
    const want = !!input?.action('heatVision').down;
    this.firing = this.meter.update(want, dt, h.maxFireTime, h.overheatLockout, h.coolRate);
    if (this.meter.locked && !this.wasLocked) {
      this.stats.overheats++;
      events.emit('power:overheat', {});
    }
    this.wasLocked = this.meter.locked;
    if (!this.firing) {
      this.hasPrev = false;
      this.scarSlot = -1;
      this.target = 'none';
      return;
    }
    this.stats.fireTime += dt;
    this.trace(dt);
    this.structureTimer -= dt;
    if (this.structureTimer <= 0) {
      this.structureTimer = h.structureCheckInterval;
      // Hot steel loses strength: let the structure feel it while the beam is on it.
      for (const b of this.destruction.takeHotSteelBuildings(_steel))
        this.destruction.structure.markDirty(b);
    }
  }

  /** Finds what the beam hits and burns along it. */
  private trace(dt: number) {
    const h = config.heatVision;
    const o = this.aimOrigin;
    const d = this.aimDir;
    _origin.x = o.x;
    _origin.y = o.y;
    _origin.z = o.z;
    _dir.x = d.x;
    _dir.y = d.y;
    _dir.z = d.z;
    this.ray.origin = _origin;
    this.ray.dir = _dir;
    const world = this.physics.world.castRayAndGetNormal(
      this.ray,
      h.range,
      true,
      this.physics.R.QueryFilterFlags.EXCLUDE_SENSORS,
      undefined,
      this.player.playerCollider,
      undefined,
      this.excludeBuildings,
    );
    const worldT = world ? world.timeOfImpact : h.range;
    const hits = this.destruction.city.raycast(o.x, o.y, o.z, d.x, d.y, d.z, worldT);
    const s = this.destruction.city.store;

    if (hits.length > 0) {
      const first = hits[0]!;
      this.target = 'piece';
      this.hitMaterial = s.mat[first.id]!;
      _hit.copy(o).addScaledVector(d, first.t);
      _n.set(0, 0, 0).setComponent(first.axis, first.sign);
    } else if (world) {
      this.target = 'world';
      this.hitMaterial = -1;
      _hit.copy(o).addScaledVector(d, worldT);
      _n.set(world.normal.x, world.normal.y, world.normal.z);
    } else {
      this.target = 'none';
      this.hitMaterial = -1;
      _hit.copy(o).addScaledVector(d, h.range);
      _n.copy(d).negate();
    }
    this.hit.copy(_hit);
    this.hitNormal.copy(_n);

    // How fast the spot is moving across surfaces: a sweep cuts, a dwell melts a hole.
    if (this.hasPrev && this.target !== 'none') {
      _v.copy(_hit).sub(this.prevHit).divideScalar(dt);
      // A jump (to another surface far away) isn't a sweep.
      if (_v.length() > 80) _v.set(0, 0, 0);
      this.sweep.lerp(_v, 0.35);
    } else this.sweep.set(0, 0, 0);
    this.prevHit.copy(_hit);
    this.hasPrev = this.target !== 'none';

    // Burn along the beam: the first surface takes it all; what's behind gets what passes through.
    let power = 1;
    const tFirst = hits.length > 0 ? hits[0]!.t : worldT;
    const reach = tFirst + h.penetration;
    let lastT = tFirst;
    for (let k = 0; k < hits.length && power > 0.04; k++) {
      const hk = hits[k]!;
      if (hk.t > reach) break;
      if (!s.isStatic(hk.id)) continue;
      _pt.copy(o).addScaledVector(d, hk.t);
      this.burn(hk.id, power, dt, k === 0);
      lastT = hk.t;
      this.bore(hk.id, power, dt);
      // A burned-through piece (destroyed, or a panel with a hole) lets the whole beam past.
      const through =
        !s.isStatic(hk.id) || (s.kind[hk.id] === KIND.panel && s.state[hk.id]! >= STATE.breached);
      if (!through) power *= h.transmit;
    }
    if (hits.length > 0)
      this.scorchInside(tFirst, Math.min(reach, Math.max(lastT, tFirst + 4)), dt);

    if (this.target !== 'none') {
      this.scar(hits.length > 0 ? hits[0]!.id : -1);
      this.sparks(dt);
    }
  }

  /** Heat and burn damage on one piece. `power` is the share of the beam reaching it. */
  private burn(id: number, power: number, dt: number, first: boolean) {
    const h = config.heatVision;
    const d = this.destruction;
    const s = d.city.store;
    const name = MATERIAL_NAMES[s.mat[id]!] as MatName;
    d.heatPiece(id, h.heatRate[name] * power * dt);
    const kind = s.kind[id]!;
    // Glass shatters at once and melts at the edges (the frame stays, glowing).
    if (s.mat[id] === MAT.glass) {
      if (kind === KIND.panel) {
        if (s.state[id]! < STATE.breached) {
          d.shatterWindows(s.cx[id]!, s.cy[id]!, s.cz[id]!, 0.2);
          this.stats.piecesBurned++;
        }
      } else d.damagePiece(id, s.hp[id]! + 1, 0, 0, 0, { axis: -1, at: 0 });
      return;
    }
    // Punched windows in concrete and brick blow out the moment the beam touches the panel.
    if (kind === KIND.panel && !(s.flags[id]! & FLAG.windowsBroken) && first) d.breakWindow(id);
    const burnTime = h.burnTime[name];
    const amount = burnTime <= 0 ? s.hp[id]! + 1 : (s.maxHp[id]! / burnTime) * power * dt;
    // Sweeping: slice the piece across the cut plane. Dwelling: melt a hole.
    const sweepSpeed = this.sweep.length();
    let axis = -1;
    let at = 0;
    if (sweepSpeed > h.cutMinSweep) {
      axis = cutAxis(
        this.aimDir.x,
        this.aimDir.y,
        this.aimDir.z,
        this.sweep.x / sweepSpeed,
        this.sweep.y / sweepSpeed,
        this.sweep.z / sweepSpeed,
        s.hx[id]!,
        s.hy[id]!,
        s.hz[id]!,
      );
      at = _pt.getComponent(Math.max(0, axis));
    }
    const destroyed = d.damagePiece(
      id,
      amount,
      this.aimDir.x * 1.5,
      this.aimDir.y * 1.5,
      this.aimDir.z * 1.5,
      { axis, at },
    );
    if (destroyed) {
      this.stats.piecesBurned++;
      if (axis >= 0) this.stats.piecesCut++;
      events.emit('heat:burnThrough', { x: _pt.x, y: _pt.y, z: _pt.z, cut: axis >= 0 });
    }
    // A hot panel sets the room behind it alight (DESIGN.md §6.2: outside and inside).
    if (kind === KIND.panel && s.temperature[id]! >= h.igniteBehindAt) {
      this.igniteUnit(this.interiors.unitBehindPanel(id), 0.35);
    }
  }

  /**
   * The beam bores a channel: everything within boreRadius of where it reaches a piece burns too,
   * falling off from the centre, so it takes big chunks out instead of drilling a pinhole.
   */
  private bore(centreId: number, power: number, dt: number) {
    const h = config.heatVision;
    const d = this.destruction;
    const s = d.city.store;
    const r = Math.max(0.05, h.boreRadius);
    _spot.length = 0;
    d.city.forEachPieceInSphere(_pt.x, _pt.y, _pt.z, r, (id) => {
      if (id !== centreId) _spot.push(id);
    });
    for (const id of _spot) {
      if (!s.isStatic(id)) continue;
      const k = 1 - Math.sqrt(s.distSq(id, _pt.x, _pt.y, _pt.z)) / r;
      if (k > 0) this.burn(id, power * h.boreShare * k, dt, false);
    }
  }

  /** Furniture and drywall along the beam inside the building scorch, break and catch fire. */
  private scorchInside(t0: number, t1: number, dt: number) {
    const h = config.heatVision;
    const o = this.aimOrigin;
    const d = this.aimDir;
    const n = Math.min(12, Math.ceil((t1 - t0) / 2));
    for (let i = 0; i <= n; i++) {
      const t = t0 + 0.8 + ((t1 - t0) * i) / Math.max(1, n);
      _v.copy(o).addScaledVector(d, t);
      this.destruction.propDamage?.(
        _v.x,
        _v.y,
        _v.z,
        0.7,
        h.propDamage * dt,
        d.x * 2,
        d.y * 2 + 1,
        d.z * 2,
      );
      // Only where the beam is getting through: the facade there is open.
      if (i > 0) this.igniteUnit(this.interiors.unitAt(_v.x, _v.y, _v.z), 0.25);
    }
  }

  private igniteUnit(u: number, amount: number) {
    if (u < 0 || this.fire.burning.has(u)) return;
    const last = this.ignited.get(u);
    if (last !== undefined && this.time - last < 1.5) return;
    this.ignited.set(u, this.time);
    if (this.ignited.size > 256) this.ignited.clear();
    if (this.fire.ignite(u, amount)) this.stats.ignitions++;
  }

  /** The glowing scar line: a new segment every scarSpacing metres, the newest kept white hot. */
  private scar(piece: number) {
    const h = config.heatVision;
    const decals = this.fx.decals;
    const dist = this.scarSlot >= 0 ? _hit.distanceTo(this.scarPos) : Infinity;
    if (this.scarSlot >= 0 && piece === this.scarPiece && dist < h.scarSpacing) {
      decals.renew(this.scarSlot);
      return;
    }
    const joined = this.scarSlot >= 0 && dist < h.scarSpacing * 6;
    if (joined) {
      _mid.copy(_hit).add(this.scarPos).multiplyScalar(0.5);
      _along.copy(_hit).sub(this.scarPos);
    } else {
      _mid.copy(_hit);
      _along.set(this.sweep.x, this.sweep.y, this.sweep.z);
      if (_along.lengthSq() < 1e-6) _along.set(1, 0, 0);
    }
    const len = (joined ? dist : 0) + h.scarWidth;
    this.scarSlot = decals.add(
      DECAL.scar,
      _mid,
      this.hitNormal,
      _along,
      len,
      h.scarWidth * this.rng.range(0.85, 1.15),
      piece,
      this.rng.next(),
    );
    this.scarPos.copy(_hit);
    this.scarPiece = piece;
  }

  /** Sparks spray off the impact and molten droplets fall from it. */
  private sparks(dt: number) {
    const h = config.heatVision;
    const n = this.hitNormal;
    this.sparkAcc += h.sparkRate * dt;
    this.dropAcc += h.dropletRate * dt;
    while (this.sparkAcc >= 1) {
      this.sparkAcc--;
      const sp = this.rng.range(4, 13);
      this.fx.sparks.spawn(
        _hit.x + n.x * 0.05,
        _hit.y + n.y * 0.05,
        _hit.z + n.z * 0.05,
        n.x * sp + this.rng.range(-5, 5),
        n.y * sp + this.rng.range(-2, 6),
        n.z * sp + this.rng.range(-5, 5),
        this.rng.range(0.05, 0.11),
        -0.05,
      );
    }
    while (this.dropAcc >= 1) {
      this.dropAcc--;
      this.fx.droplets.spawn(
        _hit.x + n.x * 0.08 + this.rng.range(-0.15, 0.15),
        _hit.y + n.y * 0.08 - 0.05,
        _hit.z + n.z * 0.08 + this.rng.range(-0.15, 0.15),
        n.x * this.rng.range(0.5, 2.5),
        this.rng.range(-0.5, 1),
        n.z * this.rng.range(0.5, 2.5),
        this.rng.range(0.09, 0.16),
        -0.04,
      );
    }
  }

  /** Per rendered frame: eyes and beams ramp on and off. */
  frameUpdate(dt: number) {
    const target = this.firing ? 1 : 0;
    const rate = this.firing ? 14 : 8;
    this.ramp += (target - this.ramp) * (1 - Math.exp(-rate * dt));
    if (this.ramp < 0.002) this.ramp = 0;
  }
}
