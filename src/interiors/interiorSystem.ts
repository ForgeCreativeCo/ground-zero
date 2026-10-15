import * as THREE from 'three/webgpu';
import { config } from '../config';
import { events } from '../core/events';
import { Rng } from '../core/rng';
import type { DestructionSystem } from '../destruction/destruction';
import { KIND, STATE } from '../destruction/pieces';
import type { PieceVisual } from '../render/pieceMaterials';
import { furnish, type Prop, type PropVisual } from './furnishing';
import { PropRenderer, PROP_VISUALS } from './props';
import { UFLAG, UnitStore, UNIT } from './units';

const _q = new THREE.Quaternion();
const _e = new THREE.Euler();

/** The debris look a broken prop falls apart into. */
const DEBRIS_LOOK: Record<PropVisual, PieceVisual> = {
  wood: 'wood',
  fabric: 'fabric',
  metal: 'metal',
  drywall: 'drywall',
  plant: 'plant',
  light: 'glass',
  screen: 'glass',
};
const PROP_VALUE = 450; // $ per prop destroyed

interface Outage {
  origin: number;
  start: number;
}

/** JS twin of the interior shader's hash, so real lights match which windows are lit. */
export function shaderHash(a: number, b: number) {
  const v = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
  return v - Math.floor(v);
}

/**
 * Interiors (DESIGN.md §7.5). Every unit exists as data from the start (and shows through windows
 * via the interior-mapping shader); real furniture and interior walls are spawned only around
 * breaches and where the hero is, and removed again when far away and untouched. Damaged
 * interiors persist. Also owns power failure and interior lights.
 */
export class InteriorSystem {
  readonly units: UnitStore;
  readonly props: PropRenderer;
  /** unit → its prop ids (furniture + the interior walls it owns). */
  readonly unitProps = new Map<number, number[]>();
  /** Built interior wall edges (so neighbours don't double them). */
  private edges = new Set<string>();
  private queue: number[] = [];
  private queued = new Set<number>();
  private outages = new Map<number, Outage>();
  private destroyedColumns = new Map<number, number>();
  private time = 0;
  private powerTimer = 0;
  private checkCursor = 0;
  /** Furnished unit ids, refreshed when the set changes (no per-frame allocation). */
  private checkKeys: number[] = [];
  private checkStale = false;
  private lightTimer = 0;
  private heroCheck = 0;
  private despawnTimer = 0;
  private rng = new Rng(0x1ee7);
  readonly lights: THREE.PointLight[] = [];
  /** Recently processed props scratch. */
  private hits: number[] = [];
  propsDestroyed = 0;
  /** Facade panels per unit (cache). */
  private panelCache = new Map<number, number[]>();

  constructor(
    scene: THREE.Scene,
    private readonly destruction: DestructionSystem,
    seed: number,
  ) {
    const c = config.interiors;
    this.units = new UnitStore(
      destruction.city.buildings,
      seed,
      c.officeChance,
      c.retailGroundChance,
    );
    this.props = new PropRenderer(scene, c.propCapacity);
    for (let i = 0; i < c.realLights; i++) {
      const l = new THREE.PointLight(0xfff0d8, 0, c.lightRange, 2);
      l.castShadow = false;
      this.lights.push(l);
      scene.add(l);
    }
    destruction.renderer.roomInfo = (id, out) => this.roomInfo(id, out);
    destruction.propDamage = (x, y, z, r, dmg, px, py, pz) =>
      this.damageProps(x, y, z, r, dmg, px, py, pz);

    events.on('piece:damaged', (e) => {
      if (e.state >= STATE.breached) this.onBreach(e.id);
    });
    events.on('piece:destroyed', (e) => this.onBreach(e.id));
  }

  // --- unit lookup --------------------------------------------------------------------------

