import { describe, expect, it } from 'vitest';
import { construction, materials } from '../../src/config/destruction';
import { BuildingModel, columnLines } from '../../src/destruction/buildingModel';
import {
  FLAG,
  KIND,
  MATERIAL_NAMES,
  PieceStore,
  STATE,
  stateForHp,
} from '../../src/destruction/pieces';
import type { Building } from '../../src/world/cityLayout';

function makeBuilding(over: Partial<Building> = {}) {
  const src: Building = {
    x: 0,
    z: 0,
    w: 24,
    d: 18,
    h: 7 * 3.5,
    y0: 0,
    district: 'mid',
    parking: false,
    ...over,
  };
  const b = new BuildingModel(0, src, 0, construction);
  const store = new PieceStore(b.count);
  b.fill(store, materials, MATERIAL_NAMES, 42);
  return { b, store, mark: new Uint8Array(b.count), queue: new Int32Array(b.count) };
}

const destroy = (store: PieceStore, id: number) => {
  store.state[id] = STATE.destroyed;
};

describe('building construction', () => {
  it('lays out columns, slabs, panels and roof pieces with contiguous ids', () => {
    const { b, store } = makeBuilding();
    expect(b.floors).toBe(7);
    expect(b.count).toBe(b.roofBase + b.roofCount - b.base);
    const kinds = [0, 0, 0, 0];
    for (let id = b.base; id < b.end; id++) kinds[store.kind[id]!]!++;
    expect(kinds[KIND.column]).toBe(7 * b.ncx * b.ncz);
    expect(kinds[KIND.slab]).toBe(7 * (b.ncx - 1) * (b.ncz - 1));
    expect(kinds[KIND.panel]).toBe(7 * b.panelsPerFloor);
    expect(kinds[KIND.roof]).toBe(b.roofCount);
  });

  it('keeps every piece inside the footprint and below the roof line', () => {
    const { b, store } = makeBuilding();
    for (let id = b.base; id < b.end; id++) {
      expect(store.cx[id]! - store.hx[id]!).toBeGreaterThanOrEqual(b.x0 - 1e-4);
      expect(store.cx[id]! + store.hx[id]!).toBeLessThanOrEqual(b.x1 + 1e-4);
      expect(store.cz[id]! - store.hz[id]!).toBeGreaterThanOrEqual(b.z0 - 1e-4);
      expect(store.cz[id]! + store.hz[id]!).toBeLessThanOrEqual(b.z1 + 1e-4);
      expect(store.cy[id]! - store.hy[id]!).toBeGreaterThanOrEqual(-1e-4);
      expect(store.mass[id]).toBeGreaterThan(0);
    }
  });

  it('starts with the shell revealed and the interior hidden', () => {
    const { b, store } = makeBuilding();
    expect(store.flags[b.panelId(0, 3, 1)]! & FLAG.revealed).toBeTruthy();
    expect(store.flags[b.slabId(b.floors - 1, 0, 0)]! & FLAG.revealed).toBeTruthy();
    expect(store.flags[b.colId(2, 1, 1)]! & FLAG.revealed).toBeFalsy();
    expect(store.flags[b.slabId(2, 0, 0)]! & FLAG.revealed).toBeFalsy();
  });

  it('uses glass towers, concrete mid-rises and brick low-rises', () => {
    expect(makeBuilding({ district: 'downtown' }).b.facadeMat).toBe(
      MATERIAL_NAMES.indexOf('glass'),
    );
    expect(makeBuilding({ district: 'mid' }).b.facadeMat).toBe(
      MATERIAL_NAMES.indexOf('concretePanel'),
    );
    expect(makeBuilding({ district: 'low' }).b.facadeMat).toBe(MATERIAL_NAMES.indexOf('brick'));
  });

  it('places column lines every span and always at both ends', () => {
    expect(columnLines(9, 3)).toEqual([0, 3, 6, 9]);
    expect(columnLines(10, 3)).toEqual([0, 3, 6, 10]);
    expect(columnLines(4, 3)).toEqual([0, 4]);
  });
});

