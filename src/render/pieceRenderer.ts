import * as THREE from 'three/webgpu';
import { config } from '../config';
import { Rng } from '../core/rng';
import type { CityStructure } from '../destruction/cityStructure';
import { FLAG, KIND, MAT, STATE } from '../destruction/pieces';
import { BuildingProxies } from './buildingProxies';
import { uploadSlots } from './uploadRange';
import {
  batchGeometry,
  createFrameGeometry,
  pieceMaterial,
  PIECE_VISUALS,
  VI,
  type PieceVisual,
} from './pieceMaterials';

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _yaw90 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);

/** Which mesh shape a visual draws with. */
type Shape = 0 | 1 | 2; // box, holed panel frame, curtain-wall mullion frame
const shapeOf = (v: PieceVisual): Shape => (v === 'frameGlass' ? 2 : v.startsWith('frame') ? 1 : 0);

/** One instanced draw for every shown piece of one shape, packed with swap-remove. */
class Batch {
  readonly mesh: THREE.InstancedMesh;
  readonly tint: THREE.InstancedBufferAttribute;
  readonly state: THREE.InstancedBufferAttribute;
  readonly room: THREE.InstancedBufferAttribute;
  readonly visual: THREE.InstancedBufferAttribute;
  readonly slotPiece: Int32Array;
  count = 0;
  dirty = false;

  constructor(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    readonly capacity: number,
    bounds: THREE.Sphere,
  ) {
    const g = batchGeometry(geometry, capacity, 'structure');
    this.tint = g.tint;
    this.state = g.state;
    this.room = g.room;
    this.visual = g.visual;
    this.mesh = new THREE.InstancedMesh(g.geometry, material, capacity);
    this.mesh.count = 0;
    // Pieces don't cast shadows themselves: merged shadow boxes (BuildingProxies) do, far cheaper.
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    this.mesh.boundingSphere = bounds.clone();
    this.slotPiece = new Int32Array(capacity).fill(-1);
  }

  add(piece: number, m: THREE.Matrix4, r: number, g: number, b: number, visual: number): number {
    const slot = this.count++;
    this.touch(slot);
    this.mesh.setMatrixAt(slot, m);
    this.tint.setXYZ(slot, r, g, b);
    this.state.setXYZW(slot, 0, 0, 0, 0);
    this.visual.setX(slot, visual);
    this.slotPiece[slot] = piece;
    this.dirty = true;
    return slot;
  }

  /** Removes a slot; returns the piece that moved into it (or -1). */
  remove(slot: number): number {
    const last = --this.count;
    this.dirty = true;
    this.touch(slot);
    if (slot === last) {
      this.slotPiece[slot] = -1;
      return -1;
    }
    this.mesh.getMatrixAt(last, _m);
    this.mesh.setMatrixAt(slot, _m);
    this.tint.setXYZ(slot, this.tint.getX(last), this.tint.getY(last), this.tint.getZ(last));
    this.state.setXYZW(
      slot,
      this.state.getX(last),
      this.state.getY(last),
      this.state.getZ(last),
      this.state.getW(last),
    );
    this.room.setXYZW(
      slot,
      this.room.getX(last),
      this.room.getY(last),
      this.room.getZ(last),
      this.room.getW(last),
    );
    this.visual.setX(slot, this.visual.getX(last));
    const moved = this.slotPiece[last]!;
    this.slotPiece[slot] = moved;
    this.slotPiece[last] = -1;
    return moved;
  }

  /** Slots changed since the last flush: only that range is uploaded (a whole batch is MBs). */
  private dirtyMin = Infinity;
  private dirtyMax = -1;

  /** Marks a slot changed (anything that writes a slot's data must call this). */
  touch(slot: number) {
    if (slot < this.dirtyMin) this.dirtyMin = slot;
    if (slot > this.dirtyMax) this.dirtyMax = slot;
    this.dirty = true;
  }

  flush() {
    if (!this.dirty) return;
    this.dirty = false;
    this.mesh.count = this.count;
    const last = Math.min(this.dirtyMax, this.count - 1);
    uploadSlots(
      this.dirtyMin,
      last,
      this.mesh.instanceMatrix,
      this.tint,
      this.state,
      this.room,
      this.visual,
    );
    this.dirtyMin = Infinity;
    this.dirtyMax = -1;
  }
}

const _room = new Float32Array(4);

/**
 * Draws every static building piece of damaged buildings (DESIGN.md §7.1 rendering): three
 * instanced draws for the whole city, one per shape, with each piece's look picked per instance
 * by the shared piece material. Created up front: three.js generates shader code per instanced
 * mesh, so making meshes mid-play would stall. Interior pieces join only once revealed.
 */
