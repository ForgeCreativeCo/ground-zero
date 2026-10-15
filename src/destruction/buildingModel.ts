import { Rng } from '../core/rng';
import type { Building as LayoutBuilding } from '../world/cityLayout';
import { FLAG, KIND, MAT, STATE, type PieceStore } from './pieces';

/** Construction parameters (subset of config.construction). */
export interface ConstructionParams {
  floorHeight: number;
  bayWidth: number;
  baysPerSpan: number;
  panelThickness: number;
  slabThickness: number;
  columnSize: number;
  roofEquipment: number;
  parapetHeight: number;
}

/** Per-material stats needed to fill pieces (subset of config.materials). */
export type MaterialStats = Record<string, { hp: number; density: number }>;

/** Sides: 0 = -z face (runs along x), 1 = +x face (along z), 2 = +z face (along x), 3 = -x face. */
const SIDE_ALONG_X = [true, false, true, false];

/**
 * One building as a grid of pieces (DESIGN.md §7.1): columns at structural grid points per story,
 * floor slabs per structural cell, one facade panel per bay per floor, and roof elements.
 *
 * Piece ids are contiguous per building, so the support graph is implicit: neighbours are
 * computed from grid indices instead of stored, and queries iterate only the affected floors.
 * Pure data; rendering and physics live elsewhere.
 */
export class BuildingModel {
  readonly floors: number;
  /** Facade bays along x (sides 0, 2) and along z (sides 1, 3). */
  readonly nbx: number;
  readonly nbz: number;
  /** Column lines in bay units, and their world positions. */
  readonly linesX: number[];
  readonly linesZ: number[];
  readonly posX: number[];
  readonly posZ: number[];
  readonly ncx: number;
  readonly ncz: number;
  readonly bwx: number;
  readonly bwz: number;
  readonly x0: number;
  readonly z0: number;
  readonly x1: number;
  readonly z1: number;
  readonly height: number;
  /** Piece id ranges. */
  readonly base: number;
  readonly colBase: number;
  readonly slabBase: number;
  readonly panelBase: number;
  readonly roofBase: number;
  readonly count: number;
  readonly panelsPerFloor: number;
  readonly sideOffset: number[];
  readonly roofCount: number;
  /** Bay index → slab cell index along each axis. */
  private cellOfBayX: Int32Array;
  private cellOfBayZ: Int32Array;
  /** Roof piece → the slab cells it rests on [start, end) per axis. */
  private roofCells: Int32Array;
  readonly facadeMat: number;
  readonly structureMat: number;

  constructor(
    readonly id: number,
    readonly src: LayoutBuilding,
    base: number,
    readonly p: ConstructionParams,
  ) {
    this.base = base;
    this.floors = Math.max(1, Math.round(src.h / p.floorHeight));
    this.height = this.floors * p.floorHeight;
    this.x0 = src.x - src.w / 2;
    this.x1 = src.x + src.w / 2;
    this.z0 = src.z - src.d / 2;
    this.z1 = src.z + src.d / 2;
    const pt = p.panelThickness;
    this.nbx = Math.max(1, Math.round(src.w / p.bayWidth));
    this.nbz = Math.max(1, Math.round((src.d - 2 * pt) / p.bayWidth));
    this.bwx = src.w / this.nbx;
    this.bwz = (src.d - 2 * pt) / this.nbz;
    this.linesX = columnLines(this.nbx, p.baysPerSpan);
    this.linesZ = columnLines(this.nbz, p.baysPerSpan);
    this.ncx = this.linesX.length;
    this.ncz = this.linesZ.length;
    // Slab cells span between column lines; the outer lines sit just inside the facade.
    this.posX = this.linesX.map((l, i) =>
      i === 0 ? this.x0 + pt : i === this.ncx - 1 ? this.x1 - pt : this.x0 + l * this.bwx,
    );
    this.posZ = this.linesZ.map((l, i) =>
      i === 0 ? this.z0 + pt : i === this.ncz - 1 ? this.z1 - pt : this.z0 + pt + l * this.bwz,
    );
    this.cellOfBayX = bayToCell(this.nbx, this.linesX);
    this.cellOfBayZ = bayToCell(this.nbz, this.linesZ);

    const F = this.floors;
    this.panelsPerFloor = 2 * this.nbx + 2 * this.nbz;
    this.sideOffset = [0, this.nbx, this.nbx + this.nbz, 2 * this.nbx + this.nbz];
    // 4 parapets + equipment boxes (parking structures: parapets only).
    this.roofCount = 4 + (src.parking ? 0 : p.roofEquipment);
    this.colBase = base;
    this.slabBase = this.colBase + F * this.ncx * this.ncz;
    this.panelBase = this.slabBase + F * (this.ncx - 1) * (this.ncz - 1);
    this.roofBase = this.panelBase + F * this.panelsPerFloor;
    this.count = this.roofBase + this.roofCount - base;
    this.roofCells = new Int32Array(this.roofCount * 4);

    this.facadeMat = src.parking
      ? MAT.concretePanel
      : src.district === 'downtown'
        ? MAT.glass
        : src.district === 'mid'
          ? MAT.concretePanel
          : MAT.brick;
    this.structureMat = src.district === 'downtown' ? MAT.steel : MAT.reinforcedConcrete;
  }

