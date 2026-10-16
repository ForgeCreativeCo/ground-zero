import * as THREE from 'three/webgpu';
import { config } from '../config';
import { events } from '../core/events';
import { Rng } from '../core/rng';
import type { Effects } from '../fx/effects';
import type { Physics } from '../physics/physics';
import { batchGeometry, pieceMaterial } from '../render/pieceMaterials';
import { PieceRenderer } from '../render/pieceRenderer';
import type { CityLayout } from '../world/cityLayout';
import { BuildingColliders } from './buildingColliders';
import type { BuildingModel } from './buildingModel';
import { CityStructure } from './cityStructure';
import { StructuralSystem } from './collapse';
import { DebrisSystem, type DebrisItem } from './debris';
import { FLAG, KIND, MAT, MATERIAL_NAMES, STATE, stateForHp } from './pieces';

const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _e = new THREE.Euler();

type MatConfig = { hp: number; density: number; value: number; dust: string; fragments: number };

/**
 * Heat damage (heat vision): burned-through pieces melt instead of shattering, or, when the beam
 * was sweeping, are sliced in two along `axis` (0/1/2, -1 = no cut) at world coordinate `at`.
 */
export interface BurnInfo {
  axis: number;
  at: number;
}

/**
 * The destruction system (DESIGN.md §7): owns the city's pieces and everything that happens to
 * them — damage and state changes, fracture into debris, revealing interiors, colliders, the
 * structural checks that make things fall, and the property-damage bill.
 */
export class DestructionSystem {
  readonly city: CityStructure;
  readonly renderer: PieceRenderer;
  readonly colliders: BuildingColliders;
  readonly debris: DebrisSystem;
  readonly structure: StructuralSystem;
  /** Interior props within r of a point take damage too (set by the interior system). */
  propDamage:
    | ((
        x: number,
        y: number,
        z: number,
        r: number,
        dmg: number,
        px: number,
        py: number,
        pz: number,
      ) => void)
    | null = null;
  /** Running property damage in dollars (HUD damage bill; feeds the Nova meter later). */
  bill = 0;
  piecesDestroyed = 0;
  private rng = new Rng(0xd357);
  private stepDt = 1 / 60;

  constructor(
    scene: THREE.Scene,
    physics: Physics,
    layout: CityLayout,
    seed: number,
    private readonly fx: Effects,
  ) {
    this.city = new CityStructure(layout, config.construction, config.materials, seed);
    this.renderer = new PieceRenderer(scene, this.city, seed);
    this.colliders = new BuildingColliders(physics, this.city);
    this.debris = new DebrisSystem(
      scene,
      physics,
      Math.max(layout.halfExtentX, layout.halfExtentZ) + 150,
    );
    this.structure = new StructuralSystem(scene, physics, this.city, this.renderer, this.debris, {
      crushStatic: (id) => this.crushStatic(id),
      crushFx: (x, y, z, mass, nearGround) => this.crushFx(x, y, z, mass, nearGround),
      bill: (id) => this.addBill(id),
      dropPiece: (id) => this.dropPiece(id),
      rebuildNow: (b) => this.colliders.rebuild(b),
      stressFx: (x, y, z, k) => this.stressFx(x, y, z, k),
    });
    physics.onContactForce = (h1, h2) => this.onContactForce(h1, h2);
    this.colliders.onRebuilt = (b, boxes) => this.renderer.proxies.setShadowBoxes(b, boxes);
    this.debris.floorQuery = (x, y, z, out) => this.floorUnder(x, y, z, out);
    this.debris.slabStanding = (id) => this.city.store.isStatic(id);
  }

  /** First touch: swap the building from its proxy to real pieces and build its real colliders. */
  activate(building: number) {
    if (this.renderer.active[building]) return;
    this.renderer.activate(building);
    this.colliders.markDirty(building);
  }

  private mat(id: number): MatConfig {
    const name = MATERIAL_NAMES[this.city.store.mat[id]!]!;
    return (config.materials as Record<string, MatConfig>)[name]!;
  }

  // --- damage -----------------------------------------------------------------------------------

