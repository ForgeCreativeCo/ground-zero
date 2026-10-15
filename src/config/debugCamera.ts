import type { MetaMap } from './meta';

/** M0 free-fly camera. The player controller replaces it in M1; photo mode (M10) reuses it. */
export const debugCamera = {
  startPosition: [0, 25, 90] as [number, number, number],
  startYawDeg: 0,
  startPitchDeg: -8,
  speed: 25,
  boostSpeed: 160,
  verticalSpeed: 20,
  /** Exponential response (1/s): higher = snappier start and stop. */
  acceleration: 10,
  /** Mouse look (radians per pixel). */
  mouseSensitivity: 0.0022,
  /** Gamepad look (radians per second at full deflection). */
  stickLookSpeed: 2.6,
  invertY: false,
  minAltitude: 0.5,
};

export const debugCameraMeta: MetaMap = {
  'debugCamera.startPosition': { hidden: true },
  'debugCamera.startYawDeg': { hidden: true },
  'debugCamera.startPitchDeg': { hidden: true },
  'debugCamera.speed': { min: 1, max: 200, step: 1 },
  'debugCamera.boostSpeed': { min: 10, max: 600, step: 1 },
  'debugCamera.verticalSpeed': { min: 1, max: 200, step: 1 },
  'debugCamera.acceleration': { min: 0.5, max: 60, step: 0.5 },
  'debugCamera.mouseSensitivity': { min: 0.0002, max: 0.01, step: 0.0001 },
  'debugCamera.stickLookSpeed': { min: 0.2, max: 8, step: 0.1 },
  'debugCamera.minAltitude': { min: 0, max: 10, step: 0.1 },
};