  get end() {
    return this.base + this.count;
  }

  // --- ids ------------------------------------------------------------------------------------

  colId(f: number, a: number, b: number) {
    return this.colBase + (f * this.ncz + b) * this.ncx + a;
  }
  slabId(f: number, i: number, j: number) {
    return this.slabBase + (f * (this.ncz - 1) + j) * (this.ncx - 1) + i;
  }
  panelId(s: number, f: number, k: number) {
    return this.panelBase + f * this.panelsPerFloor + this.sideOffset[s]! + k;
  }
  roofId(r: number) {
    return this.roofBase + r;
  }

  /** Facade side of a panel (0 = -z, 1 = +x, 2 = +z, 3 = -x); 0 for non-panels. */
  panelSide(id: number) {
    if (id < this.panelBase || id >= this.roofBase) return 0;
    const q = (id - this.panelBase) % this.panelsPerFloor;
    const so = this.sideOffset;
    return q < so[1]! ? 0 : q < so[2]! ? 1 : q < so[3]! ? 2 : 3;
  }

  /** Story a piece belongs to (roof pieces: the top story). */
  floorOf(id: number) {
    if (id < this.slabBase) return Math.floor((id - this.colBase) / (this.ncx * this.ncz));
    if (id < this.panelBase)
      return Math.floor((id - this.slabBase) / ((this.ncx - 1) * (this.ncz - 1)));
    if (id < this.roofBase) return Math.floor((id - this.panelBase) / this.panelsPerFloor);
    return this.floors - 1;
  }

  // --- generation ---------------------------------------------------------------------------