  /**
   * Applies damage to a piece. (px, py, pz) is the push given to anything knocked loose (m/s).
   * Returns true if the piece was destroyed.
   */
  damagePiece(id: number, amount: number, px = 0, py = 0, pz = 0, burn?: BurnInfo): boolean {
    const s = this.city.store;
    if (!s.isStatic(id) || amount <= 0) return false;
    this.activate(s.building[id]!);
    // Frozen pieces are brittle: blunt damage counts double (DESIGN.md §6.3).
    if (s.frozen[id]! > 0 && !burn) amount *= 2;
    const before = s.state[id]!;
    if (amount >= s.maxHp[id]! * config.damage.overkill) s.hp[id] = 0;
    else s.hp[id] = Math.max(0, s.hp[id]! - amount);
    const next = stateForHp(s.hp[id]! / s.maxHp[id]!, s.kind[id]!, config.damage);
    if (next === STATE.destroyed) {
      if (burn && burn.axis >= 0) this.slicePiece(id, burn.axis, burn.at, px, py, pz);
      else if (burn) this.destroyPiece(id, px, py, pz, true, 0.8);
      else this.destroyPiece(id, px, py, pz);
      return true;
    }
    if (next !== before) {
      s.state[id] = next;
      this.reveal(id);
      this.renderer.refresh(id);
      if (next === STATE.breached) {
        // The hole: a few fragments fall out, and the building now has a gap to fly through.
        this.spawnFragments(id, px, py, pz, 0.45);
        this.colliders.markDirty(s.building[id]!);
        if (s.mat[id] === MAT.glass) this.glassFx(id, 10);
      }
      events.emit('piece:damaged', {
        id,
        x: s.cx[id]!,
        y: s.cy[id]!,
        z: s.cz[id]!,
        state: next,
        material: s.mat[id]!,
      });
    } else {
      this.renderer.refresh(id);
    }
    return false;
  }

  /** Destroys a piece: it breaks into debris thrown by the push, and support is re-checked. */
  destroyPiece(id: number, px = 0, py = 0, pz = 0, fragments = true, fragmentShare = 1) {
    const s = this.city.store;
    if (!s.isStatic(id)) return;
    this.activate(s.building[id]!);
    s.state[id] = STATE.destroyed;
    s.hp[id] = 0;
    this.renderer.hide(id);
    this.reveal(id);
    if (fragments) this.spawnFragments(id, px, py, pz, fragmentShare);
    if (s.mat[id] === MAT.glass) this.glassFx(id, 18);
    else
      this.fx.dust.ring(
        s.cx[id]!,
        s.cy[id]! - s.hy[id]!,
        s.cz[id]!,
        Math.max(s.hx[id]!, s.hz[id]!),
        4,
        3,
      );
    this.afterRemoval(id);
    events.emit('piece:destroyed', {
      id,
      x: s.cx[id]!,
      y: s.cy[id]!,
      z: s.cz[id]!,
      material: s.mat[id]!,
      mass: s.mass[id]!,
    });
  }

