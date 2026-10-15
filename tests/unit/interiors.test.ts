import { describe, expect, it } from 'vitest';
import { construction, materials } from '../../src/config/destruction';
import { BuildingModel } from '../../src/destruction/buildingModel';
import { MATERIAL_NAMES, PieceStore } from '../../src/destruction/pieces';
import { furnish } from '../../src/interiors/furnishing';
import { UNIT, UnitStore } from '../../src/interiors/units';
import type { Building } from '../../src/world/cityLayout';

function makeBuilding(id: number, over: Partial<Building> = {}) {
  const src: Building = {
    x: id * 40,
    z: 0,
    w: 24,
    d: 18,
    h: 7 * 3.5,
    y0: 0,
    district: 'mid',
    parking: false,
    ...over,
  };
  const b = new BuildingModel(id, src, 0, construction);
  b.fill(new PieceStore(b.count), materials, MATERIAL_NAMES, 42);
  return b;
}

describe('UnitStore', () => {
  const buildings = [
    makeBuilding(0),
    makeBuilding(1, { district: 'downtown', h: 12 * 3.5 }),
    makeBuilding(2, { parking: true }),
  ];
  const units = new UnitStore(buildings, 1234, 0.5, 0.5);

  it('has one unit per slab cell per floor, and ids round-trip', () => {
    let n = 0;
    for (const b of buildings) n += b.floors * (b.ncx - 1) * (b.ncz - 1);
    expect(units.count).toBe(n);
    for (let u = 0; u < units.count; u += 7) {
      const [bi, f, i, j] = units.decode(u);
      expect(units.id(bi, f, i, j)).toBe(u);
    }
    expect(units.id(0, -1, 0, 0)).toBe(-1);
    expect(units.id(0, buildings[0]!.floors, 0, 0)).toBe(-1);
  });

  it('types units by district: downtown offices over shops, parking decks', () => {
    const typesOf = (bi: number, f: number) => {
      const b = buildings[bi]!;
      const out = new Set<number>();
      for (let i = 0; i < b.ncx - 1; i++)
        for (let j = 0; j < b.ncz - 1; j++) out.add(units.type[units.id(bi, f, i, j)]!);
      return [...out];
    };
    expect(typesOf(1, 0)).toEqual([UNIT.retail]);
    expect(typesOf(1, 3)).toEqual([UNIT.office]);
    expect(typesOf(2, 2)).toEqual([UNIT.parking]);
  });

  it('is deterministic for a seed', () => {
    const again = new UnitStore(buildings, 1234, 0.5, 0.5);
    expect(Array.from(again.type)).toEqual(Array.from(units.type));
    expect(Array.from(again.seed)).toEqual(Array.from(units.seed));
  });

  it('maps every facade panel to a unit on its own floor', () => {
    const b = buildings[0]!;
    for (let p = b.panelBase; p < b.panelBase + b.panelsPerFloor * b.floors; p += 3) {
      const u = units.unitOfPanel(b, p);
      expect(u).toBeGreaterThanOrEqual(0);
      const [bi, f] = units.decode(u);
      expect(bi).toBe(0);
      expect(f).toBe(Math.floor((p - b.panelBase) / b.panelsPerFloor));
    }
  });
});

describe('furnish', () => {
  const box = { x0: 0, x1: 8, z0: 0, z1: 6, y0: 3.5, y1: 7 };

  it('fills each unit type with props inside the room', () => {
    for (const t of [UNIT.office, UNIT.apartment, UNIT.retail, UNIT.parking]) {
      const props = furnish(t, box, 0.37);
      expect(props.length).toBeGreaterThan(t === UNIT.parking ? 0 : 4);
      for (const p of props) {
        const reach = Math.hypot(p.hx, p.hz); // any yaw stays within this radius
        expect(p.x).toBeGreaterThan(box.x0 - 0.01);
        expect(p.x).toBeLessThan(box.x1 + 0.01);
        expect(p.z).toBeGreaterThan(box.z0 - 0.01);
        expect(p.z).toBeLessThan(box.z1 + 0.01);
        expect(p.y - p.hy).toBeGreaterThan(box.y0 - 0.01);
        expect(p.y + p.hy).toBeLessThan(box.y1 + 0.01);
        expect(reach).toBeLessThan(Math.max(box.x1 - box.x0, box.z1 - box.z0));
        expect(p.hp).toBeGreaterThan(0);
      }
    }
  });

  it('is deterministic for a seed and varies between seeds', () => {
    const a = furnish(UNIT.office, box, 0.25);
    expect(furnish(UNIT.office, box, 0.25)).toEqual(a);
    expect(furnish(UNIT.office, box, 0.75)).not.toEqual(a);
  });
});
