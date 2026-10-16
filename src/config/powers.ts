import type { MetaMap } from './meta';

/** Heat vision (DESIGN.md §6.2). Temperatures in °C above ambient. */
export const heatVision = {
  /** Seconds of continuous fire that fill the overheat meter. */
  maxFireTime: 8,
  /** Forced cooldown when the meter fills (s), and how fast it drains when not firing (fills/s). */
  overheatLockout: 1.6,
  coolRate: 0.35,
  /** How far the beams reach (m). */
  range: 500,
  /** The beam bores a channel this wide (radius, m): pieces within it burn too, at up to
   *  boreShare of the full beam at the centre, falling off to nothing at the edge. */
  boreRadius: 1.6,
  boreShare: 0.85,
  /** Seconds of beam on a piece to burn it through, per material (0 = instant). */
  burnTime: {
    reinforcedConcrete: 0.1,
    concretePanel: 0.06,
    brick: 0.06,
    glass: 0,
    steel: 0.14,
    roofEquipment: 0.04,
  },
  /** Temperature rise per second at the beam spot, per material. */
  heatRate: {
    reinforcedConcrete: 1400,
    concretePanel: 1500,
    brick: 1500,
    glass: 2000,
    steel: 2600,
    roofEquipment: 1800,
  },
  maxTemperature: 1600,
  /** Hot pieces cool exponentially at this rate (1/s): steel stays weak for ~20 s. */
  cooling: 0.06,
  /** Pieces glow from this temperature up (white-hot at glowFull). */
  glowStart: 350,
  glowFull: 1400,
  /** The beam keeps going through pieces into the building, up to this depth past the first hit (m). */
  penetration: 40,
  /** Share of the beam that gets through an unbroken piece (a burned-through one passes it all). */
  transmit: 0.8,
  /** A panel this hot sets the room behind it alight and scorches what's inside. */
  igniteBehindAt: 500,
  /** Damage per second to furniture right behind the beam spot. */
  propDamage: 400,
  /** Sweeping faster than this (m/s along the surface) cuts pieces in two instead of melting a hole. */
  cutMinSweep: 0.3,
  /** Width of the cut (m) between the two halves of a sliced piece. */
  cutKerf: 0.18,
  /** Re-check the structure of buildings whose steel is being heated, this often (s). */
  structureCheckInterval: 0.35,
  /** Scar decals: segment width (m), new segment every this many metres, cool-down time (s). */
  scarWidth: 0.42,
  scarSpacing: 0.3,
  scarCoolTime: 10,
  /** Sparks and molten droplets per second at the impact. */
  sparkRate: 160,
  dropletRate: 26,
  /** Beam look: core and glow radius (m), brightness (HDR, >1 blooms). */
  coreRadius: 0.05,
  glowRadius: 0.24,
  brightness: 14,
};

/** Freeze breath (DESIGN.md §6.3). */
export const freezeBreath = {
  /** Seconds of breath in a full meter, and refill rate (fills/s) when not breathing. */
  maxBreathTime: 5,
  refillRate: 0.3,
  /** An empty meter has to refill to this fraction before breathing again. */
  restartAt: 0.25,
  /** Cone length (m) and half-angle (degrees). */
  range: 24,
  coneAngleDeg: 16,
  /** Seconds of breath that freeze a piece fully. */
  freezeTime: 0.5,
  /** Frozen things thaw after this long (s). Frost fades over the last fadeTime seconds. */
  thawTime: 30,
  fadeTime: 5,
  /** Cooling of hot pieces in the cone (°C/s). */
  coolRate: 3000,
  /** Frost decals on surfaces the breath hits: one every this many seconds. */
  frostDecalInterval: 0.12,
  frostDecalSize: 2.4,
  /** Mist particles per second, their speed (m/s) and lifetime (s). */
  mistRate: 120,
  mistSpeed: 26,
  mistLife: 0.9,
};

/**
 * Energy ball (added at the user's request after M4; not in DESIGN.md): hold to charge, release to
 * throw. A full charge blows a section out of a building.
 */
export const energyBall = {
  /** Seconds of holding to reach full charge; a tap throws at least minCharge. */
  chargeTime: 1.6,
  minCharge: 0.15,
  /** Seconds between throws. */
  cooldown: 0.35,
  /** Ball radius in his hands at no charge and at full charge (m). */
  radiusMin: 0.25,
  radiusMax: 1.4,
  /** Flight speed (m/s) and range before it bursts in the air (m). */
  speed: 110,
  range: 600,
  /** Blast radius (m) at no charge and full charge. Inside coreFraction of it everything is blown apart. */
  blastRadiusMin: 4,
  blastRadiusMax: 15,
  coreFraction: 0.6,
  /** Damage at the blast centre at full charge (scales with charge^1.5), and debris launch (m/s). */
  damage: 9000,
  launch: 38,
  /** The blast front expands at this speed (m/s), spreading the work over a few frames. */
  waveSpeed: 140,
  /** Share of fragments for pieces blown apart in the core (keeps debris within budget). */
  fragmentShare: 0.5,
  /** Chance each unit in the blast catches fire. */
  ignition: 0.45,
  /** Windows shatter out to radius × this. */
  windowRadiusScale: 2.5,
  /** Ball brightness (HDR, >1 blooms). */
  brightness: 9,
};