  /** Units touching a building piece (the unit behind a panel; above/below a slab; around a column). */
  private unitsOfPiece(id: number, out: number[]) {
    out.length = 0;
    const city = this.destruction.city;
    const s = city.store;
    const b = city.buildingOf(id);
    const kind = s.kind[id];
    if (kind === KIND.panel) {
      const u = this.units.unitOfPanel(b, id);
      if (u >= 0) out.push(u);
    } else if (kind === KIND.slab) {
      const r = id - b.slabBase;
      const cells = (b.ncx - 1) * (b.ncz - 1);
      const f = Math.floor(r / cells);
      const c = r % cells;
      const i = c % (b.ncx - 1);
      const j = Math.floor(c / (b.ncx - 1));
      for (const ff of [f, f + 1]) {
        const u = this.units.id(b.id, ff, i, j);
        if (u >= 0) out.push(u);
      }
    } else if (kind === KIND.column) {
      const per = b.ncx * b.ncz;
      const r = id - b.colBase;
      const f = Math.floor(r / per);
      const a = r % b.ncx;
      const c = Math.floor((r % per) / b.ncx);
      for (const i of [a - 1, a])
        for (const j of [c - 1, c]) {
          const u = this.units.id(b.id, f, i, j);
          if (u >= 0) out.push(u);
        }
    }
    return out;
  }

  private onBreach(id: number) {
    const s = this.destruction.city.store;
    if (s.kind[id] === KIND.column) {
      const bi = s.building[id]!;
      const n = (this.destroyedColumns.get(bi) ?? 0) + (s.state[id] === STATE.destroyed ? 1 : 0);
      this.destroyedColumns.set(bi, n);
      this.checkPower(bi, id);
    }
    for (const u of this.unitsOfPiece(id, this.hits)) {
      this.units.flags[u]! |= UFLAG.damaged;
      this.requestAround(u);
    }
  }

  /** Queue a unit and its same-floor neighbours for furnishing. */
  requestAround(u: number) {
    const [bi, f, i, j] = this.units.decode(u);
    const n = config.interiors.spawnNeighbours;
    for (let di = -n; di <= n; di++)
      for (let dj = -n; dj <= n; dj++) {
        const v = this.units.id(bi, f, i + di, j + dj);
        if (v >= 0 && !(this.units.flags[v]! & UFLAG.spawned) && !this.queued.has(v)) {
          this.queued.add(v);
          this.queue.push(v);
        }
      }
  }

  isSpawned(u: number) {
    return (this.units.flags[u]! & UFLAG.spawned) !== 0;
  }

  // --- spawning -----------------------------------------------------------------------------

  private unitBox(u: number) {
    const c = config.construction;
    const [x0, x1, y0, y1, z0, z1] = this.units.bounds(u, c.floorHeight, c.slabThickness);
    return { x0, x1, y0, y1, z0, z1 };
  }

  /** Is the unit still standing (its floor slab and ceiling slab are part of the building)? */
  private unitStanding(u: number) {
    const [bi, f, i, j] = this.units.decode(u);
    const b = this.destruction.city.buildings[bi]!;
    const s = this.destruction.city.store;
    if (!s.isStatic(b.slabId(f, i, j))) return false;
    return f === 0 || s.isStatic(b.slabId(f - 1, i, j));
  }

  private spawn(u: number) {
    if (this.isSpawned(u) || !this.unitStanding(u)) return;
    this.units.flags[u]! |= UFLAG.spawned;
    const list: number[] = [];
    const box = this.unitBox(u);
    for (const p of furnish(this.units.type[u] as 0, box, this.units.seed[u]!)) {
      const id = this.props.add(p, u);
      if (id >= 0) list.push(id);
    }
    this.buildWalls(u, box, list);
    this.unitProps.set(u, list);
    this.applyFireLook(u);
    this.applyLights(u);
  }