  /**
   * Heat vision cut (DESIGN.md §6.2): the piece splits in two along `axis` at world coordinate
   * `at`, leaving a kerf between the halves, which come loose as debris. Support is re-checked,
   * so cutting columns feeds the structural system.
   */
  slicePiece(id: number, axis: number, at: number, px = 0, py = 0, pz = 0) {
    const s = this.city.store;
    if (!s.isStatic(id)) return;
    this.activate(s.building[id]!);
    s.state[id] = STATE.destroyed;
    s.hp[id] = 0;
    this.renderer.hide(id);
    this.reveal(id);
    const c = [s.cx[id]!, s.cy[id]!, s.cz[id]!];
    const h = [s.hx[id]!, s.hy[id]!, s.hz[id]!];
    const kerf = config.heatVision.cutKerf / 2;
    const lo = c[axis]! - h[axis]!;
    const hi = c[axis]! + h[axis]!;
    const cut = Math.max(lo + kerf + 0.05, Math.min(hi - kerf - 0.05, at));
    const visual = this.renderer.visualFor(id, true);
    const density = this.mat(id).density;
    for (const [a, b] of [
      [lo, cut - kerf],
      [cut + kerf, hi],
    ] as const) {
      if (b - a < 0.04) continue;
      const cc = [c[0]!, c[1]!, c[2]!];
      const hh = [h[0]!, h[1]!, h[2]!];
      cc[axis] = (a + b) / 2;
      hh[axis] = (b - a) / 2;
      // The halves part along the cut, a little each way, and slump.
      const sep = cc[axis]! < cut ? -0.6 : 0.6;
      this.debris.spawn(
        visual,
        cc[0]!,
        cc[1]!,
        cc[2]!,
        hh[0]!,
        hh[1]!,
        hh[2]!,
        _q.identity(),
        px + (axis === 0 ? sep : 0),
        py + (axis === 1 ? sep * 0.5 : 0),
        pz + (axis === 2 ? sep : 0),
        density,
        true,
      );
    }
    this.afterRemoval(id);
    events.emit('piece:destroyed', {
      id,
      x: s.cx[id]!,
      y: s.cy[id]!,
      z: s.cz[id]!,
      material: s.mat[id]!,
      mass: s.mass[id]!,
    });
  }

  // --- heat and cold (DESIGN.md §6.2, §6.3) ---------------------------------------------------

  /** Pieces above ambient temperature; they cool and stop glowing over time. */
  readonly hot = new Set<number>();
  /** Frozen pieces counting down to thaw. */
  readonly frozenSet = new Set<number>();
  private heatRefresh = 0;
  private hotBuildings = new Set<number>();

  /** Raises a piece's temperature (thawing it first). Hot steel loses strength (collapse.ts). */
  heatPiece(id: number, deg: number) {
    const s = this.city.store;
    if (!s.isStatic(id) || deg <= 0) return;
    this.activate(s.building[id]!);
    if (s.frozen[id]! > 0) {
      s.frozen[id] = 0;
      this.frozenSet.delete(id);
    }
    const t = Math.min(config.heatVision.maxTemperature, s.temperature[id]! + deg);
    s.temperature[id] = t;
    // Heat scorches: concrete and brick blacken where the beam has been.
    s.soot[id] = Math.max(s.soot[id]!, Math.min(0.9, t / 1500));
    this.hot.add(id);
    if (s.mat[id] === MAT.steel) this.hotBuildings.add(s.building[id]!);
  }

  /** Buildings whose steel was heated since the last call (their structure needs a re-check). */
  takeHotSteelBuildings(out: number[]) {
    out.length = 0;
    for (const b of this.hotBuildings) out.push(b);
    this.hotBuildings.clear();
    return out;
  }

  /**
   * Freeze breath on a piece: `amount` seconds of frost added (capped at the thaw time). Frozen
   * pieces take double blunt damage. Cools hot pieces first.
   */
  freezePiece(id: number, amount: number, cool: number) {
    const s = this.city.store;
    if (!s.isStatic(id) || amount <= 0) return;
    this.activate(s.building[id]!);
    if (s.temperature[id]! > 0) {
      s.temperature[id] = Math.max(0, s.temperature[id]! - cool);
      if (s.temperature[id]! > 0) return; // still too hot to frost
      this.hot.delete(id);
    }
    const thaw = config.freezeBreath.thawTime;
    const was = s.frozen[id]!;
    s.frozen[id] = Math.min(thaw, was + amount);
    this.frozenSet.add(id);
    if (was <= 0) this.renderer.refresh(id);
  }

  /** Cooling, thawing and refreshing their looks (a few times a second). */
  private updateTemperatures(dt: number) {
    const s = this.city.store;
    const k = Math.exp(-config.heatVision.cooling * dt);
    for (const id of this.hot) {
      const t = s.temperature[id]! * k;
      if (t < 5 || !s.isStatic(id)) {
        s.temperature[id] = 0;
        this.hot.delete(id);
        if (s.isStatic(id)) this.renderer.refresh(id);
      } else s.temperature[id] = t;
    }
    for (const id of this.frozenSet) {
      const f = s.frozen[id]! - dt;
      if (f <= 0 || !s.isStatic(id)) {
        s.frozen[id] = 0;
        this.frozenSet.delete(id);
        if (s.isStatic(id)) this.renderer.refresh(id);
      } else s.frozen[id] = f;
    }
    this.heatRefresh -= dt;
    if (this.heatRefresh <= 0) {
      this.heatRefresh = 0.1;
      for (const id of this.hot) this.renderer.refresh(id);
      for (const id of this.frozenSet)
        if (s.frozen[id]! < config.freezeBreath.fadeTime) this.renderer.refresh(id);
    }
  }

