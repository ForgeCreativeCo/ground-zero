import type { MetaMap } from './meta';

export const world = {
  /** City seed used when no ?seed= URL param is given. */
  defaultSeed: 1234,
  /** Ground plane size (m). The M2 city is ~750 m; leave plenty of margin. */
  groundSize: 4000,
  groundColor: '#6f6d68',
  groundRoughness: 0.92,
  /** Grid line spacing on the ground (m), for judging speed and scale. */
  gridSpacing: 10,
  gridStrength: 0.25,
  /** Scale-reference pillars (M0 helper; off now that the gray-box city gives scale). */
  showScalePillars: false,
  scalePillarHeights: [10, 50, 100, 200],
  gravity: -9.81,
};

export const worldMeta: MetaMap = {
  'world.defaultSeed': { reload: true },
  'world.groundSize': { min: 500, max: 20000, step: 100, reload: true },
  'world.groundRoughness': { min: 0, max: 1, step: 0.01 },
  'world.gridSpacing': { min: 1, max: 100, step: 1 },
  'world.gridStrength': { min: 0, max: 1, step: 0.01 },
  'world.scalePillarHeights': { hidden: true },
  'world.gravity': { min: -50, max: 0, step: 0.01 },
};