  /** Writes every piece of this building into the store. */
  fill(store: PieceStore, mats: MaterialStats, matNames: readonly string[], seed: number) {
    const p = this.p;
    const H = p.floorHeight;
    const st = p.slabThickness;
    const cs = p.columnSize / 2;
    const pt = p.panelThickness;
    const F = this.floors;
    const set = (
      id: number,
      kind: number,
      mat: number,
      x: number,
      y: number,
      z: number,
      hx: number,
      hy: number,
      hz: number,
      flags: number,
    ) => {
      store.kind[id] = kind;
      store.mat[id] = mat;
      store.state[id] = STATE.intact;
      store.flags[id] = flags;
      store.building[id] = this.id;
      store.cx[id] = x;
      store.cy[id] = y;
      store.cz[id] = z;
      store.hx[id] = hx;
      store.hy[id] = hy;
      store.hz[id] = hz;
      const m = mats[matNames[mat]!]!;
      // Bigger pieces of the same material take more to break (scaled to a 3.5 m bay panel).
      const sizeK =
        kind === KIND.column ? 1 : Math.max(0.35, Math.min(2, (hx * hy * hz * 8) / 3.7));
      store.maxHp[id] = store.hp[id] =
        m.hp * (kind === KIND.panel || kind === KIND.roof ? sizeK : 1);
      store.mass[id] = 8 * hx * hy * hz * m.density;
    };

    for (let f = 0; f < F; f++) {
      const yb = f * H;
      // Columns run from the slab below to the underside of the slab above.
      for (let b = 0; b < this.ncz; b++) {
        for (let a = 0; a < this.ncx; a++) {
          const x = clamp(this.posX[a]!, this.x0 + pt + cs, this.x1 - pt - cs);
          const z = clamp(this.posZ[b]!, this.z0 + pt + cs, this.z1 - pt - cs);
          set(
            this.colId(f, a, b),
            KIND.column,
            this.structureMat,
            x,
            yb + (H - st) / 2,
            z,
            cs,
            (H - st) / 2,
            cs,
            0,
          );
        }
      }
      // Slabs: the ceiling of story f (the top story's slab is the roof, visible from the start).
      for (let j = 0; j < this.ncz - 1; j++) {
        for (let i = 0; i < this.ncx - 1; i++) {
          const xa = this.posX[i]!;
          const xb = this.posX[i + 1]!;
          const za = this.posZ[j]!;
          const zb = this.posZ[j + 1]!;
          set(
            this.slabId(f, i, j),
            KIND.slab,
            MAT.reinforcedConcrete,
            (xa + xb) / 2,
            yb + H - st / 2,
            (za + zb) / 2,
            (xb - xa) / 2,
            st / 2,
            (zb - za) / 2,
            f === F - 1 ? FLAG.revealed : 0,
          );
        }
      }
      // Facade panels, one per bay per floor. Parking structures get low parapets instead.
      const parking = this.src.parking;
      const ph = parking ? Math.min(p.parapetHeight, H) / 2 : H / 2;
      const py = yb + ph;
      const flags = FLAG.revealed | (parking ? FLAG.parapet : 0);
      for (let s = 0; s < 4; s++) {
        const n = SIDE_ALONG_X[s] ? this.nbx : this.nbz;
        for (let k = 0; k < n; k++) {
          let x: number, z: number, hx: number, hz: number;
          if (SIDE_ALONG_X[s]) {
            x = this.x0 + (k + 0.5) * this.bwx;
            z = s === 0 ? this.z0 + pt / 2 : this.z1 - pt / 2;
            hx = this.bwx / 2;
            hz = pt / 2;
          } else {
            z = this.z0 + pt + (k + 0.5) * this.bwz;
            x = s === 1 ? this.x1 - pt / 2 : this.x0 + pt / 2;
            hx = pt / 2;
            hz = this.bwz / 2;
          }
          set(this.panelId(s, f, k), KIND.panel, this.facadeMat, x, py, z, hx, ph, hz, flags);
        }
      }
    }

    // Roof: four parapets, then equipment boxes on seeded cells.
    const top = F * H;
    const parH = p.parapetHeight / 2;
    const rng = new Rng(seed);
    for (let s = 0; s < 4; s++) {
      const id = this.roofId(s);
      if (SIDE_ALONG_X[s]) {
        const z = s === 0 ? this.z0 + pt / 2 : this.z1 - pt / 2;
        set(
          id,
          KIND.roof,
          MAT.concretePanel,
          (this.x0 + this.x1) / 2,
          top + parH,
          z,
          (this.x1 - this.x0) / 2,
          parH,
          pt / 2,
          FLAG.revealed,
        );
        this.setRoofCells(
          s,
          0,
          this.ncx - 1,
          s === 0 ? 0 : this.ncz - 2,
          s === 0 ? 1 : this.ncz - 1,
        );
      } else {
        const x = s === 1 ? this.x1 - pt / 2 : this.x0 + pt / 2;
        set(
          id,
          KIND.roof,
          MAT.concretePanel,
          x,
          top + parH,
          (this.z0 + this.z1) / 2,
          pt / 2,
          parH,
          (this.z1 - this.z0) / 2 - pt,
          FLAG.revealed,
        );
        this.setRoofCells(
          s,
          s === 1 ? this.ncx - 2 : 0,
          s === 1 ? this.ncx - 1 : 1,
          0,
          this.ncz - 1,
        );
      }
    }
    for (let r = 4; r < this.roofCount; r++) {
      const i = rng.int(0, this.ncx - 2);
      const j = rng.int(0, this.ncz - 2);
      const cxa = this.posX[i]!;
      const cxb = this.posX[i + 1]!;
      const cza = this.posZ[j]!;
      const czb = this.posZ[j + 1]!;
      const hx = Math.min((cxb - cxa) / 2 - 0.3, rng.range(1, 2.6));
      const hz = Math.min((czb - cza) / 2 - 0.3, rng.range(1, 2.6));
      const hy = rng.range(0.8, 1.8);
      set(
        this.roofId(r),
        KIND.roof,
        MAT.roofEquipment,
        rng.range(cxa + hx, Math.max(cxa + hx, cxb - hx)),
        top + hy,
        rng.range(cza + hz, Math.max(cza + hz, czb - hz)),
        Math.max(0.4, hx),
        hy,
        Math.max(0.4, hz),
        FLAG.revealed,
      );
      this.setRoofCells(r, i, i + 1, j, j + 1);
    }
  }

