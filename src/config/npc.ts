import type { MetaMap } from './meta';

/** Humans (DESIGN.md §9): crowd size, LOD tiers, ambient life, panic, damage. */
export const npc = {
  enabled: true,
  /** Civilians simulated around the hero at once (recycled as he moves; corpses are separate). */
  count: 360,
  /** Civilians live within this distance of the hero; past it they are recycled ahead of him (m). */
  liveRadius: 170,
  /** Never spawn closer than this, and never inside the camera view (m). */
  minSpawnDistance: 45,
  /** Recycle at most this many per step (spreads the work). */
  recyclePerStep: 4,
  /** Share of civilians placed at benches / bus stops / building fronts rather than walking. */
  idleShare: 0.25,
  /** LOD tiers (DESIGN.md §9.3): distance limits (m) and max counts. LOD0 count = budgets.lod0Characters. */
  lod0Distance: 25,
  lod1Distance: 80,
  lod1Max: 150,
  /** Drawn at all beyond this (m); farther people are too small to matter. */
  drawDistance: 420,
  /** Characters cast shadows up to this tier (0 = LOD0 only, 1 = LOD0+1, -1 none). */
  shadowTier: 0,
  /** ±fraction of height variation (DESIGN.md §9.2: ±8%). */
  heightVariation: 0.08,
  /** Sidewalk lane offset from the kerb (m) and lateral spread of walkers. */
  laneOffset: 2.6,
  laneSpread: 0.6,
  walkSpeed: [1.15, 1.55] as [number, number],
  runSpeed: 4.2,
  panicSpeed: [5, 6.8] as [number, number],
  limpSpeed: 0.75,
  crawlSpeed: 0.35,
  turnRate: 6,
  /** Local avoidance: personal radius (m) and push strength. */
  radius: 0.35,
  separation: 4,
  /** Chance per idle walker per second to stop at a crosswalk, bench or shop front. */
  stopChance: 0.04,
  /** Panic (DESIGN.md §9.4). Notice radius of events scales with their size. */
  noticeRadiusPunch: 35,
  noticeRadiusBlast: 3.5,
  noticeRadiusMin: 25,
  noticeRadiusMax: 320,
  /** Seconds from noticing to reacting (randomised up to this). */
  reactDelay: 0.6,
  /** Seconds spent reacting (startle, point, scream) before fleeing. */
  reactTime: 1.2,
  /** Panic spreads: a fleeing person alarms others within this radius after this delay. */
  spreadRadius: 9,
  spreadDelay: 0.35,
  /** Share who freeze/cower, film, or just flee once panicking. */
  hideShare: 0.15,
  filmShare: 0.1,
  /** Fleeing people run at least this far from the threat before calming down (m). */
  fleeDistance: 140,
  /** Seconds of calm before a panicked person returns to ambient life. */
  calmTime: 25,
  /** People trip in crowds: chance per second while sprinting near others. */
  stumbleChance: 0.04,
  /** Damage: HP of a person, and the fraction of blast/punch damage they take. */
  hp: 100,
  /** Blast or punch damage above this kills outright; below, it injures (limp / crawl). */
  injureFraction: 0.35,
  /** Speed (m/s) at which a thrown person dies on landing. */
  lethalLandingSpeed: 9,
  /** Being near the hero passing at speed: knockdown radius (m) and speed (m/s); lethal above sonic. */
  heroKnockRadius: 3,
  heroKnockSpeed: 25,
  /** A punched person flies at this multiple of the punch push (m/s per unit). */
  punchLaunch: 1.6,
  /** Launch speed scale for people caught in blasts (m/s per unit of blast launch). */
  blastLaunch: 0.6,
  /** Corpses kept (DESIGN.md §9.5: ~400; oldest off-screen ones beyond fade). */
  corpseCap: 400,
  /** People per interior unit when a breach furnishes it (min, max). */
  occupantsPerUnit: [0, 3] as [number, number],
  /** Clothing tint variety: saturation and value ranges of shirts and trousers. */
  clothSaturation: [0.05, 0.7] as [number, number],
  clothValue: [0.12, 0.85] as [number, number],
  /** Skin tint range: 0 = lightest, 1 = darkest. */
  skinTone: [0, 1] as [number, number],
  /** Show the casualty counter on the HUD (DESIGN.md Appendix B: open decision). */
  showCasualties: true,
};