export class PieceRenderer {
  readonly group = new THREE.Group();
  readonly materials = new Map<PieceVisual, THREE.MeshStandardNodeMaterial>();
  private batches: Batch[];
  /** Per piece: batch (shape) and slot within it, or -1. */
  private pieceBatch: Int8Array;
  private pieceSlot: Int32Array;
  private tints: Float32Array;
  readonly proxies: BuildingProxies;
  /**
   * Room behind a panel's window: [side + seed, power, fire, burnt] (set by the interior system;
   * the default is a lit, powered room seeded from the piece id).
   */
  roomInfo: (id: number, out: Float32Array) => void = (id, out) => {
    const b = this.city.buildingOf(id);
    out[0] = b.panelSide(id) + ((id * 0.6180339) % 1) * 0.99;
    out[1] = 1;
    out[2] = 0;
    out[3] = 0;
  };
  /** Buildings drawn as real pieces (damaged at least once); the rest use proxies. */
  readonly active: Uint8Array;

  constructor(
    scene: THREE.Scene,
    private readonly city: CityStructure,
    seed: number,
  ) {
    for (const v of PIECE_VISUALS) this.materials.set(v, pieceMaterial(v));
    const store = city.store;
    this.pieceBatch = new Int8Array(store.count).fill(-1);
    this.pieceSlot = new Int32Array(store.count).fill(-1);

    // Per-building tint: slight variation so blocks don't look cloned.
    const rng = new Rng(seed ^ 0x7111);
    this.tints = new Float32Array(city.buildings.length * 3);
    city.buildings.forEach((b, i) => {
      const k = rng.range(0.82, 1.12);
      const warm = b.src.district === 'low' ? rng.range(0.95, 1.08) : rng.range(0.94, 1.02);
      this.tints[i * 3] = k * warm;
      this.tints[i * 3 + 1] = k;
      this.tints[i * 3 + 2] = k * (2 - warm);
    });

    // Capacity per shape: every piece that could ever show with it.
    const caps = [0, 0, 0];
    const bounds = new THREE.Box3();
    city.buildings.forEach((b) => {
      bounds.expandByPoint(_p.set(b.x0, 0, b.z0));
      bounds.expandByPoint(_p.set(b.x1, b.height + 10, b.z1));
      for (let id = b.base; id < b.end; id++) {
        caps[0]!++;
        if (store.kind[id] === KIND.panel && !(store.flags[id]! & FLAG.parapet))
          caps[shapeOf(this.visualFor(id, true))]!++;
      }
    });
    const sphere = bounds.getBoundingSphere(new THREE.Sphere());
    const material = pieceMaterial();
    const geos = [
      new THREE.BoxGeometry(1, 1, 1),
      createFrameGeometry(),
      createFrameGeometry(0.05, 0.05, 0.05),
    ];
    this.batches = geos.map((g, i) => new Batch(g, material, Math.max(1, caps[i]!), sphere));
    for (const b of this.batches) this.group.add(b.mesh);

    this.active = new Uint8Array(city.buildings.length);
    this.proxies = new BuildingProxies(scene, city, this.tints);
    scene.add(this.group);
  }

  /** Which visual a piece uses; `breached` forces the frame variant for panels. */
  visualFor(id: number, breached = this.city.store.state[id] === STATE.breached): PieceVisual {
    const s = this.city.store;
    const kind = s.kind[id];
    if (kind === KIND.column || kind === KIND.slab) return 'structure';
    if (kind === KIND.roof) return 'roof';
    if (s.flags[id]! & FLAG.parapet) return 'roof';
    const mat = s.mat[id];
    if (mat === MAT.glass) return breached ? 'frameGlass' : 'glass';
    if (mat === MAT.brick) return breached ? 'frameBrick' : 'brick';
    return breached ? 'frameConcrete' : 'concrete';
  }

  /** The three instanced meshes (for the shader warm-up). */
  get meshes() {
    return this.batches.map((b) => b.mesh);
  }

  /** Swap a building from its proxy to real pieces (first damage). Idempotent. */
  activate(building: number) {
    if (this.active[building]) return;
    this.active[building] = 1;
    this.proxies.setActive(building, true);
    const b = this.city.buildings[building]!;
    const s = this.city.store;
    for (let id = b.base; id < b.end; id++) if (s.flags[id]! & FLAG.revealed) this.show(id);
  }

  get activeCount() {
    let n = 0;
    for (const a of this.active) n += a;
    return n;
  }

  isShown(id: number) {
    return this.pieceSlot[id]! >= 0;
  }