  private setRoofCells(r: number, i0: number, i1: number, j0: number, j1: number) {
    this.roofCells[r * 4] = Math.max(0, i0);
    this.roofCells[r * 4 + 1] = Math.max(i0 + 1, i1);
    this.roofCells[r * 4 + 2] = Math.max(0, j0);
    this.roofCells[r * 4 + 3] = Math.max(j0 + 1, j1);
  }

  // --- support graph --------------------------------------------------------------------------

  /** True for pieces that rest on the ground (foundation). */
  isGrounded(id: number) {
    if (id < this.slabBase) return id - this.colBase < this.ncx * this.ncz; // story-0 columns
    if (id >= this.panelBase && id < this.roofBase)
      return id - this.panelBase < this.panelsPerFloor;
    return false;
  }

  /**
   * Calls fn(neighbour) for every piece this one is structurally linked to (DESIGN.md §7.6).
   * Symmetric: if a lists b, b lists a.
   */
  forEachNeighbour(id: number, fn: (n: number) => void) {
    const F = this.floors;
    const ncx = this.ncx;
    const ncz = this.ncz;
    if (id < this.slabBase) {
      const r = id - this.colBase;
      const f = Math.floor(r / (ncx * ncz));
      const a = r % ncx;
      const b = Math.floor(r / ncx) % ncz;
      if (f > 0) fn(this.colId(f - 1, a, b));
      if (f < F - 1) fn(this.colId(f + 1, a, b));
      for (let j = b - 1; j <= b; j++) {
        if (j < 0 || j >= ncz - 1) continue;
        for (let i = a - 1; i <= a; i++) {
          if (i < 0 || i >= ncx - 1) continue;
          fn(this.slabId(f, i, j));
          if (f > 0) fn(this.slabId(f - 1, i, j));
        }
      }
      return;
    }
    if (id < this.panelBase) {
      const r = id - this.slabBase;
      const cells = (ncx - 1) * (ncz - 1);
      const f = Math.floor(r / cells);
      const i = r % (ncx - 1);
      const j = Math.floor(r / (ncx - 1)) % (ncz - 1);
      if (i > 0) fn(this.slabId(f, i - 1, j));
      if (i < ncx - 2) fn(this.slabId(f, i + 1, j));
      if (j > 0) fn(this.slabId(f, i, j - 1));
      if (j < ncz - 2) fn(this.slabId(f, i, j + 1));
      for (let b = j; b <= j + 1; b++) {
        for (let a = i; a <= i + 1; a++) {
          fn(this.colId(f, a, b));
          if (f < F - 1) fn(this.colId(f + 1, a, b));
        }
      }
      // Perimeter panels resting on (floor f+1) or tied into (floor f) this slab.
      if (j === 0) this.panelsOnCell(0, i, f, fn);
      if (j === ncz - 2) this.panelsOnCell(2, i, f, fn);
      if (i === ncx - 2) this.panelsOnCell(1, j, f, fn);
      if (i === 0) this.panelsOnCell(3, j, f, fn);
      if (f === F - 1) {
        for (let r2 = 0; r2 < this.roofCount; r2++) {
          const c = r2 * 4;
          if (
            i >= this.roofCells[c]! &&
            i < this.roofCells[c + 1]! &&
            j >= this.roofCells[c + 2]! &&
            j < this.roofCells[c + 3]!
          )
            fn(this.roofId(r2));
        }
      }
      return;
    }
    if (id < this.roofBase) {
      const r = id - this.panelBase;
      const f = Math.floor(r / this.panelsPerFloor);
      const q = r % this.panelsPerFloor;
      const s =
        q < this.sideOffset[1]! ? 0 : q < this.sideOffset[2]! ? 1 : q < this.sideOffset[3]! ? 2 : 3;
      const k = q - this.sideOffset[s]!;
      const n = SIDE_ALONG_X[s] ? this.nbx : this.nbz;
      if (k > 0) fn(this.panelId(s, f, k - 1));
      if (k < n - 1) fn(this.panelId(s, f, k + 1));
      if (f > 0) fn(this.panelId(s, f - 1, k));
      if (f < F - 1) fn(this.panelId(s, f + 1, k));
      const cell = SIDE_ALONG_X[s] ? this.cellOfBayX[k]! : this.cellOfBayZ[k]!;
      const [ci, cj] = this.edgeCell(s, cell);
      fn(this.slabId(f, ci, cj));
      if (f > 0) fn(this.slabId(f - 1, ci, cj));
      return;
    }
    const r2 = id - this.roofBase;
    const c = r2 * 4;
    for (let j = this.roofCells[c + 2]!; j < this.roofCells[c + 3]!; j++)
      for (let i = this.roofCells[c]!; i < this.roofCells[c + 1]!; i++)
        fn(this.slabId(F - 1, i, j));
  }