  /** Crushed by a falling section: no flying fragments, just rubble and dust. */
  crushStatic(id: number) {
    const s = this.city.store;
    if (!s.isStatic(id)) return;
    this.activate(s.building[id]!);
    s.state[id] = STATE.destroyed;
    s.hp[id] = 0;
    this.renderer.hide(id);
    const sc = config.debris.rubbleScale;
    const v = this.renderer.visualFor(id, true);
    const it = this.debris.spawn(
      v,
      s.cx[id]!,
      s.cy[id]!,
      s.cz[id]!,
      s.hx[id]! * sc,
      s.hy[id]! * sc,
      s.hz[id]! * sc,
      _q.setFromEuler(
        _e.set(this.rng.range(-0.4, 0.4), this.rng.range(0, 6.28), this.rng.range(-0.4, 0.4)),
      ),
      this.rng.range(-2, 2),
      -2,
      this.rng.range(-2, 2),
      1000,
      false,
    );
    if (!it) {
      const ground = this.debris.piles.heightAt(s.cx[id]!, s.cz[id]!);
      this.debris.addRubble(
        v,
        s.cx[id]!,
        ground + s.hy[id]! * sc * 0.5,
        s.cz[id]!,
        s.hx[id]! * sc,
        s.hy[id]! * sc * 0.5,
        s.hz[id]! * sc,
        this.rng.range(0, 6.28),
        0.2,
      );
      this.debris.piles.add(s.cx[id]!, s.cz[id]!, s.volume(id));
    }
    if (s.mat[id] === MAT.glass) this.glassFx(id, 6);
    this.afterRemoval(id);
  }

  /** Unsupported single piece: falls as one loose chunk. */
  dropPiece(id: number) {
    const s = this.city.store;
    if (!s.isStatic(id)) return;
    this.activate(s.building[id]!);
    s.state[id] = STATE.destroyed;
    this.renderer.hide(id);
    const m = this.mat(id);
    this.debris.spawn(
      this.renderer.visualFor(id, true),
      s.cx[id]!,
      s.cy[id]!,
      s.cz[id]!,
      s.hx[id]!,
      s.hy[id]!,
      s.hz[id]!,
      _q.identity(),
      0,
      -0.5,
      0,
      m.density,
      true,
    );
    this.afterRemoval(id);
  }

  private afterRemoval(id: number) {
    const b = this.city.store.building[id]!;
    this.addBill(id);
    this.piecesDestroyed++;
    this.colliders.markDirty(b);
    this.structure.markDirty(b);
  }

  addBill(id: number) {
    this.bill += this.city.store.volume(id) * this.mat(id).value;
    events.emit('damage:bill', { total: this.bill });
  }