  /** Adds a static piece to its batch (no-op if already shown). */
  show(id: number) {
    if (this.pieceSlot[id]! >= 0) return;
    const s = this.city.store;
    if (s.state[id] === STATE.destroyed || !s.isStatic(id)) return;
    const bi = s.building[id]!;
    if (!this.active[bi]) return;
    const visual = this.visualFor(id);
    const shape = shapeOf(visual);
    const batch = this.batches[shape]!;
    _p.set(s.cx[id]!, s.cy[id]!, s.cz[id]!);
    if (shape !== 0 && s.hx[id]! < s.hz[id]!) {
      // Frames are modelled facing ±z; panels on the x-facing sides need a quarter turn.
      _m.compose(_p, _yaw90, _s.set(s.hz[id]! * 2, s.hy[id]! * 2, s.hx[id]! * 2));
    } else {
      _m.compose(_p, _q.identity(), _s.set(s.hx[id]! * 2, s.hy[id]! * 2, s.hz[id]! * 2));
    }
    const slot = batch.add(
      id,
      _m,
      this.tints[bi * 3]!,
      this.tints[bi * 3 + 1]!,
      this.tints[bi * 3 + 2]!,
      VI(visual),
    );
    this.pieceBatch[id] = shape;
    this.pieceSlot[id] = slot;
    this.writeState(id);
  }

  hide(id: number) {
    const slot = this.pieceSlot[id]!;
    if (slot < 0) return;
    const batch = this.batches[this.pieceBatch[id]!]!;
    const moved = batch.remove(slot);
    if (moved >= 0) this.pieceSlot[moved] = slot;
    this.pieceSlot[id] = -1;
    this.pieceBatch[id] = -1;
  }

  /** Re-reads every shown panel of a building (power, fire and soot changes). */
  refreshBuilding(building: number) {
    if (!this.active[building]) return;
    const b = this.city.buildings[building]!;
    for (let id = b.panelBase; id < b.roofBase; id++)
      if (this.pieceSlot[id]! >= 0) this.writeState(id);
  }

  /** Re-reads a piece's state (cracks, windows, breach swap). */
  refresh(id: number) {
    if (this.pieceSlot[id]! < 0) return;
    const s = this.city.store;
    if (s.state[id] === STATE.destroyed || !s.isStatic(id)) {
      this.hide(id);
      return;
    }
    const visual = this.visualFor(id);
    const batch = this.batches[this.pieceBatch[id]!]!;
    if (shapeOf(visual) !== this.pieceBatch[id]) {
      this.hide(id);
      this.show(id);
      return;
    }
    batch.visual.setX(this.pieceSlot[id]!, VI(visual));
    this.writeState(id);
  }

  private writeState(id: number) {
    const s = this.city.store;
    const batch = this.batches[this.pieceBatch[id]!]!;
    const frac = s.maxHp[id]! > 0 ? s.hp[id]! / s.maxHp[id]! : 1;
    const crack = Math.max(
      0,
      Math.min(1, (config.damage.crackedAt - frac) / config.damage.crackedAt + 0.15),
    );
    const cracked = s.state[id] === STATE.intact ? 0 : crack;
    batch.state.setXYZW(
      this.pieceSlot[id]!,
      cracked,
      s.flags[id]! & FLAG.windowsBroken ? 1 : 0,
      Math.min(1, s.soot[id]!),
      thermalState(s.frozen[id]!, s.temperature[id]!),
    );
    if (s.kind[id] === KIND.panel) {
      this.roomInfo(id, _room);
      batch.room.setXYZW(this.pieceSlot[id]!, _room[0]!, _room[1]!, _room[2]!, _room[3]!);
    }
    batch.touch(this.pieceSlot[id]!);
  }

  /** Forces every batch to re-upload its count and data on the next flush. */
  markAllDirty() {
    for (const b of this.batches) {
      b.touch(0);
      b.touch(Math.max(0, b.count - 1));
    }
  }

  flush() {
    for (const b of this.batches) b.flush();
    this.proxies.flush();
  }

  /** Stats for the perf HUD. */
  get shownCount() {
    let n = 0;
    for (const b of this.batches) n += b.count;
    return n;
  }
}

/**
 * aState.w: frost (0..1, positive; fades over the last seconds before thawing) or heat glow
 * (negative, -1 = white hot). A piece is never both: heat thaws it and frost cools it.
 */
export function thermalState(frozen: number, temperature: number) {
  if (frozen > 0) return Math.min(1, frozen / Math.max(0.01, config.freezeBreath.fadeTime));
  const h = config.heatVision;
  const glow = (temperature - h.glowStart) / Math.max(1, h.glowFull - h.glowStart);
  return glow > 0 ? -Math.min(1, glow) : 0;
}