/** Fly-through penetration at sonic speed (DESIGN.md §7.7). */
export const flyThrough = {
  enabled: true,
  /** Everything within this radius of his path is destroyed (m). */
  tunnelRadius: 1.5,
  /** Pieces within this radius take heavy blast damage (m) and this much damage at the edge of the tunnel. */
  blastRadius: 4,
  blastDamage: 900,
  /** Floor slabs are only bored through when the path is this steep (|vy| / speed). */
  slabSteepness: 0.5,
  /** Crashing to a stop carries him this far on into the building (m). */
  crashDepth: 3,
  /** Speed lost per building (fraction). */
  speedCost: 0.15,
  /** Debris speed along his velocity (fraction of his speed), plus random scatter (m/s). */
  spray: 0.38,
  scatter: 9,
  /** The exit facade blows outward within this radius (m) of where he leaves. */
  exitRadius: 4.5,
  /** Entry hitch: slow motion for this long (real seconds) at this time scale. */
  hitchTime: 0.05,
  hitchScale: 0.2,
  shake: 0.6,
  /** Structural shock: columns on the tunnelled stories take shockDamage × their max HP at the
   *  path, falling to shockDamageEdge at shockRadius (m) and beyond. Tunnelled towers often fail. */
  shockRadius: 30,
  shockDamage: 0.95,
  shockDamageEdge: 0.6,
  /** Stories above and below the tunnel that also take the shock. */
  shockStories: 1,
  /** Rooms ahead of him are furnished this many seconds before he arrives. */
  lookAhead: 0.5,
};