  /** Interior walls on the unit's internal edges, each with a door gap (DESIGN.md §7.1). */
  private buildWalls(u: number, box: ReturnType<InteriorSystem['unitBox']>, list: number[]) {
    if (this.units.type[u] === UNIT.parking) return;
    const [bi, f, i, j] = this.units.decode(u);
    const b = this.destruction.city.buildings[bi]!;
    const h = box.y1 - box.y0;
    const t = 0.12;
    const door = 1.1;
    const wall = (x0: number, z0: number, x1: number, z1: number, key: string) => {
      if (this.edges.has(key)) return;
      this.edges.add(key);
      const alongX = Math.abs(x1 - x0) > Math.abs(z1 - z0);
      const len = alongX ? x1 - x0 : z1 - z0;
      const seg = (len - door) / 2;
      if (seg <= 0.2) return;
      for (const k of [0, 1]) {
        const start = k === 0 ? 0 : seg + door;
        const c = start + seg / 2;
        const p: Prop = {
          visual: 'drywall',
          x: alongX ? x0 + c : x0,
          y: box.y0 + h / 2,
          z: alongX ? z0 : z0 + c,
          hx: alongX ? seg / 2 : t / 2,
          hy: h / 2,
          hz: alongX ? t / 2 : seg / 2,
          yaw: 0,
          r: 0.95,
          g: 0.94,
          b: 0.9,
          hp: 30,
          fuel: 0.4,
        };
        const id = this.props.add(p, u);
        if (id >= 0) list.push(id);
      }
    };
    if (i < b.ncx - 2) wall(box.x1, box.z0, box.x1, box.z1, `${bi}:${f}:x:${i + 1}:${j}`);
    if (i > 0) wall(box.x0, box.z0, box.x0, box.z1, `${bi}:${f}:x:${i}:${j}`);
    if (j < b.ncz - 2) wall(box.x0, box.z1, box.x1, box.z1, `${bi}:${f}:z:${i}:${j + 1}`);
    if (j > 0) wall(box.x0, box.z0, box.x1, box.z0, `${bi}:${f}:z:${i}:${j}`);
  }

  private despawn(u: number) {
    const list = this.unitProps.get(u);
    if (!list) return;
    for (const id of list) this.props.remove(id);
    this.unitProps.delete(u);
    this.units.flags[u]! &= ~UFLAG.spawned;
    // Forget its wall edges so a neighbour (or a respawn) builds them again.
    const [bi, f, i, j] = this.units.decode(u);
    for (const k of [
      `${bi}:${f}:x:${i + 1}:${j}`,
      `${bi}:${f}:x:${i}:${j}`,
      `${bi}:${f}:z:${i}:${j + 1}`,
      `${bi}:${f}:z:${i}:${j}`,
    ])
      this.edges.delete(k);
  }

  /**
   * Props of a unit that has lost its floor fall out as debris. On a falling section they're removed
   * quietly instead (moving them with the section costs too much; its rubble and dust hide them).
   */
  private dropUnit(u: number, quiet: boolean) {
    const list = this.unitProps.get(u);
    if (!list) return;
    const s = this.props.store;
    for (const id of [...list]) {
      if (!s.alive[id]) continue;
      if (!quiet) this.breakProp(id, 0, -1, 0, false);
      else {
        this.destruction.bill += PROP_VALUE;
        this.props.remove(id);
      }
    }
    this.unitProps.delete(u);
    this.units.flags[u]! &= ~UFLAG.spawned;
  }

  // --- damage -------------------------------------------------------------------------------

  /** Damages props within r of a point; returns how many broke. */
  damageProps(
    x: number,
    y: number,
    z: number,
    r: number,
    dmg: number,
    px: number,
    py: number,
    pz: number,
  ) {
    const s = this.props.store;
    const hits = this.hits;
    hits.length = 0;
    for (const [u, list] of this.unitProps) {
      const box = this.unitBox(u);
      if (
        x < box.x0 - r ||
        x > box.x1 + r ||
        z < box.z0 - r ||
        z > box.z1 + r ||
        y < box.y0 - r ||
        y > box.y1 + r
      )
        continue;
      for (const id of list) {
        if (!s.alive[id]) continue;
        const dx = Math.max(0, Math.abs(x - s.x[id]!) - s.hx[id]!);
        const dy = Math.max(0, Math.abs(y - s.y[id]!) - s.hy[id]!);
        const dz = Math.max(0, Math.abs(z - s.z[id]!) - s.hz[id]!);
        if (dx * dx + dy * dy + dz * dz <= r * r) hits.push(id);
      }
    }
    let broke = 0;
    for (const id of hits) {
      const k = config.interiors.propHp;
      s.hp[id]! -= dmg / k;
      const u = s.unit[id]!;
      if (u >= 0) this.units.flags[u]! |= UFLAG.damaged;
      if (s.hp[id]! <= 0) {
        this.breakProp(id, px, py, pz, true);
        broke++;
      }
    }
    if (broke > 0) events.emit('damage:bill', { total: this.destruction.bill });
    return broke;
  }