  /** Splits a piece into fragments (DESIGN.md §7.2 destroyed state). `share` < 1 for a breach. */
  private spawnFragments(id: number, px: number, py: number, pz: number, share: number) {
    const s = this.city.store;
    const m = this.mat(id);
    const n = Math.max(1, Math.round(m.fragments * share));
    const hx = s.hx[id]!;
    const hy = s.hy[id]!;
    const hz = s.hz[id]!;
    // Split along the two largest axes into roughly n cells.
    const ax = hx >= hz ? 'x' : 'z';
    const cols = Math.max(
      1,
      Math.round(Math.sqrt(n * ((ax === 'x' ? hx : hz) / Math.max(hy, 1e-3)))),
    );
    const rows = Math.max(1, Math.ceil(n / cols));
    const glass = s.mat[id] === MAT.glass;
    const visual = this.renderer.visualFor(id, true);
    const eject = config.debris.ejectSpeed;
    let made = 0;
    for (let r = 0; r < rows && made < n; r++) {
      for (let c = 0; c < cols && made < n; c++, made++) {
        const fx = ((c + 0.5) / cols - 0.5) * 2;
        const fy = ((r + 0.5) / rows - 0.5) * 2;
        const jitter = this.rng.range(0.7, 1);
        const fhx = ax === 'x' ? (hx / cols) * jitter : glass ? hx * 0.4 : hx;
        const fhz = ax === 'z' ? (hz / cols) * jitter : glass ? hz * 0.4 : hz;
        const fhy = (hy / rows) * jitter * (glass ? 0.5 : 1);
        const x = s.cx[id]! + (ax === 'x' ? fx * hx : 0);
        const z = s.cz[id]! + (ax === 'z' ? fx * hz : 0);
        const y = s.cy[id]! + fy * hy;
        _e.set(this.rng.range(-0.5, 0.5), this.rng.range(-0.5, 0.5), this.rng.range(-0.5, 0.5));
        _q.setFromEuler(_e);
        this.debris.spawn(
          visual,
          x,
          y,
          z,
          Math.max(0.05, fhx),
          Math.max(0.05, fhy),
          Math.max(0.05, fhz),
          _q,
          px + this.rng.range(-1, 1) * eject * 0.4,
          py + this.rng.range(0, 1) * eject * 0.3,
          pz + this.rng.range(-1, 1) * eject * 0.4,
          m.density,
          !glass,
        );
      }
    }
  }

  /** Exposes a piece's floor: interior columns and slabs there become visible and solid. */
  private reveal(id: number) {
    const s = this.city.store;
    const b = this.city.buildingOf(id);
    const f = b.floorOf(id);
    this.revealFloor(b, f);
    if (s.kind[id] === KIND.slab && f + 1 < b.floors) this.revealFloor(b, f + 1);
  }

  private revealFloor(b: BuildingModel, f: number) {
    const s = this.city.store;
    let changed = false;
    const show = (id: number) => {
      if (s.flags[id]! & FLAG.revealed) return;
      s.flags[id]! |= FLAG.revealed;
      if (s.isStatic(id)) this.renderer.show(id);
      changed = true;
    };
    for (let a = 0; a < b.ncx; a++) for (let c = 0; c < b.ncz; c++) show(b.colId(f, a, c));
    for (let i = 0; i < b.ncx - 1; i++) {
      for (let j = 0; j < b.ncz - 1; j++) {
        show(b.slabId(f, i, j));
        if (f > 0) show(b.slabId(f - 1, i, j));
      }
    }
    if (changed) this.colliders.markDirty(b.id);
  }

  /** Radial damage with falloff (slams, explosions). Knocks debris away from the centre. */
  blast(x: number, y: number, z: number, radius: number, damage: number, launch: number) {
    const s = this.city.store;
    this.propDamage?.(x, y, z, radius, damage, 0, launch * 0.3, 0);
    const hits: number[] = [];
    this.city.forEachPieceInSphere(x, y, z, radius, (id) => hits.push(id));
    for (const id of hits) {
      const d = Math.sqrt(s.distSq(id, x, y, z));
      const k = Math.max(0, 1 - d / radius);
      _v.set(s.cx[id]! - x, s.cy[id]! - y + 1, s.cz[id]! - z)
        .normalize()
        .multiplyScalar(launch * k);
      this.damagePiece(id, damage * k * k, _v.x, _v.y, _v.z);
    }
    this.debris.forEachNear(x, y, z, radius, (it) => {
      const d = it.pos.distanceTo(_v.set(x, y, z));
      const k = Math.max(0, 1 - d / radius);
      _v.set(it.pos.x - x, Math.max(0.6, it.pos.y - y), it.pos.z - z)
        .normalize()
        .multiplyScalar(launch * k);
      this.debris.push(it, _v.x, _v.y + launch * k * 0.5, _v.z);
    });
  }

