import * as THREE from 'three/webgpu';
import { config } from '../config';
import { events } from '../core/events';
import { Rng } from '../core/rng';
import type { DestructionSystem } from '../destruction/destruction';
import { FLAG, STATE } from '../destruction/pieces';
import type { InteriorSystem } from '../interiors/interiorSystem';
import { UFLAG, UNIT } from '../interiors/units';
import { Dust } from './dust';

interface PointFire {
  x: number;
  y: number;
  z: number;
  intensity: number;
  fuel: number;
  radius: number;
}

const TICK = 0.25;
const _v = new THREE.Vector3();

/**
 * Fire and smoke (DESIGN.md §7.9). Fires live in units: they grow, burn through their fuel,
 * spread to neighbouring units on the floor and up through broken windows, char what's inside,
 * blow the windows out, and heat steel columns until they weaken. Rubble fires burn in the open.
 * Spread runs at 4 Hz and is capped; flames and smoke are pooled particles; a few real lights
 * flicker at the nearest big fires.
 */
export class FireSystem {
  readonly burning = new Set<number>();
  readonly points: PointFire[] = [];
  readonly flames: Dust;
  readonly smoke: Dust;
  readonly lights: THREE.PointLight[] = [];
  private tick = 0;
  private rng = new Rng(0xf12e);
  private structureTimer = 0;
  private heatedBuildings = new Set<number>();
  private emitAcc = 0;
  unitsBurnt = 0;

  constructor(
    scene: THREE.Scene,
    private readonly destruction: DestructionSystem,
    private readonly interiors: InteriorSystem,
  ) {
    const f = config.fire;
    this.flames = new Dust(scene, {
      capacity: () => f.flameCapacity,
      color: () => '#ff8a2a',
      lifetime: () => 0.9,
      drag: () => 1.2,
      opacity: 0.95,
      lift: () => 9,
      windX: () => config.fire.windX * 0.5,
      windZ: () => config.fire.windZ * 0.5,
      additive: true,
      brightness: 2.2,
      flicker: true,
    });
    this.smoke = new Dust(scene, {
      capacity: () => f.smokeCapacity,
      color: () => '#2a2622',
      lifetime: () => 16,
      drag: () => 0.25,
      opacity: 0.6,
      lift: () => config.fire.smokeRise * 0.35,
      windX: () => config.fire.windX,
      windZ: () => config.fire.windZ,
    });
    for (let i = 0; i < f.lights; i++) {
      const l = new THREE.PointLight(0xff7a2a, 0, f.lightRange, 2);
      l.castShadow = false;
      this.lights.push(l);
      scene.add(l);
    }
    // Collapses throw burning debris: rubble fires, and the stump may catch.
    events.on('building:collapse', (e) => {
      if (this.rng.next() > config.fire.collapseIgnition * 2) return;
      const b = destruction.city.buildings[e.building]!;
      const n = this.rng.int(1, 3);
      for (let k = 0; k < n; k++) {
        this.ignitePoint(
          this.rng.range(b.x0, b.x1),
          destruction.debris.piles.heightAt((b.x0 + b.x1) / 2, (b.z0 + b.z1) / 2) + 0.5,
          this.rng.range(b.z0, b.z1),
          this.rng.range(40, 120),
        );
      }
    });
    events.on('cluster:crush', (e) => {
      if (this.rng.next() > config.fire.collapseIgnition * 0.15) return;
      const u = this.interiors.unitAt(
        e.x + this.rng.range(-8, 8),
        e.y - 2,
        e.z + this.rng.range(-8, 8),
      );
      if (u >= 0) this.ignite(u, 0.3);
    });
  }

  get burningCount() {
    return this.burning.size + this.points.length;
  }

