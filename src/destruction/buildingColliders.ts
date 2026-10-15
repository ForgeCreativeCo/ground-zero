import type RAPIER from '@dimforge/rapier3d-compat';
import type { Physics } from '../physics/physics';
import type { BuildingModel } from './buildingModel';
import type { CityStructure } from './cityStructure';
import { FLAG, STATE } from './pieces';

/**
 * Physics shapes for buildings. Rapier's per-step cost grows with every static collider, so pieces
 * don't get one each: a pristine building is a single box; once damaged it is rebuilt from merged
 * runs (intact facade strips, slab rectangles per floor) plus individual exposed columns and roof
 * gear. Breached and destroyed pieces leave real gaps the hero can fly through.
 */
export class BuildingColliders {
  private bodies: RAPIER.RigidBody[] = [];
  private colliders: RAPIER.Collider[][] = [];
  private pristine: boolean[] = [];
  /** Collider handle → building index (debris impacts look up what they hit). */
  readonly buildingOfCollider = new Map<number, number>();
  private dirty = new Set<number>();
  total = 0;
  /** Called after a building's colliders are rebuilt, with its boxes [cx,cy,cz,hx,hy,hz]... */
  onRebuilt: ((building: number, boxes: Float32Array) => void) | null = null;
  private boxList: number[] = [];

  constructor(
    private readonly physics: Physics,
    private readonly city: CityStructure,
  ) {
    const R = physics.R;
    city.buildings.forEach((_b, i) => {
      this.bodies.push(physics.world.createRigidBody(R.RigidBodyDesc.fixed()));
      this.colliders.push([]);
      this.pristine.push(true);
      this.buildPristine(i);
    });
  }

  markDirty(building: number) {
    this.dirty.add(building);
  }

  /** Rebuilds up to `max` dirty buildings (spread across frames). */
  update(max: number) {
    let n = 0;
    for (const b of this.dirty) {
      this.dirty.delete(b);
      this.rebuild(b);
      if (++n >= max) break;
    }
  }

  get pending() {
    return this.dirty.size;
  }

  private clear(i: number) {
    for (const c of this.colliders[i]!) {
      this.buildingOfCollider.delete(c.handle);
      this.physics.world.removeCollider(c, false);
      this.total--;
    }
    this.colliders[i]!.length = 0;
  }

  private box(i: number, cx: number, cy: number, cz: number, hx: number, hy: number, hz: number) {
    if (hx <= 0 || hy <= 0 || hz <= 0) return;
    this.boxList.push(cx, cy, cz, hx, hy, hz);
    const c = this.physics.world.createCollider(
      this.physics.R.ColliderDesc.cuboid(hx, hy, hz).setTranslation(cx, cy, cz),
      this.bodies[i],
    );
    this.colliders[i]!.push(c);
    this.buildingOfCollider.set(c.handle, i);
    this.total++;
  }

  private buildPristine(i: number) {
    const b = this.city.buildings[i]!;
    const top = b.height + b.p.parapetHeight;
    this.box(
      i,
      (b.x0 + b.x1) / 2,
      top / 2,
      (b.z0 + b.z1) / 2,
      (b.x1 - b.x0) / 2,
      top / 2,
      (b.z1 - b.z0) / 2,
    );
  }

