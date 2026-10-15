import type { MetaMap } from './meta';

export const sun = {
  /** Degrees above the horizon. */
  elevationDeg: 38,
  /** Compass degrees around the vertical axis (0 = +Z, 90 = +X). */
  azimuthDeg: 135,
  intensity: 3.2,
  color: '#fff3e0',
  /** Distance of the light from its target (shadow camera placement). */
  distance: 600,
};

/** Night lighting: a dim moon, and how much ambient light survives at night. */
export const moon = {
  intensity: 0.35,
  color: '#9fb4d6',
  elevationDeg: 42,
  ambient: 0.1,
};

export const sky = {
  turbidity: 3,
  rayleigh: 1.2,
  mieCoefficient: 0.005,
  mieDirectionalG: 0.8,
  cloudCoverage: 0.35,
  cloudDensity: 0.4,
  /** Image-based lighting from the sky (PMREM). */
  envIntensity: 0.15,
  /** Min seconds between environment-map regenerations while the sun moves. */
  envRefreshInterval: 0.5,
  /** Hemisphere fill light. */
  hemiIntensity: 0.25,
  hemiSkyColor: '#bcd4ff',
  hemiGroundColor: '#5a5048',
  fogEnabled: true,
  fogColor: '#c7d3df',
  fogDensity: 0.00035,
};

export const environmentMeta: MetaMap = {
  'sun.elevationDeg': { min: -10, max: 90, step: 0.1 },
  'sun.azimuthDeg': { min: 0, max: 360, step: 0.5 },
  'sun.intensity': { min: 0, max: 10, step: 0.05 },
  'sun.distance': { min: 100, max: 3000, step: 10 },
  'moon.intensity': { min: 0, max: 3, step: 0.01 },
  'moon.elevationDeg': { min: 5, max: 90, step: 1 },
  'moon.ambient': { min: 0, max: 1, step: 0.01 },
  'sky.turbidity': { min: 0, max: 20, step: 0.1 },
  'sky.rayleigh': { min: 0, max: 4, step: 0.01 },
  'sky.mieCoefficient': { min: 0, max: 0.1, step: 0.001 },
  'sky.mieDirectionalG': { min: 0, max: 1, step: 0.01 },
  'sky.cloudCoverage': { min: 0, max: 1, step: 0.01 },
  'sky.cloudDensity': { min: 0, max: 1, step: 0.01 },
  'sky.envIntensity': { min: 0, max: 3, step: 0.01 },
  'sky.envRefreshInterval': { min: 0.05, max: 5, step: 0.05 },
  'sky.hemiIntensity': { min: 0, max: 3, step: 0.01 },
  'sky.fogDensity': { min: 0, max: 0.003, step: 0.00001 },
};
