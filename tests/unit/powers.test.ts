import { describe, expect, it } from 'vitest';
import { city } from '../../src/config/city';
import { construction, materials } from '../../src/config/destruction';
import {
  closestOnSegment,
  cutAxis,
  inCone,
  rayBox,
  segmentBoxDistSq,
  type RayBoxHit,
} from '../../src/core/geom';
import { CityStructure } from '../../src/destruction/cityStructure';
import { BreathMeter, OverheatMeter } from '../../src/powers/meters';
import { generateCity } from '../../src/world/cityLayout';

const hit = (): RayBoxHit => ({ tEnter: 0, tExit: 0, axis: -1, sign: 0 });

describe('power meters', () => {
  it('heat vision overheats after maxFireTime, locks out, then cools', () => {
    const m = new OverheatMeter();
    let steps = 0;
    while (!m.locked && steps < 1000) {
      m.update(true, 1 / 60, 8, 1.5, 0.5);
      steps++;
    }
    // About 8 s of continuous fire (to within a step of float rounding).
    expect(Math.abs(steps - 480)).toBeLessThanOrEqual(1);
    // Locked out: holding the button does nothing for the lockout time.
    for (let i = 0; i < 60; i++) expect(m.update(true, 1 / 60, 8, 1.5, 0.5)).toBe(false);
    for (let i = 0; i < 40; i++) m.update(false, 1 / 60, 8, 1.5, 0.5);
    expect(m.locked).toBe(false);
    // Released: it drains.
    for (let i = 0; i < 60; i++) m.update(false, 1 / 60, 8, 1.5, 0.5);
    expect(m.level).toBeLessThan(0.6);
    expect(m.update(true, 1 / 60, 8, 1.5, 0.5)).toBe(true);
  });

  it('freeze breath empties, then has to refill before breathing again', () => {
    const m = new BreathMeter();
    let t = 0;
    while (m.update(true, 0.1, 5, 0.3, 0.25)) t += 0.1;
    expect(t).toBeCloseTo(5, 1);
    expect(m.exhausted).toBe(true);
    // Still holding: nothing until it has refilled to restartAt.
    for (let i = 0; i < 5; i++) expect(m.update(true, 0.1, 5, 0.3, 0.25)).toBe(false);
    for (let i = 0; i < 9; i++) m.update(false, 0.1, 5, 0.3, 0.25);
    expect(m.update(true, 0.1, 5, 0.3, 0.25)).toBe(true);
  });
});

describe('geometry helpers', () => {
  it('ray/box: entry distance, entry face and misses', () => {
    const h = hit();
    // Box centred at x = 10, ray along +x from the origin.
    expect(rayBox(0, 0, 0, 1, 0, 0, 10, 0, 0, 1, 1, 1, h)).toBe(true);
    expect(h.tEnter).toBeCloseTo(9);
    expect(h.tExit).toBeCloseTo(11);
    expect(h.axis).toBe(0);
    expect(h.sign).toBe(-1); // enters through the -x face
    expect(rayBox(20, 0, 0, -1, 0, 0, 10, 0, 0, 1, 1, 1, h)).toBe(true);
    expect(h.sign).toBe(1);
    expect(rayBox(0, 5, 0, 1, 0, 0, 10, 0, 0, 1, 1, 1, h)).toBe(false); // passes above
    expect(rayBox(0, 0, 0, -1, 0, 0, 10, 0, 0, 1, 1, 1, h)).toBe(false); // behind
    expect(rayBox(10, 0, 0, 0, 1, 0, 10, 0, 0, 1, 1, 1, h)).toBe(true); // starts inside
    expect(h.tEnter).toBeLessThan(0);
  });

  it('segment/box distance', () => {
    expect(closestOnSegment(0, 0, 0, 10, 0, 0, 5, 3, 0)).toBeCloseTo(0.5);
    // A facade panel the path crosses: touching.
    expect(segmentBoxDistSq(0, 1, -2, 0, 1, 2, 0, 1, 0, 2, 1.75, 0.15)).toBe(0);
    // A column 3 m to the side of the path.
    expect(segmentBoxDistSq(0, 1, -5, 0, 1, 5, 3.35, 1, 0, 0.35, 1.75, 0.35)).toBeCloseTo(9);
    // A long slab under the path: vertical gap only.
    expect(segmentBoxDistSq(-5, 2, 0, 5, 2, 0, 0, 0, 0, 20, 0.2, 20)).toBeCloseTo(1.8 * 1.8);
  });

  it('cut axis follows the sweep and never cuts a panel through its thickness', () => {
    // Facade panel in the xy plane (thin in z), beam along +z.
    // Horizontal sweep -> the cut plane is horizontal -> split top/bottom (y).
    expect(cutAxis(0, 0, 1, 1, 0, 0, 1.9, 1.75, 0.15)).toBe(1);
    // Vertical sweep -> split left/right (x).
    expect(cutAxis(0, 0, 1, 0, 1, 0, 1.9, 1.75, 0.15)).toBe(0);
    // A column (tall, thin in x and z) swept horizontally: cut across its height.
    expect(cutAxis(1, 0, 0, 0, 0, 1, 0.35, 1.75, 0.35)).toBe(1);
    // No sweep: no plane.
    expect(cutAxis(0, 0, 1, 0, 0, 1, 1, 1, 1)).toBe(-1);
  });

  it('cone containment', () => {
    const cos = Math.cos((15 * Math.PI) / 180);
    expect(inCone(0, 0, 0, 0, 0, 1, cos, 20, 0, 0, 10)).toBe(true);
    expect(inCone(0, 0, 0, 0, 0, 1, cos, 20, 2, 0, 10)).toBe(true); // ~11°
    expect(inCone(0, 0, 0, 0, 0, 1, cos, 20, 5, 0, 10)).toBe(false); // ~27°
    expect(inCone(0, 0, 0, 0, 0, 1, cos, 20, 0, 0, 25)).toBe(false); // too far
    expect(inCone(0, 0, 0, 0, 0, 1, cos, 20, 0, 0, -1)).toBe(false); // behind
  });
});

