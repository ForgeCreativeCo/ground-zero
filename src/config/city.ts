import type { MetaMap } from './meta';

/** M1 gray-box city (replaced by real construction in M2). Layout per DESIGN.md §2. */
export const city = {
  blocksX: 6,
  blocksZ: 6,
  blockSize: 100,
  streetWidth: 24,
  /** Height ranges (m) by district. ~3.5 m per floor. */
  downtownHeight: [70, 175] as [number, number],
  midHeight: [21, 52] as [number, number],
  lowHeight: [7, 14] as [number, number],
  /** Gap between buildings on a shared block (m). */
  lotGap: 6,
  /** Elevated highway along the north edge. */
  highwayHeight: 9,
  highwayWidth: 22,
  facadeColor: '#9a968e',
  windowColor: '#3b4652',
  asphaltColor: '#3d3f42',
  sidewalkColor: '#8d8a84',
  parkColor: '#4d6b3a',
  plazaColor: '#b3aca0',
};

export const cityMeta: MetaMap = {
  'city.blocksX': { min: 1, max: 16, step: 1, reload: true },
  'city.blocksZ': { min: 1, max: 16, step: 1, reload: true },
  'city.blockSize': { min: 40, max: 300, step: 5, reload: true },
  'city.streetWidth': { min: 8, max: 60, step: 1, reload: true },
  'city.downtownHeight': { reload: true },
  'city.midHeight': { reload: true },
  'city.lowHeight': { reload: true },
  'city.lotGap': { min: 0, max: 30, step: 1, reload: true },
  'city.highwayHeight': { min: 4, max: 30, step: 0.5, reload: true },
  'city.highwayWidth': { min: 8, max: 50, step: 1, reload: true },
};
