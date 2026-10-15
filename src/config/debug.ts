import type { MetaMap } from './meta';

export const debug = {
  showPerfHud: true,
  /** Detach into the free-fly debug camera (player input is ignored while on). */
  freeCamera: false,
  /** Rapier collider wireframes. */
  physicsWireframe: false,
  /** Perf HUD text refresh rate (Hz). The graph updates every frame. */
  hudRefreshHz: 4,
  /** Frames kept in the frame-time graph. */
  graphFrames: 240,
  /** Test bodies spawned per click of "Spawn test bodies". */
  testBodiesPerSpawn: 50,
  testBodySize: 1.2,
  testBodySpawnDistance: 25,
};

export const debugMeta: MetaMap = {
  'debug.hudRefreshHz': { min: 1, max: 30, step: 1 },
  'debug.graphFrames': { min: 60, max: 600, step: 10, reload: true },
  'debug.testBodiesPerSpawn': { min: 1, max: 500, step: 1 },
  'debug.testBodySize': { min: 0.2, max: 10, step: 0.1 },
  'debug.testBodySpawnDistance': { min: 5, max: 200, step: 1 },
};
