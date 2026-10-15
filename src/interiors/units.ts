import { hash2, Rng } from '../core/rng';
import type { BuildingModel } from '../destruction/buildingModel';

/** Unit types (DESIGN.md §7.5). */
export const UNIT = { office: 0, apartment: 1, retail: 2, parking: 3 } as const;
export type UnitType = (typeof UNIT)[keyof typeof UNIT];

/** Unit flag bits. */
export const UFLAG = {
  /** Real furniture is spawned. */
  spawned: 1,
  /** Something in it was damaged or destroyed (keeps it from despawning). */
  damaged: 2,
  /** Burned out. */
  burnt: 4,
} as const;

/**
 * Every unit in the city: one per structural cell per story (the space between two floor slabs).
 * Unit ids mirror slab cells, so a unit is found from (building, floor, cell) by arithmetic.
 * Pure data; no three.js.
 */
export class UnitStore {
  readonly count: number;
  readonly base: Int32Array;
  readonly type: Uint8Array;
  readonly flags: Uint8Array;
  /** 0..1: room seed (look and whether its lights are switched on). */
  readonly seed: Float32Array;
  /** Fire intensity 0..1, and fuel left 0..1. */
  readonly fire: Float32Array;
  readonly fuel: Float32Array;
  /** Building index per unit. */
  readonly building: Uint32Array;

  constructor(
    readonly buildings: BuildingModel[],
    seed: number,
    officeChance: number,
    retailGroundChance: number,
  ) {
    this.base = new Int32Array(buildings.length);
    let n = 0;
    buildings.forEach((b, i) => {
      this.base[i] = n;
      n += b.floors * (b.ncx - 1) * (b.ncz - 1);
    });
    this.count = n;
    this.type = new Uint8Array(n);
    this.flags = new Uint8Array(n);
    this.seed = new Float32Array(n);
    this.fire = new Float32Array(n);
    this.fuel = new Float32Array(n).fill(1);
    this.building = new Uint32Array(n);
    buildings.forEach((b, bi) => {
      const rng = new Rng(hash2(seed, bi * 7919 + 13));
      const offices =
        b.src.district === 'downtown' || (b.src.district === 'mid' && rng.next() < officeChance);
      const shopsBelow = b.src.district !== 'downtown' && rng.next() < retailGroundChance;
      const cells = (b.ncx - 1) * (b.ncz - 1);
      for (let f = 0; f < b.floors; f++) {
        for (let c = 0; c < cells; c++) {
          const u = this.base[bi]! + f * cells + c;
          this.building[u] = bi;
          this.seed[u] = rng.next();
          let t: UnitType;
          if (b.src.parking) t = UNIT.parking;
          else if (f === 0 && (shopsBelow || b.src.district === 'downtown')) t = UNIT.retail;
          else t = offices ? UNIT.office : UNIT.apartment;
          this.type[u] = t;
        }
      }
    });
  }

  /** Unit id for building bi, story f, cell (i, j); -1 if out of range. */
  id(bi: number, f: number, i: number, j: number): number {
    const b = this.buildings[bi]!;
    if (f < 0 || f >= b.floors || i < 0 || j < 0 || i >= b.ncx - 1 || j >= b.ncz - 1) return -1;
    return this.base[bi]! + (f * (b.ncz - 1) + j) * (b.ncx - 1) + i;
  }

  /** Decodes a unit id into [building, floor, i, j]. */
  decode(u: number): [number, number, number, number] {
    const bi = this.building[u]!;
    const b = this.buildings[bi]!;
    const cw = b.ncx - 1;
    const cells = cw * (b.ncz - 1);
    const r = u - this.base[bi]!;
    const f = Math.floor(r / cells);
    const c = r % cells;
    return [bi, f, c % cw, Math.floor(c / cw)];
  }

  /** The unit behind a facade panel (its floor, and the perimeter cell its bay falls in). */
  unitOfPanel(b: BuildingModel, piece: number): number {
    const r = piece - b.panelBase;
    const f = Math.floor(r / b.panelsPerFloor);
    const q = r % b.panelsPerFloor;
    const so = b.sideOffset;
    const s = q < so[1]! ? 0 : q < so[2]! ? 1 : q < so[3]! ? 2 : 3;
    const k = q - so[s]!;
    const lines = s === 0 || s === 2 ? b.linesX : b.linesZ;
    let cell = 0;
    while (cell < lines.length - 2 && k >= lines[cell + 1]!) cell++;
    const i = s === 0 || s === 2 ? cell : s === 1 ? b.ncx - 2 : 0;
    const j = s === 1 || s === 3 ? cell : s === 0 ? 0 : b.ncz - 2;
    return this.id(b.id, f, i, j);
  }

  /** World-space box of a unit: [x0, x1, y0 (floor), y1 (ceiling), z0, z1]. */
  bounds(
    u: number,
    floorHeight: number,
    slabThickness: number,
  ): [number, number, number, number, number, number] {
    const [bi, f, i, j] = this.decode(u);
    const b = this.buildings[bi]!;
    return [
      b.posX[i]!,
      b.posX[i + 1]!,
      f * floorHeight,
      (f + 1) * floorHeight - slabThickness,
      b.posZ[j]!,
      b.posZ[j + 1]!,
    ];
  }
}
