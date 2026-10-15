import * as THREE from 'three/webgpu';
import { config } from '../config';
import { Rng } from '../core/rng';
import type { CityStructure } from '../destruction/cityStructure';
import { FLAG, KIND, MAT, STATE } from '../destruction/pieces';
import { BuildingProxies } from './buildingProxies';
import {
  batchGeometry,
  createFrameGeometry,
  pieceMaterial,
  PIECE_VISUALS,
  type PieceVisual,
} from './pieceMaterials';

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _yaw90 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);

/** One instanced draw: pieces of one visual class in one chunk, packed with swap-remove. */
class Batch {
  readonly mesh: THREE.InstancedMesh;
  readonly tint: THREE.InstancedBufferAttribute;
  readonly state: THREE.InstancedBufferAttribute;
  readonly slotPiece: Int32Array;
  count = 0;
  dirty = false;

  constructor(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    readonly capacity: number,
    bounds: THREE.Sphere,
  ) {
    const g = batchGeometry(geometry, capacity);
    this.tint = g.tint;
    this.state = g.state;
    this.mesh = new THREE.InstancedMesh(g.geometry, material, capacity);
    this.mesh.count = 0;
    this.mesh.visible = false;
    // Pieces don't cast shadows themselves: merged shadow boxes (BuildingProxies) do, far cheaper.
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    this.mesh.boundingSphere = bounds.clone();
    this.slotPiece = new Int32Array(capacity).fill(-1);
  }

  add(piece: number, m: THREE.Matrix4, r: number, g: number, b: number): number {
    const slot = this.count++;
    this.mesh.setMatrixAt(slot, m);
    this.tint.setXYZ(slot, r, g, b);
    this.state.setXYZW(slot, 0, 0, 0, 0);
    this.slotPiece[slot] = piece;
    this.dirty = true;
    return slot;
  }

  /** Removes a slot; returns the piece that moved into it (or -1). */
  remove(slot: number): number {
    const last = --this.count;
    this.dirty = true;
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
    const moved = this.slotPiece[last]!;
    this.slotPiece[slot] = moved;
    this.slotPiece[last] = -1;
    return moved;
  }

  flush() {
    if (!this.dirty) return;
    this.dirty = false;
    this.mesh.count = this.count;
    this.mesh.visible = this.count > 0;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.tint.needsUpdate = true;
    this.state.needsUpdate = true;
  }
}

/**
 * Draws every static building piece (DESIGN.md §7.1 rendering). Per city block and per visual
 * class there is one instanced batch. Interior pieces join a batch only once revealed, so an
 * intact skyline costs just its shells. Breached panels swap to a holed frame mesh.
 */
export class PieceRenderer {
  readonly group = new THREE.Group();
  readonly materials = new Map<PieceVisual, THREE.MeshStandardNodeMaterial>();
  private batches: (Batch | null)[];
  /** Per piece: global batch index (chunk * visuals + visual), slot within it, or -1. */
  private pieceBatch: Int32Array;
  private pieceSlot: Int32Array;
  private tints: Float32Array;
  private boxGeo = new THREE.BoxGeometry(1, 1, 1);
  private frameGeo = createFrameGeometry();
  private mullionGeo = createFrameGeometry(0.05, 0.05, 0.05);
  private nv = PIECE_VISUALS.length;
  private bounds: THREE.Sphere[];
  private capacities: Int32Array;
  readonly proxies: BuildingProxies;
  /** Buildings drawn as real pieces (damaged at least once); the rest use proxies. */
  readonly active: Uint8Array;

