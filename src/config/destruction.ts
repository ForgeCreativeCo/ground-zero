import type { MetaMap } from './meta';

/**
 * Materials (DESIGN.md §7.4). hp is per piece of that material; density in kg/m³; value is the
 * property-damage bill in dollars per m³ destroyed.
 */
export const materials = {
  reinforcedConcrete: { hp: 420, density: 2400, value: 900, dust: '#a8a399', fragments: 3 },
  concretePanel: { hp: 100, density: 2200, value: 1400, dust: '#aaa49a', fragments: 4 },
  brick: { hp: 70, density: 1900, value: 1100, dust: '#a0705a', fragments: 5 },
  glass: { hp: 6, density: 2500, value: 4200, dust: '#d6e2ea', fragments: 6 },
  steel: { hp: 300, density: 7800, value: 2600, dust: '#8d8f92', fragments: 2 },
  roofEquipment: { hp: 60, density: 600, value: 3000, dust: '#9a9a9a', fragments: 2 },
};

export type MaterialName = keyof typeof materials;

/** Building construction (DESIGN.md §7.1). */
export const construction = {
  floorHeight: 3.5,
  /** Target facade bay width (m); actual bays divide each side evenly. */
  bayWidth: 3.75,
  /** Facade bays per structural span (columns every N bays). */
  baysPerSpan: 3,
  panelThickness: 0.3,
  slabThickness: 0.35,
  columnSize: 0.7,
  /** Roof equipment boxes per building (HVAC, water tanks) and parapet height. */
  roofEquipment: 3,
  parapetHeight: 1.1,
};

/** Damage states (DESIGN.md §7.2): HP fractions where each state starts. */
export const damage = {
  crackedAt: 0.7,
  crackedHeavyAt: 0.4,
  breachedAt: 0.15,
  /** Damage beyond this multiple of max HP in one hit skips states and blows the piece out. */
  overkill: 3,
  /** Debris/thrown impacts: hit points per joule of kinetic energy at impact. */
  energyToDamage: 0.001,
  /** Radius (m) around a debris impact that shares the damage. */
  impactSpread: 1.5,
  /** Damage per m/s when the hero slams into a facade (DESIGN.md §5.4). */
  heroImpactPerSpeed: 2.2,
};

/** Structural integrity and collapse (DESIGN.md §7.6). */
export const structure = {
  /** A story fails when fewer than this fraction of its columns remain (with load above it). */
  minColumnFraction: 0.4,
  /** Columns above this HP fraction carry their full load; below it, proportionally less. */
  damagedCapacityAt: 0.7,
  /** Delayed failure window (s): creak → dust → sag → collapse. */
  failDelayMin: 2,
  failDelayMax: 8,
  /** Sag before collapse: max tilt (deg) and drop (m). */
  sagMaxDeg: 1.8,
  sagDrop: 0.35,
  /** Initial topple rate (rad/s) per unit of support imbalance (0 = centred, 1 = one-sided). */
  toppleRate: 0.6,
  /** Seconds between crushing successive stories while a falling section is in contact. */
  crushInterval: 0.08,
  /** Fraction of a falling section's speed kept after it crushes a story (pancake momentum). */
  crushMomentum: 0.75,
  /** Damage dealt to static pieces under a crushing story. */
  crushDamage: 5000,
  /** Structural checks processed per frame (each is one building). */
  checksPerFrame: 2,
  /** Collider rebuilds per frame (one building each). */
  colliderRebuildsPerFrame: 3,
  /** Clusters with this many pieces or fewer fall apart into individual debris immediately. */
  smallClusterPieces: 8,
  /** Instances per pooled falling-section mesh (a tallest-tower section is ~5k pieces). */
  clusterMeshCapacity: 8000,
  /** Pooled falling-section meshes (more simultaneous sections create meshes mid-play). */
  clusterMeshPool: 12,
};

