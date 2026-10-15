import type { MetaMap } from './meta';

export const loop = {
  /** Fixed simulation rate (Hz). DESIGN.md §13: 60 Hz. */
  stepHz: 60,
  /** Max fixed steps per rendered frame before we drop time (prevents a spiral of death). */
  maxStepsPerFrame: 5,
  /** Clamp on real frame delta (s), e.g. after a tab switch. */
  maxFrameDt: 0.25,
  /** Global simulation time scale (debug). The slow-mo toggle (M10) will drive this too. */
  timeScale: 1,
  /** Pause the simulation (rendering and the debug camera continue). */
  paused: false,
};

export const loopMeta: MetaMap = {
  'loop.stepHz': { min: 30, max: 240, step: 1, reload: true },
  'loop.maxStepsPerFrame': { min: 1, max: 20, step: 1 },
  'loop.maxFrameDt': { min: 0.05, max: 1, step: 0.01 },
  'loop.timeScale': { min: 0, max: 4, step: 0.01 },
};