describe('support graph', () => {
  it('is symmetric', () => {
    const { b } = makeBuilding();
    for (let id = b.base; id < b.end; id++) {
      b.forEachNeighbour(id, (n) => {
        let back = false;
        b.forEachNeighbour(n, (m) => {
          if (m === id) back = true;
        });
        expect(back, `${id} -> ${n}`).toBe(true);
      });
    }
  });

  it('an intact building is fully supported', () => {
    const { b, store, mark, queue } = makeBuilding();
    expect(b.findUnsupported(store, mark, queue)).toEqual([]);
  });

  it('a hole in one wall does not drop anything', () => {
    const { b, store, mark, queue } = makeBuilding();
    destroy(store, b.panelId(0, 2, 1));
    destroy(store, b.panelId(0, 2, 2));
    destroy(store, b.slabId(2, 0, 0));
    expect(b.findUnsupported(store, mark, queue)).toEqual([]);
  });

  it('cutting a whole story disconnects everything above it as one cluster', () => {
    const { b, store, mark, queue } = makeBuilding();
    const f = 3;
    for (let a = 0; a < b.ncx; a++)
      for (let c = 0; c < b.ncz; c++) destroy(store, b.colId(f, a, c));
    for (let s = 0; s < 4; s++) {
      const n = s % 2 === 0 ? b.nbx : b.nbz;
      for (let k = 0; k < n; k++) destroy(store, b.panelId(s, f, k));
    }
    const groups = b.findUnsupported(store, mark, queue);
    expect(groups).toHaveLength(1);
    const g = groups[0]!;
    // Everything from slab f upward falls; nothing below story f does.
    expect(g).toContain(b.slabId(f, 0, 0));
    expect(g).toContain(b.roofId(0));
    expect(g).not.toContain(b.colId(f - 1, 0, 0));
    for (const id of g) expect(b.floorOf(id)).toBeGreaterThanOrEqual(f);
  });

  it('a panel whose neighbours and slabs are gone falls on its own', () => {
    const { b, store, mark, queue } = makeBuilding();
    const p = b.panelId(0, 4, 2);
    b.forEachNeighbour(p, (n) => destroy(store, n));
    const groups = b.findUnsupported(store, mark, queue);
    expect(groups.some((g) => g.length === 1 && g[0] === p)).toBe(true);
  });
});

describe('stress', () => {
  it('flags a story that lost most of its columns, with a topple direction', () => {
    const { b, store } = makeBuilding();
    expect(b.findOverloadedStory(store, construction ? 0.4 : 0.4)).toBeNull();
    // Cut every column on the -x half of story 2.
    for (let a = 0; a < b.ncx; a++)
      for (let c = 0; c < b.ncz; c++) if (a < b.ncx - 1) destroy(store, b.colId(2, a, c));
    const r = b.findOverloadedStory(store, 0.4)!;
    expect(r.story).toBe(2);
    expect(r.tx).toBeLessThan(0); // survivors on +x, so it tips toward -x
    expect(r.imbalance).toBeGreaterThan(0.5);
  });

  it('ignores the top story when nothing is above it', () => {
    const { b, store } = makeBuilding();
    const f = b.floors - 1;
    for (let a = 0; a < b.ncx; a++)
      for (let c = 0; c < b.ncz; c++) destroy(store, b.colId(f, a, c));
    for (let i = 0; i < b.ncx - 1; i++)
      for (let j = 0; j < b.ncz - 1; j++) destroy(store, b.slabId(f, i, j));
    expect(b.findOverloadedStory(store, 0.4)).toBeNull();
  });
});

describe('queries', () => {
  it('finds the pieces near a point', () => {
    const { b, store } = makeBuilding();
    const target = b.panelId(0, 3, 2);
    const found: number[] = [];
    b.forEachInSphere(
      store,
      store.cx[target]!,
      store.cy[target]!,
      store.cz[target]! - 0.5,
      0.6,
      (id) => found.push(id),
    );
    expect(found).toContain(target);
    expect(found.length).toBeLessThan(6);
  });
});

describe('damage states', () => {
  const t = { crackedAt: 0.7, crackedHeavyAt: 0.4, breachedAt: 0.15 };
  it('cracks, then breaches panels, then destroys', () => {
    expect(stateForHp(1, KIND.panel, t)).toBe(STATE.intact);
    expect(stateForHp(0.6, KIND.panel, t)).toBe(STATE.cracked);
    expect(stateForHp(0.3, KIND.panel, t)).toBe(STATE.crackedHeavy);
    expect(stateForHp(0.1, KIND.panel, t)).toBe(STATE.breached);
    expect(stateForHp(0, KIND.panel, t)).toBe(STATE.destroyed);
    expect(stateForHp(0.1, KIND.column, t)).toBe(STATE.crackedHeavy); // columns never "breach"
  });
});