/** Debris lifecycle (DESIGN.md §7.8). */
export const debris = {
  /** Seconds asleep before a debris body becomes static rubble. */
  settleTime: 2.5,
  /** Debris smaller than this (largest half-extent, m) never gets a rigid body: it is visual. */
  minBodySize: 0.25,
  /** Rubble at least this big (largest half-extent, m) keeps a static collider. */
  rubbleColliderSize: 0.9,
  /** Visual (non-colliding) fragments: max live count, lifetime of the small ones that fade. */
  visualCapacity: 6000,
  smallFadeTime: 4,
  /** Pieces that become rubble directly (crushed) shrink to this fraction of their size. */
  rubbleScale: 0.6,
  /** Rubble instance capacity (grows as needed). */
  rubbleInitialCapacity: 80000,
  /** Most rigid bodies created per physics step; extra fragments fly as visual debris. */
  maxNewBodiesPerStep: 40,
  /** Fragment speeds when a piece is blown out (m/s per unit of push). */
  ejectSpeed: 6,
};

/** Super strength (DESIGN.md §6.1). */
export const strength = {
  /** Max distance from his chest to what he can hit or grab (m). */
  reach: 3.6,
  punchDamage: 34,
  /** Third hit of the combo. */
  comboFinisherDamage: 55,
  /** Seconds between combo hits, and how long the combo stays open. */
  punchInterval: 0.22,
  comboWindow: 0.7,
  /** Hold the punch button this long to wind up an uppercut. */
  uppercutHold: 0.35,
  uppercutDamage: 140,
  uppercutLaunch: 38,
  /** Impulse speed given to debris and fragments by a punch (m/s). */
  punchLaunch: 14,
  /** Grab: carried objects follow this point in front of / above him. */
  holdDistance: 2.2,
  holdHeight: 1.6,
  holdFollow: 14,
  throwSpeed: 70,
  /** Seconds a thrown object counts as thrown (its impacts deal damage). */
  thrownTime: 6,
  maxGrabMass: 80000,
};

/** Ground slam and dive slam (DESIGN.md §6.4). */
export const slam = {
  radius: 14,
  damage: 260,
  /** Extra radius and damage per m/s of impact for dive slams. */
  radiusPerSpeed: 0.12,
  damagePerSpeed: 4,
  maxRadius: 40,
  /** Speed of the straight-down dive when Q is pressed in the air. */
  diveSpeed: 90,
  /** Hard landings faster than this become slams (craters, damage). */
  landingSlamSpeed: 45,
  craterRadius: 5,
  craterRadiusPerSpeed: 0.05,
  craterDepth: 1.4,
  /** Debris knocked up by a slam (m/s at the centre). */
  launch: 18,
  /** Windows shatter out to radius × this. */
  windowRadiusScale: 2.5,
  roadChunks: 10,
};

/** Sonic boom / low sonic pass effects on the city (DESIGN.md §5.3, §6.5). */
export const sonicCity = {
  /** Windows within this radius of the boom shatter. */
  boomShatterRadius: 45,
  /** While above the sonic threshold below this altitude (m), windows along the path shatter. */
  passAltitude: 45,
  passRadius: 22,
};

