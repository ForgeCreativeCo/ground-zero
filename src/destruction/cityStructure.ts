import type { RayBoxHit } from '../core/geom';
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

    // Spatial grid of building footprints, for point and sphere queries.
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (const b of this.buildings) {
      minX = Math.min(minX, b.x0);
      minZ = Math.min(minZ, b.z0);
      maxX = Math.max(maxX, b.x1);
      maxZ = Math.max(maxZ, b.z1);
    }
    if (!this.buildings.length) minX = minZ = maxX = maxZ = 0;
    this.gx0 = minX - GRID_CELL;
    this.gz0 = minZ - GRID_CELL;
    this.gnx = Math.ceil((maxX - this.gx0) / GRID_CELL) + 2;
    this.gnz = Math.ceil((maxZ - this.gz0) / GRID_CELL) + 2;
    const cells: number[][] = Array.from({ length: this.gnx * this.gnz }, () => []);
    for (const b of this.buildings) {
      const i0 = this.cellX(b.x0);
      const i1 = this.cellX(b.x1);
      const j0 = this.cellZ(b.z0);
      const j1 = this.cellZ(b.z1);
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) cells[j * this.gnx + i]!.push(b.id);
    }
    this.gridStart = new Int32Array(cells.length + 1);
    let n = 0;
    cells.forEach((c, k) => {
      this.gridStart[k] = n;
      n += c.length;
    });
    this.gridStart[cells.length] = n;
    this.gridItems = new Int32Array(n);
    cells.forEach((c, k) => this.gridItems.set(c, this.gridStart[k]!));
    this.seen = new Int32Array(this.buildings.length);
  }

  private readonly gx0: number;
  private readonly gz0: number;
  private readonly gnx: number;
  private readonly gnz: number;
  private readonly gridStart: Int32Array;
  private readonly gridItems: Int32Array;
  /** Query stamps (dedupes buildings spanning several cells) and per-depth result buffers. */
  private readonly seen: Int32Array;
  private stampN = 0;
  private depth = 0;
  private bufs: number[][] = [];

  private cellX(x: number) {
    return clampInt(Math.floor((x - this.gx0) / GRID_CELL), 0, this.gnx - 1);
  }

  private cellZ(z: number) {
    return clampInt(Math.floor((z - this.gz0) / GRID_CELL), 0, this.gnz - 1);
  }

  get pieceCount() {
    return this.store.count;
  }

  buildingOf(piece: number) {
    return this.buildings[this.store.building[piece]!]!;
  }

  /** Buildings whose footprint (plus margin r) contains the point's x/z and height range. */
  forEachBuildingNear(x: number, y: number, z: number, r: number, fn: (b: BuildingModel) => void) {
    // Collect first, then call: fn may run nested queries (each depth has its own buffer).
    const buf = (this.bufs[this.depth] ??= []);
    buf.length = 0;
    const stamp = ++this.stampN;
    const i0 = this.cellX(x - r);
    const i1 = this.cellX(x + r);
    const j0 = this.cellZ(z - r);
    const j1 = this.cellZ(z + r);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * this.gnx + i;
        for (let n = this.gridStart[k]!; n < this.gridStart[k + 1]!; n++) {
          const bi = this.gridItems[n]!;
          if (this.seen[bi] === stamp) continue;
          this.seen[bi] = stamp;
          const b = this.buildings[bi]!;
          if (x < b.x0 - r || x > b.x1 + r || z < b.z0 - r || z > b.z1 + r) continue;
          if (y < -r || y > b.height + 8 + r) continue;
          buf.push(bi);
        }
      }
    }
    this.depth++;
    try {
      for (const bi of buf) fn(this.buildings[bi]!);
    } finally {
      this.depth--;
    }
  }

  /** Every static piece within r of the point, across all buildings. */
  forEachPieceInSphere(x: number, y: number, z: number, r: number, fn: (id: number) => void) {
    this.forEachBuildingNear(x, y, z, r, (b) => b.forEachInSphere(this.store, x, y, z, r, fn));
  }

  /**
   * Static pieces along the ray o + t·d (d unit length) up to maxT, nearest first. Fills and
   * returns a shared array (valid until the next call): each hit's piece, entry t and entry face.
   */
  raycast(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    maxT: number,
  ): readonly PieceRayHit[] {
    this.rayCount = 0;
    for (const b of this.buildings) {
      b.forEachOnRay(this.store, ox, oy, oz, dx, dy, dz, 0, maxT, this.collectHit);
    }
    const out = this.rayOut;
    out.length = 0;
    for (let i = 0; i < this.rayCount; i++) out.push(this.rayHits[i]!);
    out.sort(byT);
    return out;
  }

  private rayHits: PieceRayHit[] = [];
  private rayOut: PieceRayHit[] = [];
  private rayCount = 0;
  private collectHit = (id: number, hit: RayBoxHit) => {
    let h = this.rayHits[this.rayCount];
    if (!h) this.rayHits.push((h = { id: 0, t: 0, axis: 0, sign: 1 }));
    h.id = id;
    h.t = Math.max(0, hit.tEnter);
    h.axis = hit.axis;
    h.sign = hit.sign;
    this.rayCount++;
  };

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

/** A piece crossed by a ray: entry distance and the face it enters (axis 0/1/2, outward sign). */
export interface PieceRayHit {
  id: number;
  t: number;
  axis: number;
  sign: number;
}

/** Building grid cell size (m). */
const GRID_CELL = 32;

const byT = (a: PieceRayHit, b: PieceRayHit) => a.t - b.t;

function clampInt(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}