  /** A prop breaks into a few fragments thrown by the push. */
  private breakProp(id: number, px: number, py: number, pz: number, billIt: boolean) {
    const s = this.props.store;
    const look = DEBRIS_LOOK[PROP_VISUALS[s.visual[id]!]!];
    const hx = s.hx[id]!;
    const hy = s.hy[id]!;
    const hz = s.hz[id]!;
    const big = hx * hy * hz > 0.08;
    const n = big ? 3 : 1;
    for (let k = 0; k < n; k++) {
      _e.set(this.rng.range(-0.6, 0.6), this.rng.range(0, 6.28), this.rng.range(-0.6, 0.6));
      this.destruction.debris.spawn(
        look,
        s.x[id]! + this.rng.range(-hx, hx) * 0.5,
        s.y[id]! + this.rng.range(-hy, hy) * 0.5,
        s.z[id]! + this.rng.range(-hz, hz) * 0.5,
        Math.max(0.05, hx / (big ? 1.6 : 1)),
        Math.max(0.03, hy / (big ? 1.6 : 1)),
        Math.max(0.05, hz / (big ? 1.6 : 1)),
        _q.setFromEuler(_e),
        px * this.rng.range(0.6, 1.2) + this.rng.range(-1.5, 1.5),
        py + this.rng.range(0.5, 3),
        pz * this.rng.range(0.6, 1.2) + this.rng.range(-1.5, 1.5),
        look === 'metal' ? 2500 : 600,
        false,
      );
    }
    const u = s.unit[id]!;
    const list = u >= 0 ? this.unitProps.get(u) : undefined;
    if (list) {
      const k = list.indexOf(id);
      if (k >= 0) list.splice(k, 1);
    }
    this.props.remove(id);
    this.propsDestroyed++;
    if (billIt) this.destruction.bill += PROP_VALUE;
  }

  /** The hero ploughs through furniture and drywall as he moves (DESIGN.md §6.1, §7.5). */
  heroSmash(x: number, y: number, z: number, vx: number, vy: number, vz: number) {
    const speed = Math.hypot(vx, vy, vz);
    if (speed < 2 || this.unitProps.size === 0) return;
    const r = config.interiors.heroSmashRadius;
    const k = Math.min(1.5, 0.4 + speed / 30);
    this.damageProps(x, y, z, r, 200 + speed * 10, vx * k, vy * k + 1, vz * k);
  }

  // --- power --------------------------------------------------------------------------------

  private checkPower(bi: number, columnId: number) {
    if (this.outages.has(bi)) return;
    const b = this.destruction.city.buildings[bi]!;
    const n = this.destroyedColumns.get(bi) ?? 0;
    if (n < Math.max(2, config.power.failColumnFraction * b.ncx * b.ncz * b.floors)) return;
    this.outages.set(bi, { origin: b.floorOf(columnId), start: this.time });
  }

  /** 1 = powered, 0.5 = flickering (outage front), 0 = dark. */
  floorPower(bi: number, f: number): number {
    const o = this.outages.get(bi);
    if (!o) return 1;
    const front = (this.time - o.start) * config.power.spreadFloorsPerSecond;
    const d = Math.abs(f - o.origin);
    if (d <= front - config.power.flickerBand) return 0;
    if (d <= front) return 0.5;
    return 1;
  }

  unitLit(u: number) {
    const [bi, f] = this.units.decode(u);
    const p = this.floorPower(bi, f);
    if (p < 0.75) return false;
    const c = config.interiors;
    const night = Math.min(1, Math.max(0, (6 - config.sun.elevationDeg) / 12));
    const frac = c.litDay + (c.litNight - c.litDay) * night;
    return shaderHash(this.units.seed[u]!, 9.1) < frac;
  }

