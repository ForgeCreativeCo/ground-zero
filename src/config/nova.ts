import type { MetaMap } from './meta';

/** Nova blast (DESIGN.md §6.6), the nuclear power. Distances in metres, times in seconds. */
export const nova = {
  /** Property damage (dollars) that fills the charge meter from empty. Casualties add later (M5). */
  fillDollars: 60_000_000,
  /** Only fire with a full meter (off = debug: fire any time). */
  requireFullMeter: true,
  /** Seconds of holding R before it goes off; letting go earlier cancels it. */
  windupTime: 2.5,
  /** Maximum radius of the shockwave and its speed. */
  radius: 200,
  waveSpeed: 250,
  /** Zone edges as fractions of the radius (§6.6 table). */
  coreFraction: 0.25,
  blastFraction: 0.65,
  fringeFraction: 1.5,
  /** Most pieces the front processes per physics step (frame-spread; lower = smoother). */
  piecesPerStep: 450,
  /** Milliseconds of each rendered frame the front may spend breaking pieces (it lags behind the
   *  visible wave on slow machines instead of dragging the frame rate down). */
  budgetMs: 6,
  /** Blast zone: share of torn-loose pieces that fly (the rest drop straight into rubble), and their speed (m/s) at the core edge. */
  blastFlingShare: 0.15,
  blastLaunch: 70,
  /** Edge zone: share of facade panels stripped, column damage at the blast edge (× max HP, falling to 0 at the radius), chance each unit catches fire. */
  edgeStrip: 0.8,
  edgeColumnDamage: 0.9,
  edgeIgnition: 0.35,
  /** Wind-up: loose debris lifts and orbits within this radius; cracks spread to this radius. */
  orbitRadius: 45,
  crackRadius: 26,
  /** Flash: seconds of white-out, then seconds for the exposure to recover. */
  flashHold: 0.3,
  flashRecover: 1.4,
  /** Crater: radius and depth when he's at ground level (shrinks as he goes higher, gone above coreFraction × radius); minutes for its glow to cool. */
  craterRadius: 30,
  craterDepth: 6,
  craterCoolTime: 240,
  /** Mushroom cloud: height and cap radius as fractions of the radius, how long it hangs before fading, particle count. */
  cloudHeight: 1.6,
  cloudCapRadius: 0.55,
  cloudLife: 180,
  cloudParticles: 320,
  /** Ash falling around the camera afterwards (s) and its particle budget. */
  ashTime: 90,
  ashParticles: 900,
  /** Aftermath light: seconds the orange-grey cast takes to fade back to normal. */
  gradeFade: 120,
  /** Ringing ears after the blast (s). */
  tinnitus: 6,
};

export const novaMeta: MetaMap = {
  'nova.fillDollars': { min: 100_000, max: 2_000_000_000, step: 100_000 },
  'nova.windupTime': { min: 0.2, max: 10, step: 0.1 },
  'nova.radius': { min: 20, max: 1500, step: 5 },
  'nova.waveSpeed': { min: 20, max: 2000, step: 5 },
  'nova.coreFraction': { min: 0, max: 1, step: 0.01 },
  'nova.blastFraction': { min: 0, max: 1, step: 0.01 },
  'nova.fringeFraction': { min: 1, max: 3, step: 0.05 },
  'nova.piecesPerStep': { min: 20, max: 5000, step: 10 },
  'nova.budgetMs': { min: 0.5, max: 50, step: 0.5 },
  'nova.blastFlingShare': { min: 0, max: 1, step: 0.01 },
  'nova.blastLaunch': { min: 0, max: 300, step: 1 },
  'nova.edgeStrip': { min: 0, max: 1, step: 0.01 },
  'nova.edgeColumnDamage': { min: 0, max: 3, step: 0.01 },
  'nova.edgeIgnition': { min: 0, max: 1, step: 0.01 },
  'nova.orbitRadius': { min: 0, max: 200, step: 1 },
  'nova.crackRadius': { min: 0, max: 100, step: 1 },
  'nova.flashHold': { min: 0, max: 2, step: 0.05 },
  'nova.flashRecover': { min: 0.05, max: 5, step: 0.05 },
  'nova.craterRadius': { min: 0, max: 100, step: 1 },
  'nova.craterDepth': { min: 0, max: 30, step: 0.5 },
  'nova.craterCoolTime': { min: 5, max: 1200, step: 5 },
  'nova.cloudHeight': { min: 0.2, max: 5, step: 0.05 },
  'nova.cloudCapRadius': { min: 0.1, max: 2, step: 0.05 },
  'nova.cloudLife': { min: 10, max: 900, step: 5 },
  'nova.cloudParticles': { min: 50, max: 2000, step: 10, reload: true },
  'nova.ashTime': { min: 0, max: 600, step: 5 },
  'nova.ashParticles': { min: 0, max: 5000, step: 50, reload: true },
  'nova.gradeFade': { min: 5, max: 900, step: 5 },
  'nova.tinnitus': { min: 0, max: 30, step: 0.5 },
};