export const powersMeta: MetaMap = {
  'energyBall.chargeTime': { min: 0.1, max: 10, step: 0.05 },
  'energyBall.minCharge': { min: 0, max: 1, step: 0.01 },
  'energyBall.cooldown': { min: 0, max: 5, step: 0.05 },
  'energyBall.radiusMin': { min: 0.05, max: 3, step: 0.05 },
  'energyBall.radiusMax': { min: 0.1, max: 6, step: 0.05 },
  'energyBall.speed': { min: 5, max: 500, step: 1 },
  'energyBall.range': { min: 20, max: 2000, step: 10 },
  'energyBall.blastRadiusMin': { min: 0.5, max: 50, step: 0.5 },
  'energyBall.blastRadiusMax': { min: 1, max: 80, step: 0.5 },
  'energyBall.coreFraction': { min: 0, max: 1, step: 0.01 },
  'energyBall.damage': { min: 0, max: 100000, step: 100 },
  'energyBall.launch': { min: 0, max: 200, step: 1 },
  'energyBall.waveSpeed': { min: 10, max: 1000, step: 5 },
  'energyBall.fragmentShare': { min: 0.05, max: 1, step: 0.05 },
  'energyBall.ignition': { min: 0, max: 1, step: 0.01 },
  'energyBall.windowRadiusScale': { min: 1, max: 10, step: 0.1 },
  'energyBall.brightness': { min: 0.5, max: 60, step: 0.5 },
  'heatVision.maxFireTime': { min: 0.5, max: 60, step: 0.5 },
  'heatVision.overheatLockout': { min: 0, max: 10, step: 0.1 },
  'heatVision.coolRate': { min: 0.01, max: 5, step: 0.01 },
  'heatVision.range': { min: 20, max: 2000, step: 10 },
  'heatVision.boreRadius': { min: 0.05, max: 8, step: 0.05 },
  'heatVision.boreShare': { min: 0, max: 2, step: 0.01 },
  'heatVision.burnTime.reinforcedConcrete': { min: 0, max: 10, step: 0.01 },
  'heatVision.burnTime.concretePanel': { min: 0, max: 10, step: 0.01 },
  'heatVision.burnTime.brick': { min: 0, max: 10, step: 0.01 },
  'heatVision.burnTime.glass': { min: 0, max: 10, step: 0.01 },
  'heatVision.burnTime.steel': { min: 0, max: 10, step: 0.01 },
  'heatVision.burnTime.roofEquipment': { min: 0, max: 10, step: 0.01 },
  'heatVision.heatRate.reinforcedConcrete': { min: 0, max: 10000, step: 10 },
  'heatVision.heatRate.concretePanel': { min: 0, max: 10000, step: 10 },
  'heatVision.heatRate.brick': { min: 0, max: 10000, step: 10 },
  'heatVision.heatRate.glass': { min: 0, max: 10000, step: 10 },
  'heatVision.heatRate.steel': { min: 0, max: 10000, step: 10 },
  'heatVision.heatRate.roofEquipment': { min: 0, max: 10000, step: 10 },
  'heatVision.maxTemperature': { min: 100, max: 5000, step: 10 },
  'heatVision.cooling': { min: 0, max: 1, step: 0.005 },
  'heatVision.glowStart': { min: 0, max: 2000, step: 10 },
  'heatVision.glowFull': { min: 100, max: 5000, step: 10 },
  'heatVision.penetration': { min: 0, max: 200, step: 1 },
  'heatVision.transmit': { min: 0, max: 1, step: 0.01 },
  'heatVision.igniteBehindAt': { min: 0, max: 2000, step: 10 },
  'heatVision.propDamage': { min: 0, max: 5000, step: 10 },
  'heatVision.cutMinSweep': { min: 0, max: 20, step: 0.05 },
  'heatVision.cutKerf': { min: 0, max: 1, step: 0.01 },
  'heatVision.structureCheckInterval': { min: 0.05, max: 5, step: 0.05 },
  'heatVision.scarWidth': { min: 0.05, max: 3, step: 0.01 },
  'heatVision.scarSpacing': { min: 0.05, max: 3, step: 0.01 },
  'heatVision.scarCoolTime': { min: 0.5, max: 60, step: 0.5 },
  'heatVision.sparkRate': { min: 0, max: 2000, step: 5 },
  'heatVision.dropletRate': { min: 0, max: 500, step: 1 },
  'heatVision.coreRadius': { min: 0.005, max: 0.5, step: 0.005 },
  'heatVision.glowRadius': { min: 0.01, max: 1, step: 0.005 },
  'heatVision.brightness': { min: 0.5, max: 60, step: 0.5 },
  'freezeBreath.maxBreathTime': { min: 0.5, max: 60, step: 0.5 },
  'freezeBreath.refillRate': { min: 0.01, max: 5, step: 0.01 },
  'freezeBreath.restartAt': { min: 0, max: 1, step: 0.01 },
  'freezeBreath.range': { min: 2, max: 100, step: 0.5 },
  'freezeBreath.coneAngleDeg': { min: 1, max: 45, step: 0.5 },
  'freezeBreath.freezeTime': { min: 0.05, max: 5, step: 0.05 },
  'freezeBreath.thawTime': { min: 1, max: 300, step: 1 },
  'freezeBreath.fadeTime': { min: 0.5, max: 60, step: 0.5 },
  'freezeBreath.coolRate': { min: 0, max: 20000, step: 50 },
  'freezeBreath.frostDecalInterval': { min: 0.02, max: 2, step: 0.01 },
  'freezeBreath.frostDecalSize': { min: 0.2, max: 10, step: 0.1 },
  'freezeBreath.mistRate': { min: 0, max: 1000, step: 5 },
  'freezeBreath.mistSpeed': { min: 1, max: 100, step: 0.5 },
  'freezeBreath.mistLife': { min: 0.1, max: 5, step: 0.05 },
  'flyThrough.tunnelRadius': { min: 0.3, max: 10, step: 0.1 },
  'flyThrough.blastRadius': { min: 0.5, max: 20, step: 0.1 },
  'flyThrough.blastDamage': { min: 0, max: 20000, step: 10 },
  'flyThrough.slabSteepness': { min: 0, max: 1, step: 0.01 },
  'flyThrough.crashDepth': { min: 0, max: 15, step: 0.1 },
  'flyThrough.speedCost': { min: 0, max: 1, step: 0.01 },
  'flyThrough.spray': { min: 0, max: 2, step: 0.01 },
  'flyThrough.scatter': { min: 0, max: 50, step: 0.5 },
  'flyThrough.exitRadius': { min: 0, max: 20, step: 0.1 },
  'flyThrough.hitchTime': { min: 0, max: 0.5, step: 0.005 },
  'flyThrough.hitchScale': { min: 0.01, max: 1, step: 0.01 },
  'flyThrough.shake': { min: 0, max: 2, step: 0.01 },
  'flyThrough.shockRadius': { min: 0, max: 60, step: 0.5 },
  'flyThrough.shockDamage': { min: 0, max: 5, step: 0.01 },
  'flyThrough.shockDamageEdge': { min: 0, max: 5, step: 0.01 },
  'flyThrough.shockStories': { min: 0, max: 5, step: 1 },
  'flyThrough.lookAhead': { min: 0, max: 3, step: 0.05 },
};
