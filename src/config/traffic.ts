import type { MetaMap } from './meta';

/** Vehicles and traffic (DESIGN.md §7.10). */
export const traffic = {
  enabled: true,
  /** Moving cars kept around the hero (recycled out of view as he travels). */
  driving: 70,
  /** Cars parked along kerbs (persistent, placed at startup across the city). */
  parked: 120,
  /** Driving cars live within this distance of the hero (m). */
  liveRadius: 260,
  /** Vehicles are drawn up to this distance (m). */
  drawDistance: 450,
  minSpawnDistance: 60,
  /** Lane centre offsets from the street centreline (m), two lanes each way. */
  laneOffsets: [1.9, 5.4] as [number, number],
  /** Parking lane offset (m) from the street centreline. */
  parkingOffset: 9.6,
  speedLimit: 13,
  /** Intelligent-driver model: max accel, comfortable braking (m/s²), headway (s), gap (m). */
  accel: 2.4,
  brake: 4,
  headway: 1.3,
  minGap: 2.2,
  /** Traffic light cycle: green and amber seconds per direction. */
  greenTime: 14,
  amberTime: 3,
  /** Share of buses / emergency vehicles among driving traffic. */
  busShare: 0.08,
  ambulanceShare: 0.03,
  policeShare: 0.04,
  taxiShare: 0.14,
  /** Panic driving: share who abandon their car, and reckless speed multiplier for the rest. */
  abandonShare: 0.35,
  recklessSpeed: 1.8,
  /** Cars hitting each other faster than this crash (become physics wrecks) (m/s). */
  crashSpeed: 6,
  /** Hero impacts: speed (m/s) above which flying into a car crumples and launches it. */
  heroImpactSpeed: 8,
  /** Hero walking into a parked car shoves it with this speed (m/s). */
  heroShove: 7,
  /** Vehicle hit points; damage beyond them wrecks it (glass out, crumpled). */
  hp: 400,
  /** Property damage per point of vehicle damage (a ~$40k car is worth hp × this). */
  dollarsPerHp: 100,
  /** Crumple: max inward dent (m) and radius (m) per impact. */
  crumpleDepth: 0.7,
  crumpleRadius: 1.6,
  /** Fire: seconds of heat-vision on the fuel tank before it explodes; burn time of a wreck (s). */
  fuseTime: 1.6,
  burnTime: 60,
  /** Explosion blast radius (m), damage, launch. */
  explosionRadius: 9,
  explosionDamage: 260,
  explosionLaunch: 14,
  /** Frozen cars shatter into this many chunks when struck. */
  shatterChunks: 14,
  /** Wrecks with their own crumpled mesh (beyond this they keep the intact shape). */
  wreckMeshes: 60,
  /** Thrown/knocked vehicles damage buildings on impact above this speed (m/s). */
  impactDamageSpeed: 8,
  impactDamagePerSpeed: 9,
  /** Car body colour palette (paint). */
  paints: [
    '#1c1d21',
    '#e6e7e8',
    '#9da3a9',
    '#5b6066',
    '#8a1414',
    '#1d3a6b',
    '#0f4d3a',
    '#c9b38a',
    '#3b2a1f',
    '#5a6e7f',
    '#b8411f',
    '#2b2f54',
  ],
};

export const trafficMeta: MetaMap = {
  'traffic.enabled': { reload: true },
  'traffic.driving': { min: 0, max: 400, step: 1, reload: true },
  'traffic.parked': { min: 0, max: 600, step: 1, reload: true },
  'traffic.liveRadius': { min: 60, max: 800, step: 5 },
  'traffic.drawDistance': { min: 50, max: 3000, step: 10 },
  'traffic.minSpawnDistance': { min: 10, max: 300, step: 1 },
  'traffic.laneOffsets': { reload: true },
  'traffic.parkingOffset': { min: 3, max: 12, step: 0.1, reload: true },
  'traffic.speedLimit': { min: 2, max: 40, step: 0.5 },
  'traffic.accel': { min: 0.2, max: 10, step: 0.1 },
  'traffic.brake': { min: 0.5, max: 15, step: 0.1 },
  'traffic.headway': { min: 0.2, max: 4, step: 0.05 },
  'traffic.minGap': { min: 0.5, max: 10, step: 0.1 },
  'traffic.greenTime': { min: 2, max: 60, step: 0.5 },
  'traffic.amberTime': { min: 0.5, max: 10, step: 0.1 },
  'traffic.busShare': { min: 0, max: 1, step: 0.01, reload: true },
  'traffic.ambulanceShare': { min: 0, max: 1, step: 0.01, reload: true },
  'traffic.policeShare': { min: 0, max: 1, step: 0.01, reload: true },
  'traffic.taxiShare': { min: 0, max: 1, step: 0.01, reload: true },
  'traffic.abandonShare': { min: 0, max: 1, step: 0.01 },
  'traffic.recklessSpeed': { min: 1, max: 4, step: 0.05 },
  'traffic.crashSpeed': { min: 1, max: 40, step: 0.5 },
  'traffic.heroImpactSpeed': { min: 1, max: 100, step: 0.5 },
  'traffic.heroShove': { min: 0, max: 40, step: 0.5 },
  'traffic.hp': { min: 10, max: 5000, step: 10 },
  'traffic.dollarsPerHp': { min: 0, max: 10000, step: 10 },
  'traffic.crumpleDepth': { min: 0, max: 2, step: 0.01 },
  'traffic.crumpleRadius': { min: 0.2, max: 5, step: 0.05 },
  'traffic.fuseTime': { min: 0.1, max: 10, step: 0.1 },
  'traffic.burnTime': { min: 5, max: 600, step: 5 },
  'traffic.explosionRadius': { min: 1, max: 40, step: 0.5 },
  'traffic.explosionDamage': { min: 0, max: 2000, step: 10 },
  'traffic.explosionLaunch': { min: 0, max: 60, step: 0.5 },
  'traffic.shatterChunks': { min: 2, max: 60, step: 1 },
  'traffic.wreckMeshes': { min: 0, max: 300, step: 1, reload: true },
  'traffic.impactDamageSpeed': { min: 1, max: 60, step: 0.5 },
  'traffic.impactDamagePerSpeed': { min: 0, max: 100, step: 0.5 },
  'traffic.paints': { hidden: true },
};