describe('city piece queries', () => {
  const layout = generateCity(1234, city);
  const cs = new CityStructure(layout, construction, materials, 1234);

  it('the building grid finds exactly the buildings a full scan finds', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
    for (let n = 0; n < 400; n++) {
      const x = rnd() * 450;
      const z = rnd() * 450;
      const y = (rnd() + 1) * 90;
      const r = (rnd() + 1) * 30;
      const grid: number[] = [];
      cs.forEachBuildingNear(x, y, z, r, (b) => grid.push(b.id));
      const scan = cs.buildings
        .filter(
          (b) =>
            x >= b.x0 - r &&
            x <= b.x1 + r &&
            z >= b.z0 - r &&
            z <= b.z1 + r &&
            y >= -r &&
            y <= b.height + 8 + r,
        )
        .map((b) => b.id);
      expect(grid.sort((a, b) => a - b)).toEqual(scan.sort((a, b) => a - b));
    }
  });

  it('nested building queries keep their own results', () => {
    const b = cs.buildings[0]!;
    const cx = (b.x0 + b.x1) / 2;
    const cz = (b.z0 + b.z1) / 2;
    const outer: number[] = [];
    cs.forEachBuildingNear(cx, 10, cz, 60, (o) => {
      outer.push(o.id);
      cs.forEachBuildingNear(cx + 300, 10, cz + 300, 5, () => undefined);
    });
    const flat: number[] = [];
    cs.forEachBuildingNear(cx, 10, cz, 60, (o) => flat.push(o.id));
    expect(outer).toEqual(flat);
  });

  it('raycast returns the pieces along the beam nearest first, starting at the facade', () => {
    const b = cs.buildings.find((q) => q.src.district === 'mid' && q.floors >= 6)!;
    const cx = (b.x0 + b.x1) / 2;
    // Horizontal ray from 30 m south of the building, at mid-story height of floor 2.
    const y = 2 * construction.floorHeight + 1.7;
    const hits = cs.raycast(cx, y, b.z0 - 30, 0, 0, 1, 200);
    expect(hits.length).toBeGreaterThan(1);
    for (let i = 1; i < hits.length; i++) expect(hits[i]!.t).toBeGreaterThanOrEqual(hits[i - 1]!.t);
    const first = hits[0]!;
    expect(first.t).toBeCloseTo(30 - construction.panelThickness / 2, 0);
    expect(first.axis).toBe(2);
    expect(first.sign).toBe(-1); // the south face
    expect(cs.store.kind[first.id]).toBe(2); // a facade panel
  });
});