export const npcMeta: MetaMap = {
  'npc.enabled': { reload: true },
  'npc.count': { min: 0, max: 2000, step: 10, reload: true },
  'npc.liveRadius': { min: 60, max: 600, step: 5 },
  'npc.minSpawnDistance': { min: 5, max: 200, step: 1 },
  'npc.recyclePerStep': { min: 1, max: 50, step: 1 },
  'npc.idleShare': { min: 0, max: 1, step: 0.01, reload: true },
  'npc.lod0Distance': { min: 5, max: 100, step: 1 },
  'npc.lod1Distance': { min: 10, max: 300, step: 1 },
  'npc.lod1Max': { min: 0, max: 600, step: 5 },
  'npc.drawDistance': { min: 50, max: 1500, step: 10 },
  'npc.shadowTier': { options: { none: -1, 'LOD0 only': 0, 'LOD0+1': 1 } },
  'npc.heightVariation': { min: 0, max: 0.3, step: 0.01, reload: true },
  'npc.laneOffset': { min: 0.3, max: 4, step: 0.05 },
  'npc.laneSpread': { min: 0, max: 3, step: 0.05 },
  'npc.walkSpeed': {},
  'npc.runSpeed': { min: 1, max: 10, step: 0.1 },
  'npc.panicSpeed': {},
  'npc.limpSpeed': { min: 0.1, max: 3, step: 0.05 },
  'npc.crawlSpeed': { min: 0.05, max: 2, step: 0.05 },
  'npc.turnRate': { min: 0.5, max: 20, step: 0.1 },
  'npc.radius': { min: 0.1, max: 1, step: 0.01 },
  'npc.separation': { min: 0, max: 20, step: 0.1 },
  'npc.stopChance': { min: 0, max: 1, step: 0.005 },
  'npc.noticeRadiusPunch': { min: 0, max: 200, step: 1 },
  'npc.noticeRadiusBlast': { min: 0, max: 20, step: 0.1 },
  'npc.noticeRadiusMin': { min: 0, max: 200, step: 1 },
  'npc.noticeRadiusMax': { min: 10, max: 2000, step: 10 },
  'npc.reactDelay': { min: 0, max: 5, step: 0.05 },
  'npc.reactTime': { min: 0, max: 5, step: 0.05 },
  'npc.spreadRadius': { min: 0, max: 50, step: 0.5 },
  'npc.spreadDelay': { min: 0, max: 3, step: 0.05 },
  'npc.hideShare': { min: 0, max: 1, step: 0.01 },
  'npc.filmShare': { min: 0, max: 1, step: 0.01 },
  'npc.fleeDistance': { min: 10, max: 600, step: 5 },
  'npc.calmTime': { min: 1, max: 300, step: 1 },
  'npc.stumbleChance': { min: 0, max: 1, step: 0.005 },
  'npc.hp': { min: 1, max: 1000, step: 1 },
  'npc.injureFraction': { min: 0, max: 1, step: 0.01 },
  'npc.lethalLandingSpeed': { min: 1, max: 50, step: 0.5 },
  'npc.heroKnockRadius': { min: 0, max: 20, step: 0.1 },
  'npc.heroKnockSpeed': { min: 1, max: 200, step: 1 },
  'npc.punchLaunch': { min: 0, max: 10, step: 0.05 },
  'npc.blastLaunch': { min: 0, max: 5, step: 0.01 },
  'npc.corpseCap': { min: 0, max: 2000, step: 10 },
  'npc.occupantsPerUnit': {},
  'npc.clothSaturation': { reload: true },
  'npc.clothValue': { reload: true },
  'npc.skinTone': { reload: true },
  'npc.showCasualties': {},
};
