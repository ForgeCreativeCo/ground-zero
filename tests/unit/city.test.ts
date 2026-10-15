import { describe, expect, it } from 'vitest';
import { city } from '../../src/config/city';
import { generateCity, type Box } from '../../src/world/cityLayout';

const overlaps = (a: Box, b: Box) =>
  Math.abs(a.x - b.x) * 2 < a.w + b.w - 1e-6 && Math.abs(a.z - b.z) * 2 < a.d + b.d - 1e-6;

describe('gray-box city layout', () => {
  it('is deterministic per seed and differs between seeds', () => {
    const a = generateCity(1234, city);
    const b = generateCity(1234, city);
    const c = generateCity(99, city);
    expect(a).toEqual(b);
    expect(a.buildings.map((x) => x.h)).not.toEqual(c.buildings.map((x) => x.h));
  });

  it('has every district plus one park and one plaza', () => {
    const l = generateCity(1234, city);
    const kinds = new Set(l.blocks.map((b) => b.kind));
    for (const k of ['downtown', 'mid', 'low', 'park', 'plaza'])
      expect(kinds.has(k as never)).toBe(true);
    expect(l.blocks.filter((b) => b.kind === 'park')).toHaveLength(1);
    expect(l.blocks.filter((b) => b.kind === 'plaza')).toHaveLength(1);
  });

  it('respects the height ranges (towers 20–50 floors downtown)', () => {
    const l = generateCity(1234, city);
    for (const b of l.buildings) {
      const r =
        b.district === 'downtown'
          ? city.downtownHeight
          : b.district === 'mid'
            ? city.midHeight
            : city.lowHeight;
      if (b.parking) continue;
      expect(b.h).toBeGreaterThanOrEqual(r[0] - 3.5);
      expect(b.h).toBeLessThanOrEqual(r[1] + 3.5);
    }
  });

  it('keeps streets clear: the spawn intersection and no overlapping buildings', () => {
    const l = generateCity(1234, city);
    const spawn: Box = { x: 0, z: 0, w: 4, d: 4, h: 2, y0: 0 };
    for (const b of l.buildings) expect(overlaps(b, spawn)).toBe(false);
    for (let i = 0; i < l.buildings.length; i++)
      for (let j = i + 1; j < l.buildings.length; j++)
        expect(overlaps(l.buildings[i]!, l.buildings[j]!)).toBe(false);
  });

  it('is about 750 m across with an elevated highway on one edge', () => {
    const l = generateCity(1234, city);
    expect(l.halfExtentX * 2).toBeGreaterThan(700);
    expect(l.halfExtentX * 2).toBeLessThan(800);
    const deck = l.highway.filter((h) => h.y0 > 0);
    expect(deck.length).toBeGreaterThan(5);
    for (const d of deck) expect(d.w).toBeLessThanOrEqual(40); // short spans (controller precision)
  });
});
