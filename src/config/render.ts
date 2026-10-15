import type { MetaMap } from './meta';

export type ToneMappingName = 'AgX' | 'ACES' | 'Neutral';

export const render = {
  /** Max device pixel ratio. */
  maxPixelRatio: 1,
  /** Render resolution scale applied on top of the pixel ratio. */
  resolutionScale: 1,
  /** MSAA samples for the scene pass (0 = off). */
  msaaSamples: 0,
  /** Force the WebGL2 backend instead of WebGPU. */
  forceWebGL: false,
  toneMapping: 'AgX' as ToneMappingName,
  exposure: 1.0,
  shadows: {
    enabled: true,
    /** Cascaded shadow maps (DESIGN.md §12). Off = one map following the camera (cheaper). */
    cascaded: true,
    /** Half-size (m) of the single shadow map when not cascaded. */
    extent: 150,
    mapSize: 1024,
    cascades: 2,
    maxFar: 1200,
    lightMargin: 400,
    bias: -0.0003,
    normalBias: 0.02,
    fade: true,
  },
  bloom: {
    enabled: false,
    strength: 0.15,
    radius: 0.4,
    /** HDR luminance. Keep above the sky (~3-6) so only hot emissives (beams, fire, Nova) bloom. */
    threshold: 8,
  },
  camera: {
    near: 0.1,
    far: 20000,
    fovDeg: 70,
  },
};

export const renderMeta: MetaMap = {
  'render.maxPixelRatio': { min: 0.5, max: 3, step: 0.25 },
  'render.resolutionScale': { min: 0.25, max: 2, step: 0.05 },
  'render.msaaSamples': { options: { off: 0, '4x': 4 }, reload: true },
  'render.forceWebGL': { reload: true },
  'render.toneMapping': { options: { AgX: 'AgX', ACES: 'ACES', Neutral: 'Neutral' } },
  'render.exposure': { min: 0.05, max: 4, step: 0.01 },
  'render.shadows.enabled': { reload: true },
  'render.shadows.cascaded': { reload: true },
  'render.shadows.extent': { min: 20, max: 1000, step: 5, reload: true },
  'render.shadows.mapSize': { options: { '1024': 1024, '2048': 2048, '4096': 4096 }, reload: true },
  'render.shadows.cascades': { min: 1, max: 4, step: 1, reload: true },
  'render.shadows.maxFar': { min: 100, max: 5000, step: 10, reload: true },
  'render.shadows.lightMargin': { min: 50, max: 2000, step: 10, reload: true },
  'render.shadows.bias': { min: -0.005, max: 0.005, step: 0.0001 },
  'render.shadows.normalBias': { min: 0, max: 0.2, step: 0.001 },
  'render.shadows.fade': { reload: true },
  'render.bloom.enabled': { reload: true },
  'render.bloom.strength': { min: 0, max: 3, step: 0.01 },
  'render.bloom.radius': { min: 0, max: 1, step: 0.01 },
  'render.bloom.threshold': { min: 0, max: 30, step: 0.1 },
  'render.camera.near': { min: 0.01, max: 2, step: 0.01 },
  'render.camera.far': { min: 1000, max: 100000, step: 100 },
  'render.camera.fovDeg': { min: 30, max: 120, step: 1 },
};