  /** Sets a unit on fire. */
  ignite(u: number, amount = 0.25) {
    const units = this.interiors.units;
    if (units.flags[u]! & UFLAG.burnt || units.fuel[u]! <= 0.02) return false;
    if (!this.burning.has(u) && this.burning.size >= config.fire.maxBurning) return false;
    units.fire[u] = Math.max(units.fire[u]!, amount);
    if (!this.burning.has(u)) {
      this.burning.add(u);
      this.destruction.activate(units.building[u]!);
      this.interiors.requestAround(u);
    }
    return true;
  }

  /** Ignites whatever is at a point: the unit there, else an open fire on the ground. */
  igniteAt(x: number, y: number, z: number) {
    const u = this.interiors.unitAt(x, y, z);
    if (u >= 0) return this.ignite(u, 0.5);
    this.ignitePoint(x, this.destruction.debris.piles.heightAt(x, z) + 0.3, z, 60);
    return true;
  }

  ignitePoint(x: number, y: number, z: number, fuelSeconds: number) {
    if (this.points.length >= 64) return;
    this.points.push({
      x,
      y,
      z,
      intensity: 0.4,
      fuel: fuelSeconds,
      radius: this.rng.range(1.5, 3.5),
    });
  }

  /** Puts out fires within r (freeze breath, M4). */
  extinguish(x: number, y: number, z: number, r: number) {
    for (const u of this.burning) {
      const box = this.unitBox(u);
      const cx = (box[0] + box[1]) / 2;
      const cy = (box[2] + box[3]) / 2;
      const cz = (box[4] + box[5]) / 2;
      if (Math.hypot(cx - x, cy - y, cz - z) < r + 4) {
        this.interiors.units.fire[u] = 0;
        this.burning.delete(u);
        this.refreshUnit(u);
      }
    }
    for (let i = this.points.length - 1; i >= 0; i--) {
      const p = this.points[i]!;
      if (Math.hypot(p.x - x, p.y - y, p.z - z) < r + p.radius) this.points.splice(i, 1);
    }
  }

  private unitBox(u: number) {
    return this.interiors.units.bounds(
      u,
      config.construction.floorHeight,
      config.construction.slabThickness,
    );
  }

  /** Is the unit's facade open (holes or broken windows), letting fire climb outside? */
  private facadeOpen(u: number) {
    const s = this.destruction.city.store;
    for (const id of this.interiors.unitPanels(u)) {
      if (s.state[id]! >= STATE.breached || s.flags[id]! & FLAG.windowsBroken) return true;
    }
    return false;
  }

  private refreshUnit(u: number) {
    const s = this.destruction.city.store;
    for (const id of this.interiors.unitPanels(u))
      if (s.isStatic(id)) this.destruction.renderer.refresh(id);
    this.interiors.applyFireLook(u);
  }

