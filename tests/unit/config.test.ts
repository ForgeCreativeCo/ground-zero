import { describe, expect, it } from 'vitest';
import {
  applyOverrides,
  assignInPlace,
  deepClone,
  diff,
  flatten,
  getPath,
  setPath,
  type ConfigTree,
} from '../../src/config/store';
import { defaults, meta } from '../../src/config';

const sample = (): ConfigTree => ({
  sun: { elevationDeg: 38, color: '#fff' },
  render: { shadows: { enabled: true } },
  bindings: { jump: ['Space'] },
});

describe('config store', () => {
  it('gets and sets leaves by path', () => {
    const t = sample();
    expect(getPath(t, 'sun.elevationDeg')).toBe(38);
    expect(setPath(t, 'sun.elevationDeg', 10)).toBe(true);
    expect(getPath(t, 'sun.elevationDeg')).toBe(10);
  });

  it('rejects unknown paths and type changes', () => {
    const t = sample();
    expect(setPath(t, 'sun.nope', 1)).toBe(false);
    expect(setPath(t, 'sun.elevationDeg', 'high')).toBe(false);
    expect(setPath(t, 'render.shadows', 1)).toBe(false);
    expect(setPath(t, 'bindings.jump', ['KeyJ'])).toBe(true);
  });

  it('diffs and re-applies overrides', () => {
    const base = sample();
    const t = deepClone(base);
    setPath(t, 'sun.elevationDeg', 5);
    setPath(t, 'bindings.jump', ['KeyJ']);
    const d = diff(base, t);
    expect(d).toEqual({ 'sun.elevationDeg': 5, 'bindings.jump': ['KeyJ'] });
    const fresh = deepClone(base);
    expect(applyOverrides(fresh, { ...d, 'gone.key': 1 })).toEqual(['gone.key']);
    expect(diff(base, fresh)).toEqual(d);
  });

  it('assignInPlace keeps nested object identity (debug panel bindings)', () => {
    const t = sample();
    const sun = t.sun;
    const src = sample();
    setPath(src, 'sun.elevationDeg', 70);
    assignInPlace(t, src);
    expect(t.sun).toBe(sun);
    expect(getPath(t, 'sun.elevationDeg')).toBe(70);
  });
});

describe('game config', () => {
  it('every meta key points at a real config value', () => {
    const paths = flatten(defaults as unknown as ConfigTree);
    for (const key of Object.keys(meta)) expect(paths, key).toHaveProperty([key]);
  });

  it('meta ranges contain the default value', () => {
    const paths = flatten(defaults as unknown as ConfigTree);
    for (const [key, m] of Object.entries(meta)) {
      const v = paths[key];
      if (typeof v !== 'number') continue;
      if (m.min !== undefined) expect(v, key).toBeGreaterThanOrEqual(m.min);
      if (m.max !== undefined) expect(v, key).toBeLessThanOrEqual(m.max);
    }
  });

  it('matches the DESIGN.md §13 budgets', () => {
    expect(defaults.budgets).toMatchObject({
      activeRigidBodies: 800,
      activeRagdolls: 30,
      lod0Characters: 40,
      decals: 600,
      particles: 60000,
      shadowLights: 4,
      dynamicLights: 32,
      drawCalls: 1000,
    });
    expect(defaults.loop.stepHz).toBe(60);
  });
});