  /** Full merged rebuild from the current piece states. */
  rebuild(i: number) {
    this.clear(i);
    this.boxList.length = 0;
    this.pristine[i] = false;
    const b = this.city.buildings[i]!;
    const s = this.city.store;
    const solid = (id: number) => s.isStatic(id) && s.state[id] !== STATE.breached;

    // Facade: per side, runs of solid panels per floor, stacked while identical floor to floor.
    for (let side = 0; side < 4; side++) this.buildSide(i, b, side, solid);

    // Slabs: greedy rectangles of static slab cells per floor.
    const cw = b.ncx - 1;
    const cd = b.ncz - 1;
    const used = new Uint8Array(cw * cd);
    for (let f = 0; f < b.floors; f++) {
      used.fill(0);
      for (let j = 0; j < cd; j++) {
        for (let i0 = 0; i0 < cw; i0++) {
          if (used[j * cw + i0] || !s.isStatic(b.slabId(f, i0, j))) continue;
          let i1 = i0;
          while (i1 + 1 < cw && !used[j * cw + i1 + 1] && s.isStatic(b.slabId(f, i1 + 1, j))) i1++;
          let j1 = j;
          grow: while (j1 + 1 < cd) {
            for (let k = i0; k <= i1; k++)
              if (used[(j1 + 1) * cw + k] || !s.isStatic(b.slabId(f, k, j1 + 1))) break grow;
            j1++;
          }
          for (let jj = j; jj <= j1; jj++) for (let k = i0; k <= i1; k++) used[jj * cw + k] = 1;
          const a = b.slabId(f, i0, j);
          const c = b.slabId(f, i1, j1);
          const minX = s.cx[a]! - s.hx[a]!;
          const maxX = s.cx[c]! + s.hx[c]!;
          const minZ = s.cz[a]! - s.hz[a]!;
          const maxZ = s.cz[c]! + s.hz[c]!;
          this.box(
            i,
            (minX + maxX) / 2,
            s.cy[a]!,
            (minZ + maxZ) / 2,
            (maxX - minX) / 2,
            s.hy[a]!,
            (maxZ - minZ) / 2,
          );
        }
      }
    }

    // Columns (once exposed) and roof pieces individually.
    for (let id = b.colBase; id < b.slabBase; id++) {
      if (s.isStatic(id) && s.flags[id]! & FLAG.revealed) this.pieceBox(i, id);
    }
    for (let id = b.roofBase; id < b.end; id++) if (s.isStatic(id)) this.pieceBox(i, id);
    this.onRebuilt?.(i, new Float32Array(this.boxList));
  }

  private pieceBox(i: number, id: number) {
    const s = this.city.store;
    this.box(i, s.cx[id]!, s.cy[id]!, s.cz[id]!, s.hx[id]!, s.hy[id]!, s.hz[id]!);
  }

  private buildSide(i: number, b: BuildingModel, side: number, solid: (id: number) => boolean) {
    const s = this.city.store;
    const alongX = side === 0 || side === 2;
    const n = alongX ? b.nbx : b.nbz;
    // runs[f] = list of [k0, k1] inclusive.
    const runs: [number, number][][] = [];
    for (let f = 0; f < b.floors; f++) {
      const list: [number, number][] = [];
      let k = 0;
      while (k < n) {
        if (!solid(b.panelId(side, f, k))) {
          k++;
          continue;
        }
        const k0 = k;
        while (k + 1 < n && solid(b.panelId(side, f, k + 1))) k++;
        list.push([k0, k]);
        k++;
      }
      runs.push(list);
    }
    const consumed = runs.map((l) => new Uint8Array(l.length));
    for (let f = 0; f < b.floors; f++) {
      runs[f]!.forEach(([k0, k1], ri) => {
        if (consumed[f]![ri]) return;
        consumed[f]![ri] = 1;
        let f1 = f;
        // Stack upward while the next floor has the identical run.
        for (;;) {
          const next = runs[f1 + 1];
          if (!next) break;
          const idx = next.findIndex(([a, c], j) => a === k0 && c === k1 && !consumed[f1 + 1]![j]);
          if (idx < 0) break;
          consumed[f1 + 1]![idx] = 1;
          f1++;
        }
        const a = b.panelId(side, f, k0);
        const c = b.panelId(side, f1, k1);
        const minX = Math.min(s.cx[a]! - s.hx[a]!, s.cx[c]! - s.hx[c]!);
        const maxX = Math.max(s.cx[a]! + s.hx[a]!, s.cx[c]! + s.hx[c]!);
        const minZ = Math.min(s.cz[a]! - s.hz[a]!, s.cz[c]! - s.hz[c]!);
        const maxZ = Math.max(s.cz[a]! + s.hz[a]!, s.cz[c]! + s.hz[c]!);
        const minY = s.cy[a]! - s.hy[a]!;
        const maxY = s.cy[c]! + s.hy[c]!;
        this.box(
          i,
          (minX + maxX) / 2,
          (minY + maxY) / 2,
          (minZ + maxZ) / 2,
          (maxX - minX) / 2,
          (maxY - minY) / 2,
          (maxZ - minZ) / 2,
        );
      });
    }
  }

  isPristine(i: number) {
    return this.pristine[i]!;
  }
}
