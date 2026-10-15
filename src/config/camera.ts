import type { MetaMap } from './meta';

/** Third-person camera (DESIGN.md §5.3). */
export const camera = {
  mouseSensitivity: 0.0022,
  stickLookSpeed: 2.8,
  invertY: false,
  minPitchDeg: -82,
  maxPitchDeg: 80,
  /** Pivot height above the hero's feet (m) and over-the-shoulder offset to the right. */
  pivotHeight: 1.6,
  /** Pivot height in fast flight: higher, so you look down his back instead of at his soles. */
  pivotHeightFlight: 2.7,
  shoulderOffset: 0.6,
  /** Arm length on the ground, at cruise and at max boost (interpolated by speed). */
  distanceGround: 4.2,
  distanceCruise: 5.6,
  distanceBoost: 7,
  /** Camera lags behind at speed: seconds of velocity, capped at maxLag metres. */
  velocityLag: 0.012,
  maxLag: 2.5,
  /** Spring arm: probe radius, how fast it extends back out after a wall pulled it in. */
  probeRadius: 0.3,
  extendResponse: 4,
  /** FOV widens with speed: fovRest at rest, fovMax at boost top speed. */
  fovRest: 70,
  fovMax: 100,
  fovResponse: 4,
  /** Trauma-based shake: decay per second, max offset (m), max roll (deg), noise frequency. */
  shakeDecay: 1.4,
  shakeMaxOffset: 0.6,
  shakeMaxRollDeg: 3,
  shakeFrequency: 22,
  /** Shake scaling: trauma added per m/s of impact, and for a sonic boom. */
  shakePerImpactSpeed: 0.012,
  shakeSonicBoom: 0.85,
};

export const cameraMeta: MetaMap = {
  'camera.mouseSensitivity': { min: 0.0002, max: 0.01, step: 0.0001 },
  'camera.stickLookSpeed': { min: 0.2, max: 8, step: 0.1 },
  'camera.minPitchDeg': { min: -89, max: 0, step: 1 },
  'camera.maxPitchDeg': { min: 0, max: 89, step: 1 },
  'camera.pivotHeight': { min: 0, max: 4, step: 0.05 },
  'camera.pivotHeightFlight': { min: 0, max: 8, step: 0.05 },
  'camera.shoulderOffset': { min: -2, max: 2, step: 0.05 },
  'camera.distanceGround': { min: 1, max: 20, step: 0.1 },
  'camera.distanceCruise': { min: 1, max: 30, step: 0.1 },
  'camera.distanceBoost': { min: 1, max: 40, step: 0.1 },
  'camera.velocityLag': { min: 0, max: 0.1, step: 0.001 },
  'camera.maxLag': { min: 0, max: 20, step: 0.1 },
  'camera.probeRadius': { min: 0.05, max: 1, step: 0.01 },
  'camera.extendResponse': { min: 0.5, max: 30, step: 0.5 },
  'camera.fovRest': { min: 40, max: 110, step: 1 },
  'camera.fovMax': { min: 40, max: 130, step: 1 },
  'camera.fovResponse': { min: 0.5, max: 20, step: 0.5 },
  'camera.shakeDecay': { min: 0.1, max: 10, step: 0.1 },
  'camera.shakeMaxOffset': { min: 0, max: 3, step: 0.05 },
  'camera.shakeMaxRollDeg': { min: 0, max: 20, step: 0.5 },
  'camera.shakeFrequency': { min: 1, max: 60, step: 1 },
  'camera.shakePerImpactSpeed': { min: 0, max: 0.1, step: 0.001 },
  'camera.shakeSonicBoom': { min: 0, max: 1, step: 0.05 },
};