  /** Slab cell (i, j) on the perimeter of side s at position `cell` along that side. */
  private edgeCell(s: number, cell: number): [number, number] {
    if (s === 0) return [cell, 0];
    if (s === 2) return [cell, this.ncz - 2];
    if (s === 1) return [this.ncx - 2, cell];
    return [0, cell];
  }

  /** Panels of side s on floors f and f+1 whose bay falls in slab cell `cell`. */
  private panelsOnCell(s: number, cell: number, f: number, fn: (n: number) => void) {
    const along = SIDE_ALONG_X[s] ? this.linesX : this.linesZ;
    for (let k = along[cell]!; k < along[cell + 1]!; k++) {
      fn(this.panelId(s, f, k));
      if (f < this.floors - 1) fn(this.panelId(s, f + 1, k));
    }
  }

  // --- analysis -------------------------------------------------------------------------------

  /**
   * Connectivity from the ground (DESIGN.md §7.6): returns the connected groups of static pieces
   * that are no longer connected to the ground. Uses caller-provided scratch buffers sized to at
   * least `count`.
   */
  findUnsupported(store: PieceStore, mark: Uint8Array, queue: Int32Array): number[][] {
    const n = this.count;
    mark.fill(0, 0, n);
    let head = 0;
    let tail = 0;
    for (let id = this.base; id < this.end; id++) {
      if (this.isGrounded(id) && store.isStatic(id)) {
        mark[id - this.base] = 1;
        queue[tail++] = id;
      }
    }
    const visit = (nb: number) => {
      if (mark[nb - this.base] === 0 && store.isStatic(nb)) {
        mark[nb - this.base] = 1;
        queue[tail++] = nb;
      }
    };
    while (head < tail) this.forEachNeighbour(queue[head++]!, visit);

    // Everything static but unmarked is falling; group it into connected clusters.
    const groups: number[][] = [];
    for (let id = this.base; id < this.end; id++) {
      if (mark[id - this.base] !== 0 || !store.isStatic(id)) continue;
      const group: number[] = [];
      head = tail = 0;
      mark[id - this.base] = 2;
      queue[tail++] = id;
      const visitGroup = (nb: number) => {
        if (mark[nb - this.base] === 0 && store.isStatic(nb)) {
          mark[nb - this.base] = 2;
          queue[tail++] = nb;
        }
      };
      while (head < tail) {
        const cur = queue[head++]!;
        group.push(cur);
        this.forEachNeighbour(cur, visitGroup);
      }
      groups.push(group);
    }
    return groups;
  }

  /**
   * Stress (DESIGN.md §7.6): the lowest story whose surviving columns are below `minFraction` of
   * the original while there is still structure above it, or -1. Also returns which way the
   * section above would topple (toward the missing support), as a unit-ish vector and imbalance.
   */
  findOverloadedStory(
    store: PieceStore,
    minFraction: number,
    capacityOf: (id: number) => number = () => 1,
  ): { story: number; tx: number; tz: number; imbalance: number } | null {
    const per = this.ncx * this.ncz;
    for (let f = 0; f < this.floors; f++) {
      let cap = 0;
      let sx = 0;
      let sz = 0;
      for (let k = 0; k < per; k++) {
        const id = this.colBase + f * per + k;
        if (!store.isStatic(id)) continue;
        const c = capacityOf(id);
        cap += c;
        sx += store.cx[id]! * c;
        sz += store.cz[id]! * c;
      }
      if (cap >= minFraction * per) continue;
      if (!this.hasStructureAbove(store, f)) continue;
      // Topple toward the side that lost its support: away from the surviving columns' centroid.
      const mx = (this.x0 + this.x1) / 2;
      const mz = (this.z0 + this.z1) / 2;
      let tx = 0;
      let tz = 0;
      if (cap > 0) {
        tx = -(sx / cap - mx) / ((this.x1 - this.x0) / 2);
        tz = -(sz / cap - mz) / ((this.z1 - this.z0) / 2);
      }
      const imbalance = Math.min(1, Math.hypot(tx, tz));
      return { story: f, tx, tz, imbalance };
    }
    return null;
  }