  /** Blows out windows within r: glass panels shatter, other facades lose their glazing. */
  shatterWindows(x: number, y: number, z: number, r: number) {
    const s = this.city.store;
    let broken = 0;
    const list: number[] = [];
    this.city.forEachPieceInSphere(x, y, z, r, (id) => {
      if (s.kind[id] === KIND.panel && !(s.flags[id]! & FLAG.parapet)) list.push(id);
    });
    for (const id of list) {
      this.activate(s.building[id]!);
      if (s.mat[id] === MAT.glass) {
        if (s.state[id]! < STATE.breached) {
          s.hp[id] = s.maxHp[id]! * config.damage.breachedAt * 0.99;
          s.state[id] = STATE.breached;
          this.renderer.refresh(id);
          this.colliders.markDirty(s.building[id]!);
          this.reveal(id);
          this.glassFx(id, 4);
          this.bill += s.volume(id) * this.mat(id).value * 0.3;
          broken++;
        }
      } else if (!(s.flags[id]! & FLAG.windowsBroken)) {
        s.flags[id]! |= FLAG.windowsBroken;
        this.renderer.refresh(id);
        this.glassFx(id, 2);
        this.bill += 1800;
        broken++;
      }
    }
    if (broken > 0) {
      events.emit('glass:shatter', { x, y, z, count: broken });
      events.emit('damage:bill', { total: this.bill });
    }
    return broken;
  }

  /** Damage at a point: the nearest piece takes it all, neighbours within r a share. */
  hitAt(
    x: number,
    y: number,
    z: number,
    r: number,
    damage: number,
    px: number,
    py: number,
    pz: number,
  ) {
    const s = this.city.store;
    this.propDamage?.(x, y, z, r, damage, px, py, pz);
    const near = this.city.nearestPiece(x, y, z, r);
    if (near < 0) return -1;
    const others: number[] = [];
    this.city.forEachPieceInSphere(x, y, z, r, (id) => {
      if (id !== near) others.push(id);
    });
    this.damagePiece(near, damage, px, py, pz);
    for (const id of others) {
      const d = Math.sqrt(s.distSq(id, x, y, z));
      this.damagePiece(id, damage * 0.35 * Math.max(0, 1 - d / r), px * 0.5, py * 0.5, pz * 0.5);
    }
    return near;
  }

  /**
   * Rips a piece out whole as a loose rigid body (grab, DESIGN.md §6.1). Returns the debris item.
   */
  ripPiece(id: number): DebrisItem | null {
    const s = this.city.store;
    if (!s.isStatic(id)) return null;
    this.activate(s.building[id]!);
    const m = this.mat(id);
    s.state[id] = STATE.destroyed;
    this.renderer.hide(id);
    this.reveal(id);
    const it = this.debris.spawn(
      this.renderer.visualFor(id, true),
      s.cx[id]!,
      s.cy[id]!,
      s.cz[id]!,
      s.hx[id]!,
      s.hy[id]!,
      s.hz[id]!,
      _q.identity(),
      0,
      0,
      0,
      m.density,
      true,
      true,
    );
    this.fx.dust.ring(s.cx[id]!, s.cy[id]!, s.cz[id]!, 1.5, 6, 3);
    this.afterRemoval(id);
    return it;
  }

  /** Debris or a thrown object hit a building: its kinetic energy becomes damage there. */
  private onContactForce(h1: number, h2: number) {
    let it = this.debris.itemOfCollider.get(h1);
    let other = h2;
    if (!it) {
      it = this.debris.itemOfCollider.get(h2);
      other = h1;
    }
    if (!it || it.hitCooldown > 0) return;
    const bi = this.colliders.buildingOfCollider.get(other);
    if (bi === undefined) return;
    this.debris.velocityOf(it, this.stepDt, _v);
    const speed = _v.length();
    if (speed < 6) return;
    const energy = 0.5 * it.mass * speed * speed;
    const dmg = energy * config.damage.energyToDamage;
    if (dmg < 2) return;
    it.hitCooldown = 0.15;
    const r = Math.max(it.hx, it.hy, it.hz) + config.damage.impactSpread;
    _v.multiplyScalar(0.35);
    this.hitAt(it.pos.x, it.pos.y, it.pos.z, r, dmg, _v.x, _v.y, _v.z);
    this.fx.dust.ring(it.pos.x, it.pos.y, it.pos.z, r * 0.5, 6, 4);
  }

