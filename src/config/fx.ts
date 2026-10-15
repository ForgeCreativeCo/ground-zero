import type { MetaMap } from './meta';

export const fx = {
  /** Speed lines around the camera at high speed. */
  speedLines: {
    enabled: true,
    count: 140,
    /** Speed where they start to appear and where they're fully visible. */
    startSpeed: 45,
    fullSpeed: 140,
    maxOpacity: 0.35,
  },
  /** Vapor cone around the hero near the sonic threshold. */
  vaporCone: {
    enabled: true,
    /** Visible from threshold × start to threshold × end, peaking at the threshold. */
    start: 0.85,
    end: 1.3,
    maxOpacity: 0.6,
    /** Extra flash on crossing the threshold (s). */
    flashTime: 0.6,
  },
  sonicBoom: {
    /** Shock collar that forms around him and rides along for collarFollow seconds. */
    collarRadius: 7,
    collarTime: 0.6,
    collarFollow: 0.4,
    collarStrength: 1.2,
    ringRadius: 90,
    ringTime: 0.9,
    /** Kicks up a dust ring when the boom happens this close to the ground (m). */
    groundDustAltitude: 60,
    /** Radius later systems use to shatter windows and knock people down (M2+, M5). */
    effectRadius: 60,
  },
  landing: {
    /** Crater decal radius (m) per m/s of impact above the hard-landing speed, and its cap. */
    craterBase: 2.2,
    craterPerSpeed: 0.09,
    craterMax: 14,
    shockwaveRadiusPerSpeed: 0.6,
    shockwaveTime: 0.5,
    dustPerSpeed: 1.6,
    dustMax: 160,
  },
  /** Collapse dust: the big cloud that rolls down the streets (DESIGN.md §7.6). */
  collapseDust: {
    color: '#a8a196',
    capacity: 3000,
    lifetime: 16,
    drag: 0.45,
    opacity: 0.62,
    /** Ground-level cloud particles per crushed story (scaled by the story's mass). */
    groundPerStory: 14,
    /** Mass (kg) of a story that produces the full-size cloud. */
    massForFullCloud: 400000,
    /** Outward rolling speed multiplier. */
    spread: 1,
  },
  dust: {
    color: '#a99f90',
    /** Max live dust particles (counts toward budgets.particles). */
    capacity: 2000,
    lifetime: 2.4,
    drag: 1.6,
    /** Particles closer than this to the camera (m, plus their radius) are not drawn. */
    nearCull: 1.5,
  },
};

export const fxMeta: MetaMap = {
  'fx.speedLines.count': { min: 0, max: 600, step: 10, reload: true },
  'fx.speedLines.startSpeed': { min: 0, max: 300, step: 1 },
  'fx.speedLines.fullSpeed': { min: 1, max: 600, step: 1 },
  'fx.speedLines.maxOpacity': { min: 0, max: 1, step: 0.01 },
  'fx.vaporCone.start': { min: 0.5, max: 1, step: 0.01 },
  'fx.vaporCone.end': { min: 1, max: 2, step: 0.01 },
  'fx.vaporCone.maxOpacity': { min: 0, max: 1, step: 0.01 },
  'fx.vaporCone.flashTime': { min: 0, max: 3, step: 0.05 },
  'fx.sonicBoom.collarRadius': { min: 1, max: 100, step: 0.5 },
  'fx.sonicBoom.collarTime': { min: 0.05, max: 3, step: 0.05 },
  'fx.sonicBoom.collarFollow': { min: 0, max: 3, step: 0.05 },
  'fx.sonicBoom.collarStrength': { min: 0, max: 3, step: 0.05 },
  'fx.sonicBoom.ringRadius': { min: 5, max: 400, step: 1 },
  'fx.sonicBoom.ringTime': { min: 0.1, max: 4, step: 0.05 },
  'fx.sonicBoom.groundDustAltitude': { min: 0, max: 300, step: 1 },
  'fx.sonicBoom.effectRadius': { min: 0, max: 400, step: 1 },
  'fx.landing.craterBase': { min: 0.5, max: 10, step: 0.1 },
  'fx.landing.craterPerSpeed': { min: 0, max: 1, step: 0.01 },
  'fx.landing.craterMax': { min: 1, max: 60, step: 0.5 },
  'fx.landing.shockwaveRadiusPerSpeed': { min: 0, max: 5, step: 0.05 },
  'fx.landing.shockwaveTime': { min: 0.1, max: 3, step: 0.05 },
  'fx.landing.dustPerSpeed': { min: 0, max: 10, step: 0.1 },
  'fx.landing.dustMax': { min: 0, max: 1000, step: 10 },
  'fx.collapseDust.capacity': { min: 100, max: 20000, step: 100, reload: true },
  'fx.collapseDust.lifetime': { min: 1, max: 60, step: 0.5 },
  'fx.collapseDust.drag': { min: 0, max: 5, step: 0.05 },
  'fx.collapseDust.opacity': { min: 0, max: 1, step: 0.01, reload: true },
  'fx.collapseDust.groundPerStory': { min: 0, max: 100, step: 1 },
  'fx.collapseDust.massForFullCloud': { min: 10000, max: 5000000, step: 10000 },
  'fx.collapseDust.spread': { min: 0, max: 5, step: 0.05 },
  'fx.dust.capacity': { min: 100, max: 20000, step: 100, reload: true },
  'fx.dust.lifetime': { min: 0.2, max: 10, step: 0.1 },
  'fx.dust.drag': { min: 0, max: 10, step: 0.1 },
  'fx.dust.nearCull': { min: 0, max: 10, step: 0.1 },
};
