/**
 * Pure movement math for the hero (DESIGN.md §5). Arcade, not simulation: no lift or drag,
 * no stalls. Kept free of three.js / Rapier so it can be unit-tested.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface FlightTuning {
  hoverSpeed: number;
  cruiseSpeed: number;
  boostSpeed: number;
  sonicThreshold: number;
  hoverResponse: number;
  cruiseDelay: number;
  cruiseBuildTime: number;
  cruiseAccel: number;
  boostAccel: number;
  boostAccelGrowth: number;
  brakeDecel: number;
  turnRateHover: number;
  turnRateCruise: number;
  turnRateSonic: number;
}

export type SpeedBand = 'hover' | 'cruise' | 'boost' | 'sonic';

export function speedBand(speed: number, t: FlightTuning): SpeedBand {
  if (speed >= t.sonicThreshold) return 'sonic';
  if (speed > t.cruiseSpeed + 1) return 'boost';
  if (speed > t.hoverSpeed + 1) return 'cruise';
  return 'hover';
}

export function smoothstep(e0: number, e1: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/**
 * Speed the hero is trying to reach.
 * - No input: 0 (hover stops dead; above hover speed he brakes with momentum).
 * - Input: hover speed, building toward cruise after holding a direction for a moment.
 * - Boost: boost speed.
 */
export function targetSpeed(
  hasInput: boolean,
  boosting: boolean,
  inputHeldTime: number,
  t: FlightTuning,
): number {
  if (boosting) return t.boostSpeed;
  if (!hasInput) return 0;
  const build = smoothstep(t.cruiseDelay, t.cruiseDelay + t.cruiseBuildTime, inputHeldTime);
  return t.hoverSpeed + (t.cruiseSpeed - t.hoverSpeed) * build;
}

/** Moves `speed` toward `target` for one step using the band-appropriate acceleration. */
export function approachSpeed(speed: number, target: number, dt: number, t: FlightTuning): number {
  if (target > speed) {
    if (speed < t.hoverSpeed) {
      // Hover band: near-instant exponential response (no inertia fighting the player).
      // Beyond hover speed, cruise/boost acceleration takes over on the next step.
      const cap = Math.min(target, t.hoverSpeed);
      const next = speed + (cap - speed) * (1 - Math.exp(-t.hoverResponse * dt));
      return cap - next < 0.25 ? cap : next;
    }
    // Above hover: boost acceleration builds as he goes faster.
    const boosting = target > t.cruiseSpeed + 1e-6;
    const accel = boosting
      ? t.boostAccel * (1 + (t.boostAccelGrowth - 1) * Math.min(1, speed / t.boostSpeed))
      : t.cruiseAccel;
    return Math.min(target, speed + accel * dt);
  }
  if (speed <= t.hoverSpeed + 1e-6) {
    // Inside the hover band: stop dead. Exponential for the snap, plus a linear floor so the
    // tail doesn't drift (an exponential alone never quite reaches zero).
    const exp = speed + (target - speed) * (1 - Math.exp(-t.hoverResponse * dt));
    const floor = t.hoverSpeed * t.hoverResponse * 0.25 * dt;
    return Math.max(target, Math.min(exp, speed - floor));
  }
  // Momentum: linear braking above hover speed, then hand off to the hover response.
  return Math.max(target, speed - t.brakeDecel * dt);
}

/** Turn rate (rad/s) by speed: instant in hover, wide arcs near sonic. */
export function turnRate(speed: number, t: FlightTuning): number {
  if (speed <= t.hoverSpeed) return t.turnRateHover;
  if (speed <= t.cruiseSpeed) {
    const k = (speed - t.hoverSpeed) / Math.max(1e-6, t.cruiseSpeed - t.hoverSpeed);
    return lerp(t.turnRateHover, t.turnRateCruise, smoothstep(0, 1, k));
  }
  const k = (speed - t.cruiseSpeed) / Math.max(1e-6, t.sonicThreshold - t.cruiseSpeed);
  return lerp(t.turnRateCruise, t.turnRateSonic, smoothstep(0, 1, k));
}