export const destructionMeta: MetaMap = {
  'construction.floorHeight': { reload: true },
  'construction.bayWidth': { min: 2, max: 8, step: 0.05, reload: true },
  'construction.baysPerSpan': { min: 1, max: 6, step: 1, reload: true },
  'construction.panelThickness': { min: 0.05, max: 1, step: 0.01, reload: true },
  'construction.slabThickness': { min: 0.1, max: 1, step: 0.01, reload: true },
  'construction.columnSize': { min: 0.2, max: 2, step: 0.05, reload: true },
  'construction.roofEquipment': { min: 0, max: 12, step: 1, reload: true },
  'construction.parapetHeight': { min: 0, max: 3, step: 0.05, reload: true },
  'damage.crackedAt': { min: 0, max: 1, step: 0.01 },
  'damage.crackedHeavyAt': { min: 0, max: 1, step: 0.01 },
  'damage.breachedAt': { min: 0, max: 1, step: 0.01 },
  'damage.overkill': { min: 1, max: 20, step: 0.1 },
  'damage.energyToDamage': { min: 0, max: 0.02, step: 0.0001 },
  'damage.impactSpread': { min: 0, max: 10, step: 0.1 },
  'damage.heroImpactPerSpeed': { min: 0, max: 50, step: 0.1 },
  'structure.minColumnFraction': { min: 0, max: 1, step: 0.01 },
  'structure.damagedCapacityAt': { min: 0, max: 1, step: 0.01 },
  'structure.failDelayMin': { min: 0, max: 20, step: 0.1 },
  'structure.failDelayMax': { min: 0, max: 30, step: 0.1 },
  'structure.sagMaxDeg': { min: 0, max: 15, step: 0.1 },
  'structure.sagDrop': { min: 0, max: 3, step: 0.05 },
  'structure.toppleRate': { min: 0, max: 5, step: 0.05 },
  'structure.crushInterval': { min: 0, max: 1, step: 0.01 },
  'structure.crushMomentum': { min: 0, max: 1, step: 0.01 },
  'structure.crushDamage': { min: 0, max: 50000, step: 100 },
  'structure.checksPerFrame': { min: 1, max: 20, step: 1 },
  'structure.colliderRebuildsPerFrame': { min: 1, max: 20, step: 1 },
  'structure.smallClusterPieces': { min: 0, max: 100, step: 1 },
  'structure.clusterMeshCapacity': { min: 100, max: 20000, step: 100, reload: true },
  'structure.clusterMeshPool': { min: 1, max: 20, step: 1, reload: true },
  'debris.settleTime': { min: 0.2, max: 20, step: 0.1 },
  'debris.minBodySize': { min: 0, max: 2, step: 0.05 },
  'debris.rubbleColliderSize': { min: 0, max: 5, step: 0.05 },
  'debris.visualCapacity': { min: 100, max: 50000, step: 100, reload: true },
  'debris.smallFadeTime': { min: 0.5, max: 30, step: 0.5 },
  'debris.rubbleScale': { min: 0.1, max: 1, step: 0.05 },
  'debris.rubbleInitialCapacity': { min: 1000, max: 200000, step: 1000, reload: true },
  'debris.maxNewBodiesPerStep': { min: 1, max: 500, step: 1 },
  'debris.ejectSpeed': { min: 0, max: 50, step: 0.5 },
  'strength.reach': { min: 1, max: 15, step: 0.1 },
  'strength.punchDamage': { min: 0, max: 1000, step: 1 },
  'strength.comboFinisherDamage': { min: 0, max: 2000, step: 1 },
  'strength.punchInterval': { min: 0.05, max: 1, step: 0.01 },
  'strength.comboWindow': { min: 0.1, max: 3, step: 0.05 },
  'strength.uppercutHold': { min: 0.1, max: 2, step: 0.05 },
  'strength.uppercutDamage': { min: 0, max: 5000, step: 5 },
  'strength.uppercutLaunch': { min: 0, max: 200, step: 1 },
  'strength.punchLaunch': { min: 0, max: 100, step: 0.5 },
  'strength.holdDistance': { min: 0.5, max: 10, step: 0.1 },
  'strength.holdHeight': { min: 0, max: 10, step: 0.1 },
  'strength.holdFollow': { min: 1, max: 60, step: 0.5 },
  'strength.throwSpeed': { min: 5, max: 400, step: 1 },
  'strength.thrownTime': { min: 0.5, max: 30, step: 0.5 },
  'strength.maxGrabMass': { min: 100, max: 1000000, step: 100 },
  'slam.radius': { min: 1, max: 100, step: 0.5 },
  'slam.damage': { min: 0, max: 10000, step: 5 },
  'slam.radiusPerSpeed': { min: 0, max: 1, step: 0.01 },
  'slam.damagePerSpeed': { min: 0, max: 100, step: 0.5 },
  'slam.maxRadius': { min: 1, max: 200, step: 1 },
  'slam.diveSpeed': { min: 10, max: 400, step: 1 },
  'slam.landingSlamSpeed': { min: 5, max: 300, step: 1 },
  'slam.craterRadius': { min: 0, max: 30, step: 0.5 },
  'slam.craterRadiusPerSpeed': { min: 0, max: 0.5, step: 0.005 },
  'slam.craterDepth': { min: 0, max: 5, step: 0.05 },
  'slam.launch': { min: 0, max: 100, step: 0.5 },
  'slam.windowRadiusScale': { min: 1, max: 10, step: 0.1 },
  'slam.roadChunks': { min: 0, max: 50, step: 1 },
  'sonicCity.boomShatterRadius': { min: 0, max: 300, step: 1 },
  'sonicCity.passAltitude': { min: 0, max: 300, step: 1 },
  'sonicCity.passRadius': { min: 0, max: 100, step: 1 },
};