  update(dt: number, camera: THREE.Camera) {
    const f = config.fire;
    const units = this.interiors.units;
    const s = this.destruction.city.store;
    this.tick += dt;
    if (this.tick >= TICK) {
      const step = this.tick;
      this.tick = 0;
      for (const u of [...this.burning]) {
        const [bi, fl, i, j] = units.decode(u);
        const b = this.destruction.city.buildings[bi]!;
        // A unit that has fallen out of the building is gone (its rubble may keep burning).
        if (!s.isStatic(b.slabId(fl, i, j)) && s.state[b.slabId(fl, i, j)] === STATE.destroyed) {
          units.fire[u] = 0;
          this.burning.delete(u);
          continue;
        }
        const fuelK = units.type[u] === UNIT.parking ? 0.4 : 1;
        units.fire[u] = Math.min(1, units.fire[u]! + step / f.growTime);
        units.fuel[u] = Math.max(
          0,
          units.fuel[u]! - (step * units.fire[u]!) / (f.burnTime * fuelK),
        );
        const k = units.fire[u]!;
        if (units.fuel[u]! <= 0) {
          units.fire[u] = 0;
          units.flags[u]! |= UFLAG.burnt;
          this.burning.delete(u);
          this.unitsBurnt++;
        }
        // Spread along the floor and, through open windows, up the outside to the floor above.
        for (const [di, dj] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const v = units.id(bi, fl, i + di, j + dj);
          if (v >= 0 && !this.burning.has(v) && this.rng.next() < f.spreadSideChance * k * step * 4)
            this.ignite(v, 0.1);
        }
        const open = this.facadeOpen(u);
        if (open) {
          const v = units.id(bi, fl + 1, i, j);
          if (v >= 0 && !this.burning.has(v) && this.rng.next() < f.spreadUpChance * k * step * 4)
            this.ignite(v, 0.1);
        }
        // Heat blows the windows out once the fire is going.
        if (k > 0.55) {
          for (const id of this.interiors.unitPanels(u)) {
            if (
              s.isStatic(id) &&
              !(s.flags[id]! & FLAG.windowsBroken) &&
              s.state[id]! < STATE.breached &&
              this.rng.next() < 0.25
            )
              this.destruction.breakWindow(id);
          }
        }
        // Soot on the facade and the slabs; the steel and concrete around it heat up.
        const sootTo = Math.min(1, (1 - units.fuel[u]!) * 1.2);
        for (const id of this.interiors.unitPanels(u))
          s.soot[id] = Math.max(s.soot[id]!, sootTo * 0.85);
        s.soot[b.slabId(fl, i, j)] = Math.max(s.soot[b.slabId(fl, i, j)]!, sootTo);
        for (const [a, c] of [
          [i, j],
          [i + 1, j],
          [i, j + 1],
          [i + 1, j + 1],
        ] as const) {
          const col = b.colId(fl, a, c);
          s.temperature[col] = Math.min(900, s.temperature[col]! + f.heatRate * k * step);
          s.soot[col] = Math.max(s.soot[col]!, sootTo);
        }
        this.heatedBuildings.add(bi);
        this.refreshUnit(u);
      }
      // Rubble fires burn out.
      for (let n = this.points.length - 1; n >= 0; n--) {
        const p = this.points[n]!;
        p.intensity = Math.min(1, p.intensity + step / f.growTime);
        p.fuel -= step;
        if (p.fuel <= 0) this.points.splice(n, 1);
      }
      // Hot steel loses strength: re-check the heated buildings now and then.
      this.structureTimer -= step;
      if (this.structureTimer <= 0) {
        this.structureTimer = 2;
        for (const bi of this.heatedBuildings) this.destruction.structure.markDirty(bi);
        this.heatedBuildings.clear();
      }
    }

    this.emit(dt);
    this.flames.update(dt, camera);
    this.smoke.update(dt, camera);
    this.updateLights(camera);
  }

