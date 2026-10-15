import type { CityLayout } from '../world/cityLayout';
import { BuildingModel, type ConstructionParams, type MaterialStats } from './buildingModel';
import { MATERIAL_NAMES, PieceStore } from './pieces';

/**
 * Every destructible building in the city plus the shared piece store. Buildings are grouped into
 * render chunks (one per city block) so a whole block draws in a handful of instanced calls.
 */
export class CityStructure {
  readonly buildings: BuildingModel[] = [];
  readonly store: PieceStore;
  /** Render chunk (city block) per building. */
  readonly chunkOf: Int32Array;
  readonly chunkCount: number;
  /** Scratch buffers for graph searches, sized to the largest building. */
  readonly mark: Uint8Array;
  readonly queue: Int32Array;

  constructor(layout: CityLayout, params: ConstructionParams, mats: MaterialStats, seed: number) {
    let base = 0;
    layout.buildings.forEach((src, i) => {
      const b = new BuildingModel(i, src, base, params);
      this.buildings.push(b);
      base += b.count;
    });
    this.store = new PieceStore(base);
    let maxCount = 0;
    this.buildings.forEach((b, i) => {
      b.fill(this.store, mats, MATERIAL_NAMES, seed * 977 + i);
      maxCount = Math.max(maxCount, b.count);
    });
    this.mark = new Uint8Array(maxCount);
    this.queue = new Int32Array(maxCount);

    // Chunk = the city block a building's centre sits in.
    const pitch = layout.pitch;
    const bx = Math.round((layout.halfExtentX * 2) / pitch);
    const bz = Math.round((layout.halfExtentZ * 2) / pitch);
    this.chunkCount = bx * bz;
    this.chunkOf = new Int32Array(this.buildings.length);
    this.buildings.forEach((b, i) => {
      const ci = clampInt(Math.floor((b.src.x + layout.halfExtentX) / pitch), 0, bx - 1);
      const cj = clampInt(Math.floor((b.src.z + layout.halfExtentZ) / pitch), 0, bz - 1);
      this.chunkOf[i] = cj * bx + ci;
    });
  }

  get pieceCount() {
    return this.store.count;
  }

  buildingOf(piece: number) {
    return this.buildings[this.store.building[piece]!]!;
  }

  /** Buildings whose footprint (plus margin r) contains the point's x/z and height range. */
  forEachBuildingNear(x: number, y: number, z: number, r: number, fn: (b: BuildingModel) => void) {
    for (const b of this.buildings) {
      if (x < b.x0 - r || x > b.x1 + r || z < b.z0 - r || z > b.z1 + r) continue;
      if (y < -r || y > b.height + 8 + r) continue;
      fn(b);
    }
  }

  /** Every static piece within r of the point, across all buildings. */
  forEachPieceInSphere(x: number, y: number, z: number, r: number, fn: (id: number) => void) {
    this.forEachBuildingNear(x, y, z, r, (b) => b.forEachInSphere(this.store, x, y, z, r, fn));
  }

  /** The static piece nearest to the point within r, or -1. */
  nearestPiece(x: number, y: number, z: number, r: number): number {
    let best = -1;
    let bestD = Infinity;
    this.forEachPieceInSphere(x, y, z, r, (id) => {
      const d = this.store.distSq(id, x, y, z);
      if (d < bestD) {
        bestD = d;
        best = id;
      }
    });
    return best;
  }
}

function clampInt(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}
