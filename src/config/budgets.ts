import type { MetaMap } from './meta';

/** DESIGN.md §13 default budgets. Enforced at runtime by the owning systems. */
export const budgets = {
  activeRigidBodies: 800,
  activeRagdolls: 30,
  lod0Characters: 40,
  decals: 600,
  /** Share of the decal budget kept for impact craters (the rest: heat scars and frost). */
  craterDecalShare: 0.25,
  particles: 60000,
  shadowLights: 4,
  dynamicLights: 32,
  drawCalls: 1000,
  corpses: 400,
};

/** Thresholds the Playwright perf run (npm run perf) fails on. */
export const perf = {
  maxAvgFrameMs: 16.7,
  maxP95FrameMs: 25,
  /** Length of the scripted perf path (s); long enough for a tower collapse to play out. */
  runSeconds: 20,
  /** Extra test bodies the perf run spawns (0: collapse debris provides the physics load now). */
  spawnBodies: 0,
};

export const budgetsMeta: MetaMap = {
  'budgets.activeRigidBodies': { min: 50, max: 4000, step: 10 },
  'budgets.activeRagdolls': { min: 0, max: 200, step: 1 },
  'budgets.lod0Characters': { min: 0, max: 200, step: 1 },
  'budgets.decals': { min: 0, max: 5000, step: 10, reload: true },
  'budgets.craterDecalShare': { min: 0, max: 1, step: 0.01, reload: true },
  'budgets.particles': { min: 0, max: 500000, step: 1000 },
  'budgets.shadowLights': { min: 0, max: 16, step: 1 },
  'budgets.dynamicLights': { min: 0, max: 128, step: 1 },
  'budgets.drawCalls': { min: 100, max: 10000, step: 50 },
  'budgets.corpses': { min: 0, max: 2000, step: 10 },
  'perf.maxAvgFrameMs': { min: 4, max: 100, step: 0.1 },
  'perf.maxP95FrameMs': { min: 4, max: 100, step: 0.1 },
  'perf.runSeconds': { min: 2, max: 120, step: 1 },
  'perf.spawnBodies': { min: 0, max: 2000, step: 10 },
};