  /** aRoom for a panel: [side + seed, power, fire, burnt]. */
  roomInfo(id: number, out: Float32Array) {
    const b = this.destruction.city.buildingOf(id);
    const u = this.units.unitOfPanel(b, id);
    const side = b.panelSide(id);
    if (u < 0) {
      out[0] = side + 0.5;
      out[1] = 1;
      out[2] = 0;
      out[3] = 0;
      return;
    }
    out[0] = side + Math.min(0.999, this.units.seed[u]!);
    out[1] = this.floorPower(b.id, b.floorOf(id));
    out[2] = this.units.fire[u]!;
    const burnt =
      this.units.flags[u]! & UFLAG.burnt
        ? 1
        : (1 - this.units.fuel[u]!) * Math.min(1, this.units.fire[u]! * 4);
    out[3] = burnt;
  }

  // --- fire hooks (used by the fire system) -------------------------------------------------

  /** Facade panels of a unit (cached). */
  unitPanels(u: number): number[] {
    let list = this.panelCache.get(u);
    if (list) return list;
    list = [];
    const [bi, f, i, j] = this.units.decode(u);
    const b = this.destruction.city.buildings[bi]!;
    const add = (side: number, k0: number, k1: number) => {
      for (let k = k0; k < k1; k++) list!.push(b.panelId(side, f, k));
    };
    if (j === 0) add(0, b.linesX[i]!, b.linesX[i + 1]!);
    if (j === b.ncz - 2) add(2, b.linesX[i]!, b.linesX[i + 1]!);
    if (i === b.ncx - 2) add(1, b.linesZ[j]!, b.linesZ[j + 1]!);
    if (i === 0) add(3, b.linesZ[j]!, b.linesZ[j + 1]!);
    this.panelCache.set(u, list);
    return list;
  }

  /** Props of a burning unit char as its fuel burns; embers glow with the fire. */
  applyFireLook(u: number) {
    const list = this.unitProps.get(u);
    if (!list) return;
    const char =
      this.units.flags[u]! & UFLAG.burnt
        ? 1
        : (1 - this.units.fuel[u]!) * Math.min(1, this.units.fire[u]! * 3);
    const lit = this.unitLit(u) && this.units.fire[u]! < 0.2 ? 1 : 0;
    const s = this.props.store;
    for (const id of list) {
      if (s.fuel[id]! <= 0 && PROP_VISUALS[s.visual[id]!] !== 'light') continue;
      this.props.setState(id, PROP_VISUALS[s.visual[id]!] === 'light' ? 0 : char, lit);
    }
  }

  private applyLights(u: number) {
    const list = this.unitProps.get(u);
    if (!list) return;
    const lit = this.unitLit(u) && this.units.fire[u]! < 0.2 ? 1 : 0;
    const s = this.props.store;
    for (const id of list) {
      const v = PROP_VISUALS[s.visual[id]!];
      if (v === 'light' || v === 'screen') this.props.setState(id, 0, lit);
    }
  }

  // --- per frame ----------------------------------------------------------------------------