  /** Flames out of every opening of a burning unit, smoke pouring up from them. */
  private emit(dt: number) {
    const f = config.fire;
    const s = this.destruction.city.store;
    const units = this.interiors.units;
    this.emitAcc += dt;
    if (this.emitAcc < 1 / 30) return;
    const step = this.emitAcc;
    this.emitAcc = 0;
    for (const u of this.burning) {
      const k = units.fire[u]!;
      const panels = this.interiors.unitPanels(u);
      const b = this.destruction.city.buildings[units.building[u]!]!;
      for (const id of panels) {
        if (!s.isStatic(id) && s.state[id] !== STATE.destroyed) continue;
        const open = s.state[id]! >= STATE.breached || (s.flags[id]! & FLAG.windowsBroken) !== 0;
        // Outward from this side of the building.
        const side = b.panelSide(id);
        const nx = side === 1 ? 1 : side === 3 ? -1 : 0;
        const nz = side === 0 ? -1 : side === 2 ? 1 : 0;
        const x = s.cx[id]! + nx * 0.3;
        const y = s.cy[id]! - s.hy[id]! * 0.2;
        const z = s.cz[id]! + nz * 0.3;
        if (open) {
          const nFlames = poisson(f.flameRate * k * step, this.rng);
          for (let n = 0; n < nFlames; n++) {
            this.flames.spawn(
              x + this.rng.range(-1.2, 1.2) * Math.abs(nz),
              y + this.rng.range(-0.6, 0.6),
              z + this.rng.range(-1.2, 1.2) * Math.abs(nx),
              nx * this.rng.range(1, 3),
              this.rng.range(1, 3),
              nz * this.rng.range(1, 3),
              this.rng.range(0.8, 1.6) * (0.6 + k * 0.6),
              this.rng.range(0.3, 0.9),
            );
          }
        }
        const nSmoke = poisson(f.smokeRate * k * step * (open ? 1 : 0.25), this.rng);
        for (let n = 0; n < nSmoke; n++) {
          this.smoke.spawn(
            x + nx * 0.8,
            y + s.hy[id]! * 0.8,
            z + nz * 0.8,
            nx * this.rng.range(0.5, 2),
            this.rng.range(1.5, 3),
            nz * this.rng.range(0.5, 2),
            this.rng.range(2, 4),
            this.rng.range(1.2, 2.6),
          );
        }
      }
    }
    for (const p of this.points) {
      const nFlames = poisson(f.flameRate * 1.5 * p.intensity * step, this.rng);
      for (let n = 0; n < nFlames; n++) {
        this.flames.spawn(
          p.x + this.rng.range(-p.radius, p.radius),
          p.y + this.rng.range(0, 0.5),
          p.z + this.rng.range(-p.radius, p.radius),
          this.rng.range(-0.5, 0.5),
          this.rng.range(1, 3),
          this.rng.range(-0.5, 0.5),
          this.rng.range(1, 2.2),
          this.rng.range(0.3, 0.8),
        );
      }
      if (this.rng.next() < f.smokeRate * p.intensity * step) {
        this.smoke.spawn(
          p.x,
          p.y + 2,
          p.z,
          0,
          2.5,
          0,
          this.rng.range(2.5, 4.5),
          this.rng.range(1.5, 3),
        );
      }
    }
  }

  /** Real flickering lights at the nearest fires (capped). */
  private updateLights(camera: THREE.Camera) {
    if (this.lights.length === 0) return;
    const f = config.fire;
    const cand: [number, number, number, number, number][] = [];
    for (const u of this.burning) {
      const k = this.interiors.units.fire[u]!;
      if (k < 0.2) continue;
      const box = this.unitBox(u);
      const x = (box[0] + box[1]) / 2;
      const y = box[2] + 1.5;
      const z = (box[4] + box[5]) / 2;
      cand.push([_v.set(x, y, z).distanceToSquared(camera.position), x, y, z, k]);
    }
    for (const p of this.points)
      cand.push([
        _v.set(p.x, p.y + 1, p.z).distanceToSquared(camera.position),
        p.x,
        p.y + 1,
        p.z,
        p.intensity,
      ]);
    cand.sort((a, b) => a[0] - b[0]);
    const t = performance.now() / 1000;
    this.lights.forEach((l, i) => {
      const c = cand[i];
      if (!c) {
        l.intensity = 0;
        return;
      }
      l.position.set(c[1], c[2], c[3]);
      const flick = 0.75 + 0.15 * Math.sin(t * 13 + i * 2.1) + 0.1 * Math.sin(t * 31 + i);
      l.intensity = f.lightIntensity * c[4] * flick;
      l.distance = f.lightRange;
    });
  }

  /** Startup prewarm: flames and smoke draw once. */
  setPrewarm(on: boolean) {
    this.flames.mesh.count = on ? 1 : this.flames.count;
    this.smoke.mesh.count = on ? 1 : this.smoke.count;
  }

  get particleCount() {
    return this.flames.count + this.smoke.count;
  }
}

/** Integer count for an expected rate (Poisson-ish, cheap). */
function poisson(mean: number, rng: Rng) {
  let n = Math.floor(mean);
  if (rng.next() < mean - n) n++;
  return n;
}
