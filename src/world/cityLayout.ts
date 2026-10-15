import { Rng } from '../core/rng';

/** Pure, seeded city layout (DESIGN.md §2). No three.js, so it is unit-tested directly. */

export type District = 'downtown' | 'mid' | 'low';
export type BlockKind = District | 'park' | 'plaza';

export interface Box {
  /** Centre x/z, footprint w (x) and d (z), height h; base at y0. */
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
  y0: number;
}

export interface Building extends Box {
  district: District;
  parking: boolean;
}

export interface CityBlock {
  i: number;
  j: number;
  x: number;
  z: number;
  kind: BlockKind;
}

export interface CityLayout {
  blocks: CityBlock[];
  buildings: Building[];
  /** Elevated highway deck and its columns. */
  highway: Box[];
  pitch: number;
  /** Half extent of the block grid (m), streets included. */
  halfExtentX: number;
  halfExtentZ: number;
}

export interface CityParams {
  blocksX: number;
  blocksZ: number;
  blockSize: number;
  streetWidth: number;
  downtownHeight: [number, number];
  midHeight: [number, number];
  lowHeight: [number, number];
  lotGap: number;
  highwayHeight: number;
  highwayWidth: number;
}

/** Sidewalk depth between the kerb and building fronts (m). */
const SETBACK = 4;

export function generateCity(seed: number, p: CityParams): CityLayout {
  const rng = new Rng(seed ^ 0x51c17);
  const pitch = p.blockSize + p.streetWidth;
  const cx = (p.blocksX - 1) / 2;
  const cz = (p.blocksZ - 1) / 2;
  const blocks: CityBlock[] = [];
  const buildings: Building[] = [];

  // Districts by ring distance from the centre: downtown core, mid-rise ring, low-rise edge.
  const ring = (i: number, j: number) => Math.max(Math.abs(i - cx), Math.abs(j - cz));
  const maxRing = Math.max(cx, cz);
  const districtOf = (i: number, j: number): District => {
    const r = ring(i, j);
    if (r < Math.max(1, maxRing * 0.34)) return 'downtown';
    if (r < Math.max(2, maxRing * 0.75)) return 'mid';
    return 'low';
  };

  // One park and one plaza on non-downtown blocks (fall back to any block on tiny grids).
  const candidates: [number, number][] = [];
  for (let i = 0; i < p.blocksX; i++)
    for (let j = 0; j < p.blocksZ; j++)
      if (districtOf(i, j) !== 'downtown') candidates.push([i, j]);
  const special = new Map<string, BlockKind>();
  if (candidates.length >= 2) {
    const park = rng.pick(candidates);
    special.set(`${park[0]},${park[1]}`, 'park');
    const rest = candidates.filter((c) => c !== park && districtOf(c[0], c[1]) === 'mid');
    const plaza = rng.pick(rest.length ? rest : candidates.filter((c) => c !== park));
    special.set(`${plaza[0]},${plaza[1]}`, 'plaza');
  }
  let parkingPlaced = false;

  for (let i = 0; i < p.blocksX; i++) {
    for (let j = 0; j < p.blocksZ; j++) {
      const x = (i - cx) * pitch;
      const z = (j - cz) * pitch;
      const district = districtOf(i, j);
      const kind = special.get(`${i},${j}`) ?? district;
      blocks.push({ i, j, x, z, kind });
      if (kind === 'park' || kind === 'plaza') continue;
      const br = rng.fork(i * 131 + j);
      const usable = p.blockSize - SETBACK * 2;
      if (district === 'downtown') {
        if (br.next() < 0.5) {
          // One big tower.
          const w = br.range(0.5, 0.75) * usable;
          const d = br.range(0.5, 0.75) * usable;
          buildings.push(tower(x, z, w, d, br.range(...p.downtownHeight), 'downtown'));
        } else {
          // Two towers split along x or z.
          const alongX = br.next() < 0.5;
          const half = (usable - p.lotGap) / 2;
          for (const s of [-1, 1]) {
            const off = s * (half + p.lotGap) * 0.5;
            const w = alongX ? half : usable * br.range(0.6, 0.9);
            const d = alongX ? usable * br.range(0.6, 0.9) : half;
            buildings.push(
              tower(
                x + (alongX ? off : 0),
                z + (alongX ? 0 : off),
                w,
                d,
                br.range(...p.downtownHeight),
                'downtown',
              ),
            );
          }
        }
      } else {
        const n = district === 'mid' ? 2 : 3;
        const lot = (usable - p.lotGap * (n - 1)) / n;
        const range = district === 'mid' ? p.midHeight : p.lowHeight;
        for (let a = 0; a < n; a++) {
          for (let b = 0; b < n; b++) {
            const lx = x - usable / 2 + lot / 2 + a * (lot + p.lotGap);
            const lz = z - usable / 2 + lot / 2 + b * (lot + p.lotGap);
            const parking = district === 'mid' && !parkingPlaced && br.next() < 0.25;
            if (parking) parkingPlaced = true;
            // Floors are ~3.5 m, so snap heights to whole floors.
            const h = parking ? 14 : snapFloors(br.range(...range));
            buildings.push({ x: lx, z: lz, w: lot, d: lot, h, y0: 0, district, parking });
          }
        }
      }
    }
  }

  const halfExtentX = (p.blocksX * pitch) / 2;
  const halfExtentZ = (p.blocksZ * pitch) / 2;

  // Elevated highway just beyond the north edge, running east-west with columns every 40 m.
  const highway: Box[] = [];
  const hz = -halfExtentZ - p.highwayWidth / 2 - 6;
  const length = halfExtentX * 2 + 120;
  const deckThickness = 1.4;
  // Deck in 40 m spans (one per column gap): long single colliders break the character controller.
  const span = 40;
  const spans = Math.ceil(length / span);
  for (let k = 0; k < spans; k++) {
    const x = -length / 2 + span * (k + 0.5);
    highway.push({ x, z: hz, w: span, d: p.highwayWidth, h: deckThickness, y0: p.highwayHeight });
  }
  for (let x = -length / 2 + 20; x <= length / 2 - 20; x += 40) {
    highway.push({ x, z: hz, w: 2.2, d: 2.2, h: p.highwayHeight, y0: 0 });
  }

  return { blocks, buildings, highway, pitch, halfExtentX, halfExtentZ };
}

function tower(
  x: number,
  z: number,
  w: number,
  d: number,
  h: number,
  district: District,
): Building {
  return { x, z, w, d, h: snapFloors(h), y0: 0, district, parking: false };
}

function snapFloors(h: number) {
  return Math.max(3.5, Math.round(h / 3.5) * 3.5);
}