/**
 * Rotates unit vector `dir` toward unit vector `wish` by at most `maxAngle` radians (in place).
 * Returns the angle actually turned.
 */
export function rotateToward(dir: Vec3, wish: Vec3, maxAngle: number): number {
  const dot = Math.min(1, Math.max(-1, dir.x * wish.x + dir.y * wish.y + dir.z * wish.z));
  const angle = Math.acos(dot);
  if (angle < 1e-6) return 0;
  if (angle <= maxAngle) {
    dir.x = wish.x;
    dir.y = wish.y;
    dir.z = wish.z;
    return angle;
  }
  // Rotate in the plane of dir and wish. For opposite vectors pick a stable perpendicular.
  let px = wish.x - dir.x * dot;
  let py = wish.y - dir.y * dot;
  let pz = wish.z - dir.z * dot;
  let pl = Math.hypot(px, py, pz);
  if (pl < 1e-6) {
    // Opposite: turn via world up, or via x if dir is vertical.
    if (Math.abs(dir.y) < 0.9) {
      px = -dir.x * dir.y;
      py = 1 - dir.y * dir.y;
      pz = -dir.z * dir.y;
    } else {
      px = 1 - dir.x * dir.x;
      py = -dir.y * dir.x;
      pz = -dir.z * dir.x;
    }
    pl = Math.hypot(px, py, pz);
  }
  px /= pl;
  py /= pl;
  pz /= pl;
  const c = Math.cos(maxAngle);
  const s = Math.sin(maxAngle);
  dir.x = dir.x * c + px * s;
  dir.y = dir.y * c + py * s;
  dir.z = dir.z * c + pz * s;
  const l = Math.hypot(dir.x, dir.y, dir.z);
  dir.x /= l;
  dir.y /= l;
  dir.z /= l;
  return maxAngle;
}

/** Leap launch speed for a charge time (tap = jumpSpeed, full charge = leapMaxSpeed). */
export function leapSpeed(charge: number, jumpSpeed: number, leapMax: number, chargeTime: number) {
  const k = smoothstep(0, 1, Math.min(1, charge / Math.max(1e-6, chargeTime)));
  return jumpSpeed + (leapMax - jumpSpeed) * k;
}

/** Peak height of a vertical launch at `v` m/s under gravity `g` (negative). */
export function apexHeight(v: number, g: number) {
  return (v * v) / (2 * -g);
}

/**
 * Removes the into-surface part of a velocity on contact. Returns the impact speed (m/s into the
 * surface). If it exceeds `impactSpeed`, the velocity bounces with `bounce` instead of sliding.
 * `n` is the surface normal pointing toward the hero.
 */
export function resolveContact(v: Vec3, n: Vec3, impactSpeed: number, bounce: number): number {
  const into = -(v.x * n.x + v.y * n.y + v.z * n.z);
  if (into <= 0) return 0;
  const k = into > impactSpeed ? 1 + bounce : 1;
  v.x += n.x * into * k;
  v.y += n.y * into * k;
  v.z += n.z * into * k;
  if (into > impactSpeed) {
    // A slam also scrubs most of the sliding speed.
    const keep = 0.35;
    const tx = v.x - n.x * (v.x * n.x + v.y * n.y + v.z * n.z);
    const ty = v.y - n.y * (v.x * n.x + v.y * n.y + v.z * n.z);
    const tz = v.z - n.z * (v.x * n.x + v.y * n.y + v.z * n.z);
    const bn = v.x * n.x + v.y * n.y + v.z * n.z;
    v.x = tx * keep + n.x * bn;
    v.y = ty * keep + n.y * bn;
    v.z = tz * keep + n.z * bn;
  }
  return into;
}

export function lerp(a: number, b: number, k: number) {
  return a + (b - a) * k;
}