  private hasStructureAbove(store: PieceStore, f: number) {
    const cells = (this.ncx - 1) * (this.ncz - 1);
    for (let k = 0; k < cells; k++) if (store.isStatic(this.slabBase + f * cells + k)) return true;
    return false;
  }

  /** Calls fn for every static piece whose box is within `r` of (x, y, z). */
  forEachInSphere(
    store: PieceStore,
    x: number,
    y: number,
    z: number,
    r: number,
    fn: (id: number) => void,
  ) {
    if (x < this.x0 - r || x > this.x1 + r || z < this.z0 - r || z > this.z1 + r) return;
    if (y < -r || y > this.height + this.p.parapetHeight + 3 + r) return;
    const H = this.p.floorHeight;
    const f0 = Math.max(0, Math.floor((y - r) / H) - 1);
    const f1 = Math.min(this.floors - 1, Math.floor((y + r) / H));
    const r2 = r * r;
    const test = (id: number) => {
      if (store.isStatic(id) && store.distSq(id, x, y, z) <= r2) fn(id);
    };
    const per = this.ncx * this.ncz;
    const cells = (this.ncx - 1) * (this.ncz - 1);
    for (let f = f0; f <= f1; f++) {
      for (let k = 0; k < per; k++) test(this.colBase + f * per + k);
      for (let k = 0; k < cells; k++) test(this.slabBase + f * cells + k);
      for (let k = 0; k < this.panelsPerFloor; k++)
        test(this.panelBase + f * this.panelsPerFloor + k);
    }
    if (f1 >= this.floors - 1) for (let k = 0; k < this.roofCount; k++) test(this.roofBase + k);
  }

  /** Static pieces whose boxes overlap the given AABB. */
  forEachInBox(
    store: PieceStore,
    minX: number,
    minY: number,
    minZ: number,
    maxX: number,
    maxY: number,
    maxZ: number,
    fn: (id: number) => void,
  ) {
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const cz = (minZ + maxZ) / 2;
    const hx = (maxX - minX) / 2;
    const hy = (maxY - minY) / 2;
    const hz = (maxZ - minZ) / 2;
    const r = Math.hypot(hx, hy, hz);
    this.forEachInSphere(store, cx, cy, cz, r, (id) => {
      if (
        Math.abs(store.cx[id]! - cx) <= store.hx[id]! + hx &&
        Math.abs(store.cy[id]! - cy) <= store.hy[id]! + hy &&
        Math.abs(store.cz[id]! - cz) <= store.hz[id]! + hz
      )
        fn(id);
    });
  }
}

/** Column lines (in bay units) every `span` bays, always including both ends. */
export function columnLines(bays: number, span: number): number[] {
  const lines: number[] = [];
  for (let l = 0; l < bays; l += Math.max(1, span)) lines.push(l);
  if (lines[lines.length - 1] !== bays) {
    // Avoid a sliver span at the end: merge a last span shorter than half a span.
    if (lines.length > 1 && bays - lines[lines.length - 1]! < span / 2)
      lines[lines.length - 1] = bays;
    else lines.push(bays);
  }
  return lines;
}

function bayToCell(bays: number, lines: number[]) {
  const out = new Int32Array(bays);
  let c = 0;
  for (let k = 0; k < bays; k++) {
    while (c < lines.length - 2 && k >= lines[c + 1]!) c++;
    out[k] = c;
  }
  return out;
}

function clamp(v: number, lo: number, hi: number) {
  return lo > hi ? (lo + hi) / 2 : Math.max(lo, Math.min(hi, v));
}