  update(dt: number, hero: THREE.Vector3, camera: THREE.Camera) {
    this.time += dt;
    const c = config.interiors;

    // Furnish a few queued units per frame (spread the work).
    for (let n = 0; n < 3 && this.queue.length > 0; n++) {
      const u = this.queue.shift()!;
      this.queued.delete(u);
      this.spawn(u);
    }

    // Wherever the hero is inside a building, its rooms are real.
    this.heroCheck -= dt;
    if (this.heroCheck <= 0) {
      this.heroCheck = 0.25;
      const u = this.unitAt(hero.x, hero.y + 1, hero.z);
      if (u >= 0) this.requestAround(u);
    }

    // Units that lost their floor drop their furniture (round-robin, a few per frame).
    if (this.unitProps.size > 0) {
      if (this.checkKeys.length !== this.unitProps.size || this.checkStale) {
        this.checkKeys.length = 0;
        for (const k of this.unitProps.keys()) this.checkKeys.push(k);
        this.checkStale = false;
      }
      const keys = this.checkKeys;
      for (let n = 0; n < 4 && keys.length > 0; n++) {
        const u = keys[this.checkCursor++ % keys.length]!;
        if (!this.unitProps.has(u)) {
          this.checkStale = true;
          continue;
        }
        if (this.unitStanding(u)) continue;
        const [bi, f, i, j] = this.units.decode(u);
        const b = this.destruction.city.buildings[bi]!;
        const riding =
          !this.destruction.city.store.isStatic(b.slabId(f, i, j)) &&
          this.destruction.city.store.state[b.slabId(f, i, j)] !== STATE.destroyed;
        this.dropUnit(u, riding);
      }
    }

    // Undamaged interiors far from the hero go away.
    this.despawnTimer -= dt;
    if (this.despawnTimer <= 0) {
      this.despawnTimer = 1;
      const far = c.despawnDistance * c.despawnDistance;
      for (const u of [...this.unitProps.keys()]) {
        if (this.units.flags[u]! & (UFLAG.damaged | UFLAG.burnt)) continue;
        if (this.units.fire[u]! > 0) continue;
        const box = this.unitBox(u);
        const dx = (box.x0 + box.x1) / 2 - hero.x;
        const dz = (box.z0 + box.z1) / 2 - hero.z;
        if (dx * dx + dz * dz > far) this.despawn(u);
      }
    }

    // Power outages spreading: refresh affected buildings' windows and lights a few times a second.
    this.powerTimer -= dt;
    if (this.powerTimer <= 0 && this.outages.size > 0) {
      this.powerTimer = 0.2;
      for (const [bi, o] of this.outages) {
        const b = this.destruction.city.buildings[bi]!;
        const front = (this.time - o.start) * config.power.spreadFloorsPerSecond;
        if (front > b.floors + config.power.flickerBand + 1 && this.time - o.start > 10) continue;
        this.destruction.renderer.refreshBuilding(bi);
        for (const u of this.unitProps.keys())
          if (this.units.building[u] === bi) this.applyLights(u);
      }
    }

    // Real lights in the nearest lit rooms.
    this.lightTimer -= dt;
    if (this.lightTimer <= 0 && this.lights.length > 0) {
      this.lightTimer = 0.25;
      const cand: [number, number][] = [];
      for (const u of this.unitProps.keys()) {
        if (!this.unitLit(u) || this.units.fire[u]! > 0.2) continue;
        const box = this.unitBox(u);
        const dx = (box.x0 + box.x1) / 2 - camera.position.x;
        const dy = box.y1 - 0.3 - camera.position.y;
        const dz = (box.z0 + box.z1) / 2 - camera.position.z;
        const d = dx * dx + dy * dy + dz * dz;
        if (d < 80 * 80) cand.push([d, u]);
      }
      cand.sort((a, b) => a[0] - b[0]);
      this.lights.forEach((l, k) => {
        const e = cand[k];
        if (!e) {
          l.intensity = 0;
          return;
        }
        const box = this.unitBox(e[1]);
        l.position.set((box.x0 + box.x1) / 2, box.y1 - 0.4, (box.z0 + box.z1) / 2);
        l.intensity = c.lightIntensity;
        l.distance = c.lightRange;
      });
    }
    this.props.flush();
  }

  /** The unit containing a world point, or -1. */
  unitAt(x: number, y: number, z: number): number {
    const H = config.construction.floorHeight;
    let found = -1;
    this.destruction.city.forEachBuildingNear(x, y, z, 0, (b) => {
      if (found >= 0 || x < b.x0 || x > b.x1 || z < b.z0 || z > b.z1 || y < 0 || y > b.height)
        return;
      const f = Math.min(b.floors - 1, Math.floor(y / H));
      let i = 0;
      while (i < b.ncx - 2 && x > b.posX[i + 1]!) i++;
      let j = 0;
      while (j < b.ncz - 2 && z > b.posZ[j + 1]!) j++;
      found = this.units.id(b.id, f, i, j);
    });
    return found;
  }

  stats() {
    return {
      spawnedUnits: this.unitProps.size,
      props: this.props.store.liveCount,
      outages: this.outages.size,
      propsDestroyed: this.propsDestroyed,
    };
  }
}