  // --- fx hooks -----------------------------------------------------------------------------

  private glassFx(id: number, count: number) {
    const s = this.city.store;
    // Glass rain: thin shards, visual only, fading once they land.
    for (let i = 0; i < count; i++) {
      _e.set(this.rng.range(0, 6.28), this.rng.range(0, 6.28), 0);
      this.debris.spawn(
        'glass',
        s.cx[id]! + this.rng.range(-s.hx[id]!, s.hx[id]!),
        s.cy[id]! + this.rng.range(-s.hy[id]!, s.hy[id]!),
        s.cz[id]! + this.rng.range(-s.hz[id]!, s.hz[id]!),
        this.rng.range(0.06, 0.2),
        0.008,
        this.rng.range(0.06, 0.2),
        _q.setFromEuler(_e),
        this.rng.range(-3, 3),
        this.rng.range(-1, 2),
        this.rng.range(-3, 3),
        2500,
        false,
      );
    }
  }

  private crushFx(x: number, y: number, z: number, mass: number, nearGround: boolean) {
    const c = config.fx.collapseDust;
    const k = Math.min(1, mass / c.massForFullCloud);
    // A puff where the story was crushed...
    this.fx.collapseDust.ring(x, y, z, 8 + 10 * k, Math.round(3 + 6 * k), 2 + 4 * k);
    // ...and every crushed story feeds the cloud rolling out along the streets at ground level:
    // big, dense, slow and long-lived (DESIGN.md §7.6), heavier near the bottom of the collapse.
    const n = Math.round(c.groundPerStory * (0.4 + k) * (nearGround ? 1.6 : 1));
    for (let i = 0; i < n; i++) {
      const a = this.rng.range(0, Math.PI * 2);
      const sp = this.rng.range(5, 15) * (0.6 + k) * c.spread;
      this.fx.collapseDust.spawn(
        x + Math.cos(a) * this.rng.range(2, 10),
        this.rng.range(1, 7),
        z + Math.sin(a) * this.rng.range(2, 10),
        Math.cos(a) * sp,
        this.rng.range(0.3, 1.8),
        Math.sin(a) * sp,
        this.rng.range(7, 12),
        this.rng.range(1.4, 2.8),
      );
    }
    events.emit('camera:shake', { trauma: 0.08 + 0.25 * k });
  }

  private stressFx(x: number, y: number, z: number, k: number) {
    // Dust trickling from cracks, the odd small chunk falling.
    this.fx.dust.spawn(x, y, z, 0, -1.5, 0, 0.6 + k, 1 + k, 2.5);
    if (this.rng.next() < 0.15 + 0.3 * k) {
      this.debris.spawn(
        'structure',
        x,
        y,
        z,
        0.12,
        0.08,
        0.1,
        _q.identity(),
        0,
        -1,
        0,
        2400,
        false,
      );
    }
  }

  // --- per frame ----------------------------------------------------------------------------

  fixedUpdate(dt: number) {
    this.stepDt = dt;
    this.debris.fixedUpdate(dt);
    this.structure.fixedUpdate(dt);
    this.updateTemperatures(dt);
  }

  frameUpdate(alpha: number) {
    this.structure.update(config.structure.checksPerFrame);
    this.colliders.update(config.structure.colliderRebuildsPerFrame);
    this.debris.updatePiles(8);
    this.debris.render(alpha);
    for (const c of this.structure.clusters) c.render(alpha);
    this.renderer.flush();
  }

  /**
   * Debug/test tool: destroys `fraction` of the
   * columns of one story, lowest ids first on one side, so the building creaks, sags and goes.
   */
  cutStory(building: number, story: number, fraction: number): boolean {
    const b = this.city.buildings[building];
    if (!b || story < 0 || story >= b.floors) return false;
    const n = Math.ceil(b.ncx * b.ncz * Math.max(0, Math.min(1, fraction)));
    let cut = 0;
    for (let a = 0; a < b.ncx && cut < n; a++) {
      for (let c = 0; c < b.ncz && cut < n; c++, cut++) this.destroyPiece(b.colId(story, a, c));
    }
    return cut > 0;
  }

