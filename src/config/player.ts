import type { MetaMap } from './meta';

/** Hero movement (DESIGN.md §5). Speeds in m/s, accelerations in m/s², rates in 1/s. */
export const player = {
  height: 1.95,
  radius: 0.38,
  spawn: [0, 0, 0] as [number, number, number],

  // Ground
  walkSpeed: 6,
  runSpeed: 14,
  /** Exponential response toward the target ground velocity. */
  groundResponse: 14,
  /** Gravity for leaps and falls (heavier than real for snappy arcs). */
  gravity: -30,
  /** Tap-jump vertical speed. A full charge gives leapMaxSpeed. */
  jumpSpeed: 10,
  leapMaxSpeed: 72,
  /** Seconds of holding jump for a full-power leap. */
  leapChargeTime: 0.8,
  /** Forward speed added on a full leap (fraction of the vertical speed). */
  leapForward: 0.45,
  /** Steering response while airborne (not flying). */
  airControl: 3,
  /** Downward impact speed that counts as a hard (crouched, cratering) landing. */
  hardLandingSpeed: 22,
  /** Seconds he stays in the landing crouch after a hard landing. */
  landingRecovery: 0.35,

  // Flight bands
  hoverSpeed: 20,
  cruiseSpeed: 50,
  boostSpeed: 160,
  /** Gameplay "sound barrier" (not literal Mach 1). */
  sonicThreshold: 110,
  /** Upward speed when taking off from the ground. */
  takeoffSpeed: 14,
  /** Hover: near-instant exponential response. */
  hoverResponse: 12,
  /** Seconds of continuous forward input before speed starts building past hover. */
  cruiseDelay: 0.5,
  /** Seconds from hover to full cruise speed. */
  cruiseBuildTime: 2.0,
  cruiseAccel: 30,
  /** Boost acceleration at rest; it builds with speed (×boostAccelGrowth at top speed). */
  boostAccel: 40,
  boostAccelGrowth: 1.6,
  /** Braking when you let go above hover speed (momentum, not a dead stop). */
  brakeDecel: 70,
  verticalSpeed: 18,
  /** Turn rate (rad/s) at hover, cruise and sonic speed. Interpolated by speed. */
  turnRateHover: 14,
  turnRateCruise: 5,
  turnRateSonic: 2.2,
  /** A dive is flying faster than this, pointed steeper than diveAngleDeg below level. */
  diveMinSpeed: 40,
  diveAngleDeg: 45,
  /** Speed into a wall that counts as slamming into it (bounce + shake) rather than sliding. */
  impactSpeed: 28,
  /** Fraction of impact speed kept as bounce. */
  impactBounce: 0.25,
  /** Re-arm the sonic boom once speed drops below threshold × this. */
  sonicRearm: 0.92,

  // Collision
  /** Max distance per collision substep (m); high speeds substep so he can't tunnel. */
  maxSubstep: 0.35,
  maxSubsteps: 16,
  /** Character controller skin (m). */
  skin: 0.04,
  snapToGround: 0.3,
  /** Steps of being blocked while pushing before the unstick nudge kicks in. */
  stuckSteps: 20,

  // Body animation
  bankMaxDeg: 60,
  bankResponse: 6,
  poseResponse: 10,
};

export const playerMeta: MetaMap = {
  'player.height': { reload: true },
  'player.radius': { reload: true },
  'player.spawn': { hidden: true },
  'player.walkSpeed': { min: 1, max: 30, step: 0.5 },
  'player.runSpeed': { min: 2, max: 60, step: 0.5 },
  'player.groundResponse': { min: 1, max: 40, step: 0.5 },
  'player.gravity': { min: -100, max: -5, step: 0.5 },
  'player.jumpSpeed': { min: 2, max: 40, step: 0.5 },
  'player.leapMaxSpeed': { min: 10, max: 200, step: 1 },
  'player.leapChargeTime': { min: 0.1, max: 3, step: 0.05 },
  'player.leapForward': { min: 0, max: 2, step: 0.05 },
  'player.airControl': { min: 0, max: 20, step: 0.5 },
  'player.hardLandingSpeed': { min: 5, max: 100, step: 1 },
  'player.landingRecovery': { min: 0, max: 2, step: 0.05 },
  'player.hoverSpeed': { min: 5, max: 60, step: 1 },
  'player.cruiseSpeed': { min: 10, max: 150, step: 1 },
  'player.boostSpeed': { min: 50, max: 600, step: 5 },
  'player.sonicThreshold': { min: 30, max: 400, step: 5 },
  'player.takeoffSpeed': { min: 2, max: 60, step: 1 },
  'player.hoverResponse': { min: 1, max: 40, step: 0.5 },
  'player.cruiseDelay': { min: 0, max: 3, step: 0.05 },
  'player.cruiseBuildTime': { min: 0.1, max: 10, step: 0.1 },
  'player.cruiseAccel': { min: 5, max: 200, step: 1 },
  'player.boostAccel': { min: 5, max: 400, step: 1 },
  'player.boostAccelGrowth': { min: 0.5, max: 5, step: 0.1 },
  'player.brakeDecel': { min: 5, max: 400, step: 1 },
  'player.verticalSpeed': { min: 2, max: 80, step: 1 },
  'player.turnRateHover': { min: 1, max: 40, step: 0.5 },
  'player.turnRateCruise': { min: 0.2, max: 20, step: 0.1 },
  'player.turnRateSonic': { min: 0.1, max: 10, step: 0.05 },
  'player.diveMinSpeed': { min: 5, max: 200, step: 1 },
  'player.diveAngleDeg': { min: 10, max: 89, step: 1 },
  'player.impactSpeed': { min: 5, max: 200, step: 1 },
  'player.impactBounce': { min: 0, max: 1, step: 0.05 },
  'player.sonicRearm': { min: 0.5, max: 0.99, step: 0.01 },
  'player.maxSubstep': { min: 0.05, max: 2, step: 0.05 },
  'player.maxSubsteps': { min: 1, max: 64, step: 1 },
  'player.skin': { min: 0.005, max: 0.2, step: 0.005 },
  'player.snapToGround': { min: 0, max: 2, step: 0.05 },
  'player.stuckSteps': { min: 2, max: 240, step: 1 },
  'player.bankMaxDeg': { min: 0, max: 90, step: 1 },
  'player.bankResponse': { min: 0.5, max: 30, step: 0.5 },
  'player.poseResponse': { min: 1, max: 40, step: 0.5 },
};