  constructor(
    scene: THREE.Scene,
    private readonly city: CityStructure,
    seed: number,
  ) {
    for (const v of PIECE_VISUALS) this.materials.set(v, pieceMaterial(v));
    const store = city.store;
    this.pieceBatch = new Int32Array(store.count).fill(-1);
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

    // Capacity per (chunk, visual): every piece that could ever show there. Panels can show as
    // either their intact or their frame visual, so count them for both.
    const nb = city.chunkCount * this.nv;
    this.capacities = new Int32Array(nb);
    const boxes = Array.from({ length: city.chunkCount }, () => new THREE.Box3());
    city.buildings.forEach((b, bi) => {
      const chunk = city.chunkOf[bi]!;
      boxes[chunk]!.expandByPoint(_p.set(b.x0, 0, b.z0));
      boxes[chunk]!.expandByPoint(_p.set(b.x1, b.height + 10, b.z1));
      for (let id = b.base; id < b.end; id++) {
        const v = this.visualFor(id, false);
        this.capacities[chunk * this.nv + PIECE_VISUALS.indexOf(v)]!++;
        if (store.kind[id] === KIND.panel && !(store.flags[id]! & FLAG.parapet)) {
          const fv = this.visualFor(id, true);
          if (fv !== v) this.capacities[chunk * this.nv + PIECE_VISUALS.indexOf(fv)]!++;
        }
      }
    });
    this.bounds = boxes.map((b) => b.getBoundingSphere(new THREE.Sphere()));
    this.batches = new Array(nb).fill(null);

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

  private batch(chunk: number, visual: PieceVisual): Batch {
    const vi = PIECE_VISUALS.indexOf(visual);
    const idx = chunk * this.nv + vi;
    let b = this.batches[idx];
    if (!b) {
      const geo =
        visual === 'frameGlass'
          ? this.mullionGeo
          : visual.startsWith('frame')
            ? this.frameGeo
            : this.boxGeo;
      b = new Batch(
        geo,
        this.materials.get(visual)!,
        Math.max(1, this.capacities[idx]!),
        this.bounds[chunk]!,
      );
      this.batches[idx] = b;
      this.group.add(b.mesh);
    }
    return b;
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
    const chunk = this.city.chunkOf[bi]!;
    const visual = this.visualFor(id);
    const batch = this.batch(chunk, visual);
    _p.set(s.cx[id]!, s.cy[id]!, s.cz[id]!);
    const frame = visual.startsWith('frame');
    if (frame && s.hx[id]! < s.hz[id]!) {
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
    );
    this.pieceBatch[id] = chunk * this.nv + PIECE_VISUALS.indexOf(visual);
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

  /** Re-reads a piece's state (cracks, windows, breach swap). */
  refresh(id: number) {
    if (this.pieceSlot[id]! < 0) return;
    const s = this.city.store;
    if (s.state[id] === STATE.destroyed || !s.isStatic(id)) {
      this.hide(id);
      return;
    }
    const want =
      this.city.chunkOf[s.building[id]!]! * this.nv + PIECE_VISUALS.indexOf(this.visualFor(id));
    if (want !== this.pieceBatch[id]) {
      this.hide(id);
      this.show(id);
      return;
    }
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
      Math.min(1, s.temperature[id]! / 800),
      Math.min(1, s.frozen[id]!),
    );
    batch.dirty = true;
  }

  flush() {
    for (const b of this.batches) b?.flush();
    this.proxies.flush();
  }

  /**
   * Startup prewarm: create every batch up front and draw each once (with a degenerate instance),
   * so the first damage to a block doesn't stall on creating and first-drawing its meshes.
   */
  setPrewarm(on: boolean) {
    if (on) {
      for (let idx = 0; idx < this.batches.length; idx++) {
        if (this.capacities[idx]! <= 0) continue;
        const b = this.batch(Math.floor(idx / this.nv), PIECE_VISUALS[idx % this.nv]!);
        if (b.count === 0) {
          b.mesh.setMatrixAt(0, _m.makeScale(0, 0, 0));
          b.mesh.count = 1;
          b.mesh.visible = true;
          b.mesh.instanceMatrix.needsUpdate = true;
        }
      }
    } else {
      for (const b of this.batches) {
        if (!b) continue;
        b.dirty = true;
        b.flush();
      }
    }
  }

  /** Stats for the perf HUD. */
  get shownCount() {
    let n = 0;
    for (const b of this.batches) if (b) n += b.count;
    return n;
  }
}