  /** Lifted, broken road slabs around a crater rim (DESIGN.md §6.4). */
  roadChunks(x: number, z: number, radius: number, count: number) {
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + this.rng.range(-0.25, 0.25);
      const r = radius * this.rng.range(0.85, 1.15);
      const hx = this.rng.range(0.6, 1.4);
      const hz = this.rng.range(0.5, 1.1);
      this.debris.addRubble(
        'asphalt',
        x + Math.cos(a) * r,
        0.25,
        z + Math.sin(a) * r,
        hx,
        0.18,
        hz,
        -a,
        this.rng.range(0.25, 0.6),
      );
    }
  }

  /**
   * One tiny mesh per destruction material, for the startup shader prewarm (so the first punch,
   * breach or collapse doesn't hitch compiling shaders).
   */
  prewarmMeshes(camera: THREE.Camera): THREE.Group {
    const g = new THREE.Group();
    // One material for every look now; one instance each of the box and frame geometries.
    const mats = [pieceMaterial()];
    const box = new THREE.BoxGeometry(1, 1, 1);
    camera.getWorldDirection(_v);
    mats.forEach((m, i) => {
      const bg = batchGeometry(box, 1, 'concrete');
      const mesh = new THREE.InstancedMesh(bg.geometry, m, 1);
      mesh.setMatrixAt(
        0,
        new THREE.Matrix4().makeTranslation(
          camera.position.x + _v.x * 6 + (i % 5) * 0.3,
          camera.position.y + _v.y * 6,
          camera.position.z + _v.z * 6,
        ),
      );
      mesh.frustumCulled = false;
      // Falling sections, debris and rubble cast shadows: compile those shadow shaders too.
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      g.add(mesh);
    });
    return g;
  }

  /** Top of the standing floor slab under a point inside a building (debris rests there). */
  private floorUnder(x: number, y: number, z: number, out: { y: number; slab: number }) {
    const H = config.construction.floorHeight;
    const s = this.city.store;
    this.city.forEachBuildingNear(x, y, z, 0, (b) => {
      if (x < b.x0 || x > b.x1 || z < b.z0 || z > b.z1 || y <= H) return;
      let i = 0;
      while (i < b.ncx - 2 && x > b.posX[i + 1]!) i++;
      let j = 0;
      while (j < b.ncz - 2 && z > b.posZ[j + 1]!) j++;
      for (let f = Math.min(b.floors, Math.floor(y / H)) - 1; f >= 0; f--) {
        const slab = b.slabId(f, i, j);
        if (s.isStatic(slab)) {
          const top = (f + 1) * H;
          if (top > out.y) {
            out.y = top;
            out.slab = slab;
          }
          return;
        }
      }
    });
  }

  /** Blows out the windows of one panel (fire heat), as the sonic boom does. */
  breakWindow(id: number) {
    const s = this.city.store;
    if (!s.isStatic(id) || s.kind[id] !== KIND.panel || s.flags[id]! & FLAG.parapet) return;
    this.shatterWindows(s.cx[id]!, s.cy[id]!, s.cz[id]!, 0.2);
  }

  /** Low sonic pass: windows along the route blow out (DESIGN.md §6.5). */
  sonicPass(x: number, y: number, z: number) {
    const sc = config.sonicCity;
    if (y > sc.passAltitude + 20) return;
    this.shatterWindows(x, y, z, sc.passRadius);
  }

  stats() {
    return {
      pieces: this.city.pieceCount,
      shown: this.renderer.shownCount,
      colliders: this.colliders.total + this.debris.piles.count,
      active: this.debris.activeBodies,
      visual: this.debris.visualCount,
      rubble: this.debris.rubbleCount,
      clusters: this.structure.clusters.length,
      failing: this.structure.failures.size,
      destroyed: this.piecesDestroyed,
      bill: this.bill,
    };
  }
}
