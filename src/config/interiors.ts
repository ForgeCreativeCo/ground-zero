import type { MetaMap } from './meta';

/** Interiors (DESIGN.md §7.5): units, furnishing, window interiors, power. */
export const interiors = {
  /** Fake-room depth behind intact windows (m). */
  roomDepth: 6,
  /** Fraction of rooms lit by day and by night. */
  litDay: 0.3,
  litNight: 0.72,
  /** Brightness of lit rooms seen through windows, by day and at night. */
  windowGlowDay: 0.35,
  windowGlowNight: 2.2,
  /** Chance a mid-rise building is offices (the rest apartments); ground floors of non-towers are shops this often. */
  officeChance: 0.5,
  retailGroundChance: 0.7,
  /** Units around a breach that get real furniture (in the same floor, ± this many cells). */
  spawnNeighbours: 1,
  /** Undamaged spawned interiors farther than this from the hero are removed (m). */
  despawnDistance: 260,
  /** Furniture prop capacity (instances across all props). */
  propCapacity: 8000,
  /** Prop HP multiplier (furniture is flimsy next to the hero). */
  propHp: 1,
  /** The hero smashes through furniture and interior walls within this radius as he moves (m). */
  heroSmashRadius: 1.3,
  /** Real point lights for nearby lit rooms. Each costs shading on every surface in view, so Low
   *  has none (the window-room shader and emissive ceiling panels carry it); High has 2. */
  realLights: 0,
  lightIntensity: 25,
  lightRange: 14,
};

/** Power failure (DESIGN.md §7.5): heavy structural damage cuts the power. */
export const power = {
  /** Fraction of a building's columns destroyed that cuts its power. */
  failColumnFraction: 0.08,
  /** Floors per second the outage spreads from where the damage is. */
  spreadFloorsPerSecond: 3,
  /** Floors at the edge of the outage that flicker before going dark. */
  flickerBand: 2,
};

/** Fire and smoke (DESIGN.md §7.9). */
export const fire = {
  /** Seconds a unit's fuel lasts at full intensity (scaled by how much furniture it has). */
  burnTime: 90,
  /** Chance per second a burning unit ignites each neighbour on its floor, and the unit above. */
  spreadSideChance: 0.04,
  /** Spreading up needs a broken window or hole on the burning unit's facade. */
  spreadUpChance: 0.06,
  /** Seconds for a new fire to grow to full intensity. */
  growTime: 12,
  /** Most burning units simulated at once (spread stops beyond this). */
  maxBurning: 220,
  /** Flame particles per second per burning window at full intensity. */
  flameRate: 10,
  /** Smoke particles per second per burning window at full intensity. */
  smokeRate: 1.6,
  smokeCapacity: 3500,
  flameCapacity: 3000,
  /** Smoke rise speed (m/s) and wind drift. */
  smokeRise: 4,
  windX: 1.6,
  windZ: 0.6,
  /** Real flickering lights at the nearest fires: 0 on Low (flames and window glow carry it). */
  lights: 0,
  lightIntensity: 60,
  lightRange: 30,
  /** Heat added to columns of a burning unit (°C/s; hot steel loses strength). */
  heatRate: 4,
  /** Chance a crushed story starts fires in the units beside it. */
  collapseIgnition: 0.35,
};

export const interiorsMeta: MetaMap = {
  'interiors.roomDepth': { min: 2, max: 20, step: 0.5 },
  'interiors.litDay': { min: 0, max: 1, step: 0.01 },
  'interiors.litNight': { min: 0, max: 1, step: 0.01 },
  'interiors.windowGlowDay': { min: 0, max: 5, step: 0.05 },
  'interiors.windowGlowNight': { min: 0, max: 10, step: 0.05 },
  'interiors.officeChance': { min: 0, max: 1, step: 0.01, reload: true },
  'interiors.retailGroundChance': { min: 0, max: 1, step: 0.01, reload: true },
  'interiors.spawnNeighbours': { min: 0, max: 4, step: 1 },
  'interiors.despawnDistance': { min: 50, max: 2000, step: 10 },
  'interiors.propCapacity': { min: 1000, max: 200000, step: 1000, reload: true },
  'interiors.propHp': { min: 0.1, max: 10, step: 0.1 },
  'interiors.heroSmashRadius': { min: 0, max: 5, step: 0.05 },
  'interiors.realLights': { min: 0, max: 8, step: 1, reload: true },
  'interiors.lightIntensity': { min: 0, max: 200, step: 1 },
  'interiors.lightRange': { min: 1, max: 60, step: 1 },
  'power.failColumnFraction': { min: 0, max: 1, step: 0.01 },
  'power.spreadFloorsPerSecond': { min: 0.1, max: 30, step: 0.1 },
  'power.flickerBand': { min: 0, max: 10, step: 1 },
  'fire.burnTime': { min: 5, max: 600, step: 1 },
  'fire.spreadSideChance': { min: 0, max: 1, step: 0.005 },
  'fire.spreadUpChance': { min: 0, max: 1, step: 0.005 },
  'fire.growTime': { min: 0.5, max: 60, step: 0.5 },
  'fire.maxBurning': { min: 1, max: 2000, step: 1 },
  'fire.flameRate': { min: 0, max: 100, step: 0.5 },
  'fire.smokeRate': { min: 0, max: 20, step: 0.1 },
  'fire.smokeCapacity': { min: 100, max: 20000, step: 100, reload: true },
  'fire.flameCapacity': { min: 100, max: 20000, step: 100, reload: true },
  'fire.smokeRise': { min: 0, max: 20, step: 0.1 },
  'fire.windX': { min: -10, max: 10, step: 0.1 },
  'fire.windZ': { min: -10, max: 10, step: 0.1 },
  'fire.lights': { min: 0, max: 8, step: 1, reload: true },
  'fire.lightIntensity': { min: 0, max: 500, step: 1 },
  'fire.lightRange': { min: 1, max: 100, step: 1 },
  'fire.heatRate': { min: 0, max: 50, step: 0.5 },
  'fire.collapseIgnition': { min: 0, max: 1, step: 0.01 },
};
