import { describe, expect, it } from 'vitest';
import { player } from '../../src/config/player';
import {
  apexHeight,
  approachSpeed,
  leapSpeed,
  resolveContact,
  rotateToward,
  speedBand,
  targetSpeed,
  turnRate,
  type Vec3,
} from '../../src/player/flightModel';

const t = player;
const dt = 1 / 60;

/** Runs approachSpeed for `seconds` toward a (possibly changing) target. */
function simulate(start: number, seconds: number, target: (time: number) => number) {
  let s = start;
  for (let i = 0; i < Math.round(seconds / dt); i++) s = approachSpeed(s, target(i * dt), dt, t);
  return s;
}

describe('speed bands (DESIGN.md §5.1)', () => {
  it('classifies hover, cruise, boost and sonic', () => {
    expect(speedBand(10, t)).toBe('hover');
    expect(speedBand(40, t)).toBe('cruise');
    expect(speedBand(90, t)).toBe('boost');
    expect(speedBand(t.sonicThreshold, t)).toBe('sonic');
  });
});

describe('hover feel', () => {
  it('reaches hover speed almost instantly', () => {
    expect(simulate(0, 0.35, () => t.hoverSpeed)).toBeGreaterThan(t.hoverSpeed * 0.95);
  });

  it('stops dead on release in the hover band', () => {
    expect(simulate(t.hoverSpeed, 0.4, () => 0)).toBe(0);
  });

  it('turns essentially instantly at hover speed', () => {
    expect(turnRate(t.hoverSpeed * 0.5, t)).toBe(t.turnRateHover);
    const dir: Vec3 = { x: 0, y: 0, z: -1 };
    for (let i = 0; i < 15; i++) rotateToward(dir, { x: 0, y: 0, z: 1 }, turnRate(10, t) * dt);
    expect(dir.z).toBeGreaterThan(0.99); // reversed within a quarter second
  });
});

describe('cruise and boost', () => {
  it('builds from hover to cruise while a direction is held', () => {
    expect(targetSpeed(true, false, 0, t)).toBe(t.hoverSpeed);
    expect(targetSpeed(true, false, t.cruiseDelay + t.cruiseBuildTime + 0.1, t)).toBe(
      t.cruiseSpeed,
    );
    expect(targetSpeed(false, false, 10, t)).toBe(0);
  });

  it('boost builds acceleration and reaches top speed within a few seconds', () => {
    const after1 = simulate(0, 1, () => t.boostSpeed);
    const after5 = simulate(0, 5, () => t.boostSpeed);
    expect(after1).toBeGreaterThan(t.hoverSpeed);
    expect(after1).toBeLessThan(t.sonicThreshold); // it builds, it doesn't teleport
    expect(after5).toBeGreaterThanOrEqual(t.boostSpeed - 1e-6);
  });

  it('brakes with momentum above hover speed', () => {
    const s = simulate(t.boostSpeed, 0.5, () => 0);
    expect(s).toBeGreaterThan(t.hoverSpeed); // not a dead stop at speed
    expect(simulate(t.boostSpeed, 4, () => 0)).toBe(0); // but it does stop
  });

  it('turns slower as speed rises (wide arcs near sonic)', () => {
    expect(turnRate(t.cruiseSpeed, t)).toBeLessThan(turnRate(t.hoverSpeed, t));
    expect(turnRate(t.sonicThreshold, t)).toBeCloseTo(t.turnRateSonic, 5);
    expect(turnRate(t.boostSpeed, t)).toBeCloseTo(t.turnRateSonic, 5);
  });
});

describe('rotateToward', () => {
  it('keeps unit length and handles opposite vectors', () => {
    const dir: Vec3 = { x: 1, y: 0, z: 0 };
    rotateToward(dir, { x: -1, y: 0, z: 0 }, 0.3);
    expect(Math.hypot(dir.x, dir.y, dir.z)).toBeCloseTo(1, 6);
    expect(dir.x).toBeCloseTo(Math.cos(0.3), 5);
  });
});

describe('leaps', () => {
  it('a tap is a hop, a full charge clears a mid-rise building', () => {
    const tap = leapSpeed(0, t.jumpSpeed, t.leapMaxSpeed, t.leapChargeTime);
    const full = leapSpeed(t.leapChargeTime, t.jumpSpeed, t.leapMaxSpeed, t.leapChargeTime);
    expect(tap).toBe(t.jumpSpeed);
    expect(apexHeight(tap, t.gravity)).toBeLessThan(3);
    expect(apexHeight(full, t.gravity)).toBeGreaterThan(52); // tallest mid-rise default
  });

  it('a full leap comes down hard enough to crater', () => {
    const full = leapSpeed(t.leapChargeTime, t.jumpSpeed, t.leapMaxSpeed, t.leapChargeTime);
    expect(full).toBeGreaterThan(t.hardLandingSpeed);
  });
});

describe('resolveContact', () => {
  it('slides along a wall at low speed', () => {
    const v: Vec3 = { x: 10, y: 0, z: -5 };
    const into = resolveContact(v, { x: 0, y: 0, z: 1 }, t.impactSpeed, t.impactBounce);
    expect(into).toBe(5);
    expect(v.z).toBeCloseTo(0);
    expect(v.x).toBe(10);
  });

  it('bounces off and scrubs speed on a slam', () => {
    const v: Vec3 = { x: 20, y: 0, z: -60 };
    const into = resolveContact(v, { x: 0, y: 0, z: 1 }, t.impactSpeed, t.impactBounce);
    expect(into).toBe(60);
    expect(v.z).toBeGreaterThan(0); // moving away from the wall
    expect(Math.abs(v.x)).toBeLessThan(20);
  });

  it('ignores surfaces he is moving away from', () => {
    const v: Vec3 = { x: 0, y: 0, z: 5 };
    expect(resolveContact(v, { x: 0, y: 0, z: 1 }, t.impactSpeed, t.impactBounce)).toBe(0);
    expect(v.z).toBe(5);
  });
});
