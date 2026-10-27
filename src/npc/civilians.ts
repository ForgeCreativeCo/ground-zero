import * as THREE from 'three/webgpu';
import { config } from '../config';
import { events } from '../core/events';
import { Rng } from '../core/rng';
import type { DebrisSystem, FloorHit } from '../destruction/debris';
import type { CityLayout } from '../world/cityLayout';
import { lightState, ringParam, ringPoint, type Streets } from '../world/streets';
import { clipRow } from './animBake';
import type { CharacterAssets } from './characterAssets';
import { FLOATS_PER_INSTANCE } from './crowdMaterial';
import type { CrowdRenderer } from './crowdRenderer';
import { CLIP_INDEX } from './poses';

/** Behaviour states (DESIGN.md §9.4). */
export const ST = {
  free: 0,
  walk: 1,
  idle: 2,
  sit: 3,
  cross: 4,
  notice: 5,
  react: 6,
  flee: 7,
  hide: 8,
  film: 9,
  injured: 10,
  fallen: 11,
  air: 12,
  dying: 13,
  dead: 14,
  enter: 15,
} as const;

export const KIND = { street: 0, occupant: 1 } as const;

const CLIP = {
  idle: CLIP_INDEX.idle!,
  phone: CLIP_INDEX.phone!,
  walk: CLIP_INDEX.walk!,
  run: CLIP_INDEX.run!,
  panic: CLIP_INDEX.panic!,
  cower: CLIP_INDEX.cower!,
  point: CLIP_INDEX.point!,
  film: CLIP_INDEX.film!,
  sit: CLIP_INDEX.sit!,
  fall: CLIP_INDEX.fall!,
  prone: CLIP_INDEX.prone!,
  crawl: CLIP_INDEX.crawl!,
  limp: CLIP_INDEX.limp!,
  dieBack: CLIP_INDEX.dieBack!,
  supine: CLIP_INDEX.supine!,
  startle: CLIP_INDEX.startle!,
  getUp: CLIP_INDEX.getUp!,
  help: CLIP_INDEX.help!,
};
/** Speed (m/s) each gait clip is authored for: playback rate follows real speed. */
const GAIT_REF: Record<number, number> = {
  [CLIP.walk]: 1.4,
  [CLIP.run]: 4.2,
  [CLIP.panic]: 6,
  [CLIP.limp]: 0.75,
  [CLIP.crawl]: 0.35,
};
const BLEND_TIME = 0.25;
const GRAVITY = 9.81;

/** A spot for standing or sitting people (benches, bus stops, shop fronts). */
export interface Spot {
  x: number;
  z: number;
  yaw: number;
  sit: boolean;
}

/** Something people notice: a punch, a blast, a collapse, a scream nearby. */
interface Threat {
  x: number;
  y: number;
  z: number;
  radius: number;
  /** 0..1: how frightening (big = startle and flee, small = look and point). */
  severity: number;
}

const _frustum = new THREE.Frustum();
const _projView = new THREE.Matrix4();
const _sphere = new THREE.Sphere();
const _rp = [0, 0, 0, 0];
const _floor: FloorHit = { y: 0, slab: -1 };

/**
 * Civilians (DESIGN.md §9.4): ambient sidewalk life, the panic state machine, injuries and deaths,
 * interior occupants, and corpses. Structure-of-arrays storage; agents are recycled out of view
 * as the hero moves. Rendering goes through CrowdRenderer (LOD tiers, GPU-skinned).
 */
export class CivilianSystem {
  readonly cap: number;
  // --- per agent ---------------------------------------------------------------------------
  readonly state: Uint8Array;
  readonly kind: Uint8Array;
  readonly body: Uint8Array;
  readonly hairA: Int8Array;
  readonly hairB: Int8Array;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly z: Float32Array;
  readonly px: Float32Array;
  readonly py: Float32Array;
  readonly pz: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  readonly vz: Float32Array;
  readonly yaw: Float32Array;
  readonly speed: Float32Array;
  /** Build: width scale (0.93..1.1). */
  readonly girth: Float32Array;
  /** Counted as a corpse (stays so while a blast throws it around). */
  readonly corpse: Uint8Array;
  readonly timer: Float32Array;
  readonly hp: Float32Array;
  readonly block: Int16Array;
  readonly ringS: Float32Array;
  readonly ringDir: Int8Array;
  readonly ringHalf: Float32Array;
  readonly tx: Float32Array;
  readonly tz: Float32Array;
  readonly calm: Float32Array;
  readonly spread: Float32Array;
  readonly clip: Uint8Array;
  readonly clipT: Float32Array;
  readonly prevClip: Uint8Array;
  readonly prevT: Float32Array;
  readonly blendT: Float32Array;
  readonly char: Float32Array;
  readonly frost: Float32Array;
  readonly unit: Int32Array;
  readonly bornAt: Float32Array;
  /** Tumbling while airborne: orientation quaternion and spin (rad/s about x/z). */
  readonly qx: Float32Array;
  readonly qy: Float32Array;
  readonly qz: Float32Array;
  readonly qw: Float32Array;
  readonly spinX: Float32Array;
  readonly spinZ: Float32Array;
  readonly deadOnLand: Uint8Array;
  /** Static look (FLOATS_PER_INSTANCE per agent; the first 12 floats are rewritten each frame). */
  readonly look: Float32Array;

  living = 0;
  corpses = 0;
  casualties = 0;
  /** Seconds since start (sim time). */
  time = 0;
  readonly stats = {
    panicking: 0,
    fleeing: 0,
    deaths: 0,
    injured: 0,
    occupants: 0,
    occupantsSpawned: 0,
  };

  private free: number[] = [];
  private rng = new Rng(0xc1717);
  private threats: Threat[] = [];
  /** Spatial hash (cell size in metres). */
  private readonly cell = 3;
  private gridN: number;
  private gridHalf: number;
  private head: Int32Array;
  private next: Int32Array;
  /** Building footprint grid (4 m cells): building index + 1, or 0. */
  private footGrid: Int16Array;
  private footN: number;
  private footHalf: number;
  private blockAt = new Map<string, number>();
  private heroX = 0;
  private heroY = 0;
  private heroZ = 0;
  private heroActive = 0;
  private hasFrustum = false;
  private camX = 0;
  private camZ = 0;
  private recycleCursor = 0;
  private floorCursor = 0;
  private corpseOrder: number[] = [];
  private unitOccupants = new Map<number, number[]>();

  constructor(
    private readonly layout: CityLayout,
    private readonly streets: Streets,
    private readonly assets: CharacterAssets,
    private readonly renderer: CrowdRenderer,
    private readonly debris: DebrisSystem,
    private readonly spots: Spot[],
  ) {
    const c = config.npc;
    this.cap = c.count + c.corpseCap + 160;
    const n = this.cap;
    const f32 = () => new Float32Array(n);
    this.state = new Uint8Array(n);
    this.kind = new Uint8Array(n);
    this.body = new Uint8Array(n);
    this.hairA = new Int8Array(n);
    this.hairB = new Int8Array(n);
    this.x = f32();
    this.y = f32();
    this.z = f32();
    this.px = f32();
    this.py = f32();
    this.pz = f32();
    this.vx = f32();
    this.vy = f32();
    this.vz = f32();
    this.yaw = f32();
    this.speed = f32();
    this.girth = f32();
    this.corpse = new Uint8Array(n);
    this.timer = f32();
    this.hp = f32();
    this.block = new Int16Array(n);
    this.ringS = f32();
    this.ringDir = new Int8Array(n);
    this.ringHalf = f32();
    this.tx = f32();
    this.tz = f32();
    this.calm = f32();
    this.spread = f32();
    this.clip = new Uint8Array(n);
    this.clipT = f32();
    this.prevClip = new Uint8Array(n);
    this.prevT = f32();
    this.blendT = f32();
    this.char = f32();
    this.frost = f32();
    this.unit = new Int32Array(n).fill(-1);
    this.bornAt = f32();
    this.qx = f32();
    this.qy = f32();
    this.qz = f32();
    this.qw = f32();
    this.spinX = f32();
    this.spinZ = f32();
    this.deadOnLand = new Uint8Array(n);
    this.look = new Float32Array(n * FLOATS_PER_INSTANCE);
    for (let i = n - 1; i >= 0; i--) this.free.push(i);

    const half = Math.max(layout.halfExtentX, layout.halfExtentZ) + 60;
    this.gridHalf = half;
    this.gridN = Math.ceil((half * 2) / this.cell);
    this.head = new Int32Array(this.gridN * this.gridN).fill(-1);
    this.next = new Int32Array(n).fill(-1);
    this.footHalf = half;
    this.footN = Math.ceil((half * 2) / 4);
    this.footGrid = new Int16Array(this.footN * this.footN);
    layout.buildings.forEach((b, bi) => {
      for (let gx = b.x - b.w / 2; gx <= b.x + b.w / 2; gx += 2)
        for (let gz = b.z - b.d / 2; gz <= b.z + b.d / 2; gz += 2) {
          const k = this.footIndex(gx, gz);
          if (k >= 0) this.footGrid[k] = bi + 1;
        }
    });
    layout.blocks.forEach((b, k) => this.blockAt.set(`${b.i},${b.j}`, k));

    this.wireEvents();
  }

  // --- spatial queries -------------------------------------------------------------------------

  private footIndex(x: number, z: number) {
    const i = Math.floor((x + this.footHalf) / 4);
    const j = Math.floor((z + this.footHalf) / 4);
    if (i < 0 || j < 0 || i >= this.footN || j >= this.footN) return -1;
    return j * this.footN + i;
  }

  /** Inside a building footprint (people walk around them). */
  blocked(x: number, z: number) {
    const k = this.footIndex(x, z);
    if (k < 0) return false;
    const bi = this.footGrid[k]! - 1;
    if (bi < 0) return false;
    const b = this.layout.buildings[bi]!;
    return Math.abs(x - b.x) < b.w / 2 && Math.abs(z - b.z) < b.d / 2;
  }

  private cellOf(x: number, z: number) {
    const i = Math.floor((x + this.gridHalf) / this.cell);
    const j = Math.floor((z + this.gridHalf) / this.cell);
    if (i < 0 || j < 0 || i >= this.gridN || j >= this.gridN) return -1;
    return j * this.gridN + i;
  }

  private rebuildGrid() {
    this.head.fill(-1);
    for (let i = 0; i < this.cap; i++) {
      if (this.state[i] === ST.free) continue;
      const c = this.cellOf(this.x[i]!, this.z[i]!);
      if (c < 0) continue;
      this.next[i] = this.head[c]!;
      this.head[c] = i;
    }
  }

  /** Calls fn for every person (alive or dead) within r of (x, z). */
  forEachNear(x: number, z: number, r: number, fn: (i: number, d2: number) => void) {
    const c = this.cell;
    const i0 = Math.floor((x - r + this.gridHalf) / c);
    const i1 = Math.floor((x + r + this.gridHalf) / c);
    const j0 = Math.floor((z - r + this.gridHalf) / c);
    const j1 = Math.floor((z + r + this.gridHalf) / c);
    const r2 = r * r;
    for (let j = Math.max(0, j0); j <= Math.min(this.gridN - 1, j1); j++)
      for (let i = Math.max(0, i0); i <= Math.min(this.gridN - 1, i1); i++) {
        for (let a = this.head[j * this.gridN + i]!; a >= 0; a = this.next[a]!) {
          const dx = this.x[a]! - x;
          const dz = this.z[a]! - z;
          const d2 = dx * dx + dz * dz;
          if (d2 <= r2) fn(a, d2);
        }
      }
  }

  isAlive(i: number) {
    const s = this.state[i]!;
    return (
      s !== ST.free && s !== ST.dead && s !== ST.dying && !(s === ST.air && this.deadOnLand[i])
    );
  }

  // --- spawning --------------------------------------------------------------------------------

  private alloc(): number {
    const i = this.free.pop();
    return i ?? -1;
  }

  private release(i: number) {
    if (this.state[i] === ST.free) return;
    if (this.corpse[i]) {
      this.corpses--;
    } else {
      this.living--;
      if (this.kind[i] === KIND.occupant) this.stats.occupants--;
    }
    const u = this.unit[i]!;
    if (u >= 0) {
      const list = this.unitOccupants.get(u);
      if (list) {
        const k = list.indexOf(i);
        if (k >= 0) list.splice(k, 1);
      }
    }
    this.unit[i] = -1;
    this.state[i] = ST.free;
    this.free.push(i);
  }

  /** Random look: body, height, clothes, skin tone, hair (DESIGN.md §9.2 variety). */
  private dress(i: number) {
    const r = this.rng;
    const c = config.npc;
    const body = r.next() < 0.5 ? 0 : 1;
    this.body[i] = body;
    const styles = this.assets.hairStyles[body]!;
    if (body === 0) {
      // Male: buzzed / parted / bald, sometimes a beard.
      const k = r.next();
      this.hairA[i] =
        k < 0.45
          ? styles.indexOf('Hair_Buzzed')
          : k < 0.9
            ? styles.indexOf('Hair_SimpleParted')
            : -1;
      this.hairB[i] = r.next() < 0.3 ? styles.indexOf('Hair_Beard') : -1;
    } else {
      const k = r.next();
      this.hairA[i] =
        k < 0.55
          ? styles.indexOf('Hair_Long')
          : k < 0.88
            ? styles.indexOf('Hair_Buns')
            : styles.indexOf('Hair_BuzzedFemale');
      this.hairB[i] = -1;
    }
    const o = i * FLOATS_PER_INSTANCE;
    const L = this.look;
    // Height (iPos.w) and width (iAnim.w) are kept in the look record's spare slots.
    // Height scale (iPos.w); build width (iAnim.w, written each frame from `girth`).
    L[o + 3] = 1 + (r.next() + r.next() - 1) * c.heightVariation;
    this.girth[i] = r.range(0.93, 1.1);
    // Skin (iSkin.rgb) and sleeve length (iSkin.w).
    const tone = r.range(c.skinTone[0], c.skinTone[1]) ** 1.3;
    L[o + 12] = lerp(1, 0.36, tone);
    L[o + 13] = lerp(0.97, 0.235, tone);
    L[o + 14] = lerp(0.95, 0.17, tone);
    const sleeve = r.next();
    L[o + 15] = sleeve < 0.25 ? 0 : sleeve < 0.7 ? 1 : 2;
    // Shirt + trouser length.
    hsvLinear(
      r.next(),
      r.range(c.clothSaturation[0], c.clothSaturation[1]),
      r.range(c.clothValue[0], c.clothValue[1]),
      L,
      o + 16,
    );
    L[o + 19] = r.next() < (body === 0 ? 0.85 : 0.7) ? 1 : 0;
    // Trousers: mostly darker, desaturated (jeans, chinos, black).
    const jeans = r.next() < 0.4;
    if (jeans) {
      L[o + 20] = 0.03;
      L[o + 21] = 0.06;
      L[o + 22] = r.range(0.12, 0.2);
    } else hsvLinear(r.next(), r.range(0, 0.35), r.range(0.05, 0.45), L, o + 20);
    L[o + 23] = Math.floor(r.next() * 4);
    // Hair colour.
    const hc = HAIR_COLORS[Math.floor(r.next() * HAIR_COLORS.length)]!;
    const shade = r.range(0.8, 1.2);
    L[o + 24] = hc[0]! * shade;
    L[o + 25] = hc[1]! * shade;
    L[o + 26] = hc[2]! * shade;
    L[o + 27] = 0;
    this.char[i] = 0;
    this.frost[i] = 0;
  }

  private activate(i: number, kind: number, x: number, y: number, z: number, yaw: number) {
    this.dress(i);
    this.kind[i] = kind;
    this.x[i] = this.px[i] = x;
    this.y[i] = this.py[i] = y;
    this.z[i] = this.pz[i] = z;
    this.vx[i] = this.vy[i] = this.vz[i] = 0;
    this.yaw[i] = yaw;
    this.hp[i] = config.npc.hp;
    this.speed[i] = this.rng.range(config.npc.walkSpeed[0], config.npc.walkSpeed[1]);
    this.timer[i] = 0;
    this.calm[i] = 0;
    this.spread[i] = 0;
    this.deadOnLand[i] = 0;
    this.unit[i] = -1;
    this.clipT[i] = this.rng.range(0, 4);
    this.prevT[i] = 0;
    this.blendT[i] = BLEND_TIME;
    this.bornAt[i] = this.time;
    this.corpse[i] = 0;
  }

  /** Places a street civilian on a random sidewalk ring of a block (or a spot). */
  private placeStreet(i: number, bx: number, preferSpot: boolean) {
    const c = config.npc;
    const blocks = this.layout.blocks;
    const half0 = this.streets.blockSize / 2;
    if (preferSpot && this.spots.length) {
      const sp = this.spots[Math.floor(this.rng.next() * this.spots.length)]!;
      this.activate(i, KIND.street, sp.x, 0, sp.z, sp.yaw);
      this.state[i] = sp.sit ? ST.sit : ST.idle;
      this.setClip(i, sp.sit ? CLIP.sit : this.rng.next() < 0.5 ? CLIP.phone : CLIP.idle, true);
      this.timer[i] = this.rng.range(10, 60);
      this.block[i] = this.nearestBlock(sp.x, sp.z);
      return;
    }
    const b = blocks[bx]!;
    const lateral = this.rng.range(-c.laneSpread, c.laneSpread);
    const half = half0 - c.laneOffset + lateral;
    const s = this.rng.range(0, half * 8);
    ringPoint(b.x, b.z, half, s, _rp);
    const dir = this.rng.next() < 0.5 ? 1 : -1;
    this.activate(i, KIND.street, _rp[0]!, 0, _rp[1]!, Math.atan2(_rp[2]! * dir, _rp[3]! * dir));
    this.block[i] = bx;
    this.ringS[i] = s;
    this.ringDir[i] = dir;
    this.ringHalf[i] = half;
    this.state[i] = ST.walk;
    this.setClip(i, CLIP.walk, true);
  }

  private nearestBlock(x: number, z: number) {
    const p = this.streets.pitch;
    const cx = (config.city.blocksX - 1) / 2;
    const cz = (config.city.blocksZ - 1) / 2;
    const i = Math.min(config.city.blocksX - 1, Math.max(0, Math.round(x / p + cx)));
    const j = Math.min(config.city.blocksZ - 1, Math.max(0, Math.round(z / p + cz)));
    return this.blockAt.get(`${i},${j}`) ?? 0;
  }

  /** Populates the streets around a point at startup (anywhere, in view or not). */
  populate(hx: number, hz: number) {
    const c = config.npc;
    const near: number[] = [];
    this.layout.blocks.forEach((b, k) => {
      if (Math.hypot(b.x - hx, b.z - hz) < c.liveRadius + this.streets.blockSize / 2) near.push(k);
    });
    if (!near.length) return;
    for (let n = 0; n < c.count; n++) {
      const i = this.alloc();
      if (i < 0) break;
      this.placeStreet(
        i,
        near[Math.floor(this.rng.next() * near.length)]!,
        this.rng.next() < c.idleShare,
      );
      this.living++;
    }
  }

  /** A new walker out of the camera's view, between minSpawnDistance and liveRadius. */
  private respawnOutOfView(i: number): boolean {
    const c = config.npc;
    for (let tries = 0; tries < 8; tries++) {
      const a = this.rng.range(0, Math.PI * 2);
      const d = this.rng.range(c.minSpawnDistance, c.liveRadius);
      const x = this.heroX + Math.cos(a) * d;
      const z = this.heroZ + Math.sin(a) * d;
      if (Math.abs(x) > this.layout.halfExtentX || Math.abs(z) > this.layout.halfExtentZ) continue;
      if (this.inView(x, 1, z, 1.5)) continue;
      const bx = this.nearestBlock(x, z);
      const b = this.layout.blocks[bx]!;
      const half =
        this.streets.blockSize / 2 - c.laneOffset + this.rng.range(-c.laneSpread, c.laneSpread);
      const s = ringParam(b.x, b.z, half, x, z);
      ringPoint(b.x, b.z, half, s, _rp);
      if (this.inView(_rp[0]!, 1, _rp[1]!, 1.5)) continue;
      if (Math.hypot(_rp[0]! - this.heroX, _rp[1]! - this.heroZ) < c.minSpawnDistance) continue;
      this.placeStreet(i, bx, false);
      this.ringHalf[i] = half;
      this.ringS[i] = s;
      this.x[i] = this.px[i] = _rp[0]!;
      this.z[i] = this.pz[i] = _rp[1]!;
      return true;
    }
    return false;
  }

  private inView(x: number, y: number, z: number, r: number) {
    if (!this.hasFrustum) return false;
    _sphere.center.set(x, y, z);
    _sphere.radius = r;
    return _frustum.intersectsSphere(_sphere);
  }

  /** Someone appears running (a driver bailing out of their car), fleeing from (tx, tz). */
  spawnFleeing(x: number, z: number, tx: number, tz: number) {
    const i = this.alloc();
    if (i < 0) return -1;
    this.activate(i, KIND.street, x, 0, z, Math.atan2(x - tx, z - tz));
    this.block[i] = this.nearestBlock(x, z);
    this.ringDir[i] = 1;
    this.tx[i] = tx;
    this.tz[i] = tz;
    this.living++;
    this.startFlee(i);
    return i;
  }

  // --- interior occupants ----------------------------------------------------------------------

  /** A breached unit was furnished: put some people in it. */
  spawnOccupants(
    u: number,
    x0: number,
    x1: number,
    y0: number,
    z0: number,
    z1: number,
    retail: boolean,
  ) {
    const c = config.npc;
    const n = this.rng.int(c.occupantsPerUnit[0], c.occupantsPerUnit[1] + (retail ? 1 : 0));
    const list: number[] = [];
    for (let k = 0; k < n; k++) {
      const i = this.alloc();
      if (i < 0) break;
      const x = this.rng.range(x0 + 0.8, x1 - 0.8);
      const z = this.rng.range(z0 + 0.8, z1 - 0.8);
      this.activate(i, KIND.occupant, x, y0, z, this.rng.range(-Math.PI, Math.PI));
      this.unit[i] = u;
      this.state[i] = ST.idle;
      this.timer[i] = 1e9;
      this.setClip(i, this.rng.next() < 0.4 ? CLIP.phone : CLIP.idle, true);
      this.block[i] = this.nearestBlock(x, z);
      this.stats.occupants++;
      this.stats.occupantsSpawned++;
      this.living++;
      list.push(i);
    }
    if (list.length) this.unitOccupants.set(u, list);
  }

  /** An undamaged unit was cleared away (hero far): calm occupants leave with it. */
  despawnOccupants(u: number) {
    const list = this.unitOccupants.get(u);
    if (!list) return;
    for (const i of [...list]) if (this.state[i] === ST.idle) this.release(i);
    if (!list.length) this.unitOccupants.delete(u);
  }

  // --- threats and panic -----------------------------------------------------------------------

  /** Something frightening happened (DESIGN.md §9.4 "Notice"). */
  alarm(x: number, y: number, z: number, radius: number, severity: number) {
    if (this.threats.length < 64) this.threats.push({ x, y, z, radius, severity });
  }

  private wireEvents() {
    const c = () => config.npc;
    const blastR = (r: number) =>
      clamp(r * c().noticeRadiusBlast, c().noticeRadiusMin, c().noticeRadiusMax);
    events.on('player:punch', (e) => {
      if (e.target !== 'none') this.alarm(e.x, e.y, e.z, c().noticeRadiusPunch, 0.5);
    });
    events.on('player:slam', (e) => this.alarm(e.x, e.y, e.z, blastR(e.radius), 1));
    events.on('power:energyBlast', (e) => this.alarm(e.x, e.y, e.z, blastR(e.radius), 1));
    events.on('nova:windup', (e) => this.alarm(e.x, e.y, e.z, c().noticeRadiusMax, 1));
    events.on('nova:release', (e) => this.alarm(e.x, e.y, e.z, 1e4, 1));
    events.on('building:stress', (e) => this.alarm(e.x, e.y, e.z, 150, 0.8));
    events.on('building:collapse', (e) => this.alarm(e.x, 0, e.z, 260, 1));
    events.on('player:sonicBoom', (e) => this.alarm(e.x, e.y, e.z, 160, 0.6));
    events.on('glass:shatter', (e) => this.alarm(e.x, e.y, e.z, 30, 0.4));
    events.on('heat:burnThrough', (e) => this.alarm(e.x, e.y, e.z, 40, 0.6));
    events.on('player:landing', (e) => {
      if (e.hard) this.alarm(e.x, e.y, e.z, 50, 0.5);
    });
    events.on('vehicle:explode', (e) => this.alarm(e.x, e.y, e.z, 120, 1));
    events.on('vehicle:crash', (e) => this.alarm(e.x, e.y, e.z, 40, 0.5));
  }

  private processThreats() {
    if (!this.threats.length) return;
    const c = config.npc;
    for (const t of this.threats) {
      this.forEachNear(t.x, t.z, t.radius, (i, d2) => {
        if (!this.isAlive(i)) return;
        const s = this.state[i]!;
        const d = Math.sqrt(d2);
        // Sound travels; people react after a moment.
        const delay = d / 340 + this.rng.range(0, c.reactDelay);
        if (s === ST.flee || s === ST.hide || s === ST.film || s === ST.react || s === ST.notice) {
          // Already scared: a new threat closer than the old one takes over.
          const od = Math.hypot(this.tx[i]! - this.x[i]!, this.tz[i]! - this.z[i]!);
          if (d < od) {
            this.tx[i] = t.x;
            this.tz[i] = t.z;
          }
          this.calm[i] = 0;
          if (s === ST.film && d < 30) this.startFlee(i);
          if (s === ST.hide && d < 8) this.startFlee(i);
          return;
        }
        if (s === ST.injured || s === ST.fallen || s === ST.air) return;
        this.state[i] = ST.notice;
        this.timer[i] = delay;
        this.tx[i] = t.x;
        this.tz[i] = t.z;
        this.calm[i] = 0;
        // Severity in the timer sign trick: keep it in `spread` until react.
        this.spread[i] = t.severity * Math.max(0.2, 1 - d / t.radius);
      });
    }
    this.threats.length = 0;
  }

  private startFlee(i: number) {
    this.state[i] = ST.flee;
    this.speed[i] = this.rng.range(config.npc.panicSpeed[0], config.npc.panicSpeed[1]);
    this.setClip(
      i,
      this.kind[i] === KIND.occupant && this.rng.next() < 0.3 ? CLIP.run : CLIP.panic,
      false,
    );
    this.spread[i] = this.rng.range(0, config.npc.spreadDelay);
    this.calm[i] = 0;
  }

  // --- damage ----------------------------------------------------------------------------------

  /** Kills person i, throwing them with velocity v (m/s). */
  kill(i: number, vx: number, vy: number, vz: number, cause: string) {
    if (!this.isAlive(i)) return;
    this.hp[i] = 0;
    this.casualties++;
    this.stats.deaths++;
    events.emit('npc:death', { x: this.x[i]!, y: this.y[i]!, z: this.z[i]!, cause });
    // Witnesses scream and run.
    this.alarm(this.x[i]!, this.y[i]!, this.z[i]!, 30, 0.9);
    const sp = Math.hypot(vx, vy, vz);
    if (sp > 3 || vy > 1.5) {
      this.launch(i, vx, vy, vz);
      this.deadOnLand[i] = 1;
    } else {
      this.state[i] = ST.dying;
      this.timer[i] = 1.2;
      this.setClip(i, this.rng.next() < 0.5 ? CLIP.dieBack : CLIP.fall, true);
    }
  }

  private launch(i: number, vx: number, vy: number, vz: number) {
    this.state[i] = ST.air;
    this.vx[i] = vx;
    this.vy[i] = Math.max(vy, 1);
    this.vz[i] = vz;
    // Start the tumble from the current facing.
    const h = this.yaw[i]! / 2;
    this.qx[i] = 0;
    this.qy[i] = Math.sin(h);
    this.qz[i] = 0;
    this.qw[i] = Math.cos(h);
    const sp = Math.hypot(vx, vz);
    this.spinX[i] = this.rng.range(-1, 1) * (2 + sp * 0.4);
    this.spinZ[i] = this.rng.range(-1, 1) * (2 + sp * 0.4);
    this.setClip(i, CLIP.fall, true);
    if (this.kind[i] === KIND.occupant) this.detachUnit(i);
  }

  private detachUnit(i: number) {
    const u = this.unit[i]!;
    if (u < 0) return;
    const list = this.unitOccupants.get(u);
    if (list) {
      const k = list.indexOf(i);
      if (k >= 0) list.splice(k, 1);
    }
    this.unit[i] = -1;
  }

  /** Damage with a push: kills above HP, injures (knocked down, then limping/crawling) below. */
  hurt(i: number, dmg: number, vx: number, vy: number, vz: number, cause: string) {
    if (!this.isAlive(i) || dmg <= 0) return;
    if (this.frost[i]! >= 1) {
      // Frozen solid: any real hit shatters the statue (the full ice-chunk version is M6).
      this.shatterFrozen(i);
      return;
    }
    this.hp[i] = this.hp[i]! - dmg;
    if (this.hp[i]! <= 0) {
      this.kill(i, vx, vy, vz, cause);
      return;
    }
    if (dmg > config.npc.hp * config.npc.injureFraction * 0.3) {
      this.stats.injured++;
      if (Math.hypot(vx, vy, vz) > 2) this.launch(i, vx, vy, vz);
      else this.knockDown(i);
    }
    this.alarm(this.x[i]!, this.y[i]!, this.z[i]!, 20, 0.8);
  }

  private knockDown(i: number) {
    this.state[i] = ST.fallen;
    this.timer[i] = this.rng.range(1.6, 3);
    this.setClip(i, CLIP.fall, true);
  }

  private shatterFrozen(i: number) {
    events.emit('npc:shatter', { x: this.x[i]!, y: this.y[i]! + 1, z: this.z[i]! });
    if (this.isAlive(i)) {
      this.casualties++;
      this.stats.deaths++;
      events.emit('npc:death', { x: this.x[i]!, y: this.y[i]!, z: this.z[i]!, cause: 'shatter' });
    }
    this.release(i);
  }

  /** Blast: damage falls off with distance; everyone inside is thrown outward. */
  blast(
    x: number,
    y: number,
    z: number,
    r: number,
    damage: number,
    launch: number,
    cause = 'blast',
  ) {
    const c = config.npc;
    this.forEachNear(x, z, r, (i, d2) => {
      const dy = this.y[i]! + 1 - y;
      const d = Math.sqrt(d2 + dy * dy);
      if (d > r) return;
      const k = 1 - d / r;
      const dmg = damage * k;
      const inv = 1 / Math.max(0.5, Math.sqrt(d2));
      const push = launch * c.blastLaunch * (0.4 + k);
      const vx = (this.x[i]! - x) * inv * push;
      const vz = (this.z[i]! - z) * inv * push;
      const vy = push * 0.6 + k * 4;
      if (this.frost[i]! >= 1 && dmg > 5) {
        this.shatterFrozen(i);
        return;
      }
      if (this.state[i] === ST.dead) {
        // Corpses get thrown too.
        if (push > 3) {
          this.launch(i, vx, vy, vz);
          this.deadOnLand[i] = 1;
        }
        return;
      }
      if (this.frost[i]! >= 1 && dmg > 5) {
        this.shatterFrozen(i);
        return;
      }
      this.hurt(i, dmg, vx, vy, vz, cause);
    });
  }

  /** Heat vision beam hitting a point: burns, then chars, whoever is there. */
  beam(x: number, y: number, z: number, dt: number) {
    this.forEachNear(x, z, 1.4, (i) => {
      if (Math.abs(this.y[i]! + 1 - y) > 1.6) return;
      this.char[i] = Math.min(1, this.char[i]! + dt * 2.2);
      if (this.isAlive(i)) {
        this.frost[i] = 0;
        this.hurt(i, dt * 260, 0, 0, 0, 'heat');
      }
    });
  }

  /** Freeze breath: people in the cone frost over and become statues. */
  freezeCone(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    range: number,
    cosHalf: number,
    dt: number,
  ) {
    this.forEachNear(ox + dx * range * 0.5, oz + dz * range * 0.5, range * 0.6, (i) => {
      const px = this.x[i]! - ox;
      const py = this.y[i]! + 1 - oy;
      const pz = this.z[i]! - oz;
      const d = Math.hypot(px, py, pz);
      if (d > range || d < 0.1) return;
      if ((px * dx + py * dy + pz * dz) / d < cosHalf) return;
      if (!this.isAlive(i) && this.state[i] !== ST.dead) return;
      const was = this.frost[i]!;
      this.frost[i] = Math.min(1, was + dt * 1.6);
      this.char[i] = 0;
      if (this.frost[i]! >= 1 && was < 1 && this.isAlive(i)) {
        // Frozen solid where they stand: dead, a statue in their last pose.
        this.casualties++;
        this.stats.deaths++;
        events.emit('npc:death', { x: this.x[i]!, y: this.y[i]!, z: this.z[i]!, cause: 'freeze' });
        this.toCorpse(i);
      }
    });
  }

  /** The hero moving at speed: people in his path are knocked flying or obliterated. */
  heroPass(x: number, y: number, z: number, vx: number, vy: number, vz: number) {
    const c = config.npc;
    const speed = Math.hypot(vx, vy, vz);
    this.heroX = x;
    this.heroY = y;
    this.heroZ = z;
    if (speed < 2) return;
    const r = c.heroKnockRadius * (1 + Math.min(2, speed / 120));
    this.forEachNear(x, z, r, (i) => {
      if (Math.abs(this.y[i]! + 0.9 - (y + 1)) > r + 0.5) return;
      if (speed >= c.heroKnockSpeed) {
        const lethal = speed > c.heroKnockSpeed * 2;
        const k = Math.min(1.4, speed / 60);
        const dmg = lethal ? 1e4 : speed * 2.5;
        if (this.state[i] === ST.dead || this.frost[i]! >= 1) {
          if (this.frost[i]! >= 1) this.shatterFrozen(i);
          return;
        }
        this.hurt(
          i,
          dmg,
          vx * k + (this.x[i]! - x) * 2,
          Math.abs(vy) * 0.3 + 3 + speed * 0.05,
          vz * k + (this.z[i]! - z) * 2,
          'hero',
        );
      } else if (this.isAlive(i)) {
        // Walking hero: people step aside.
        const dx = this.x[i]! - x;
        const dz = this.z[i]! - z;
        const d = Math.hypot(dx, dz) || 1;
        if (d < 0.9) {
          this.x[i] = x + (dx / d) * 0.9;
          this.z[i] = z + (dz / d) * 0.9;
        }
      }
    });
  }

  /**
   * The Nova front passing radius r0..r1 (DESIGN.md §6.6): vaporised in the core (gone in the
   * flash), flung and burning in the blast zone, knocked down and hurt out to the edge.
   */
  novaRing(cx: number, cy: number, cz: number, r0: number, r1: number, R: number) {
    const n = config.nova;
    const fr = n.fringeFraction;
    this.forEachNear(cx, cz, Math.min(r1, R * fr), (i, d2) => {
      const dy = this.y[i]! - cy;
      const d = Math.sqrt(d2 + dy * dy);
      if (d < r0 || d >= r1) return;
      const f = d / R;
      const h = Math.max(1, Math.sqrt(d2));
      const ux = (this.x[i]! - cx) / h;
      const uz = (this.z[i]! - cz) / h;
      if (f <= n.coreFraction) {
        // Vaporised: an ash burst where they stood (the full effect is M6).
        if (this.isAlive(i)) {
          this.casualties++;
          this.stats.deaths++;
          events.emit('npc:death', { x: this.x[i]!, y: this.y[i]!, z: this.z[i]!, cause: 'nova' });
        }
        events.emit('npc:shatter', { x: this.x[i]!, y: this.y[i]! + 1, z: this.z[i]! });
        this.release(i);
        return;
      }
      if (f <= n.blastFraction) {
        const k = 1 - (f - n.coreFraction) / (n.blastFraction - n.coreFraction);
        const sp = n.blastLaunch * (0.25 + 0.6 * k);
        this.char[i] = Math.max(this.char[i]!, 0.3 + 0.7 * k);
        this.frost[i] = 0;
        if (this.state[i] === ST.dead) {
          this.launch(i, ux * sp, sp * 0.3, uz * sp);
          this.deadOnLand[i] = 1;
        } else this.kill(i, ux * sp, sp * 0.3 + 3, uz * sp, 'nova');
        return;
      }
      if (f <= fr && this.isAlive(i)) {
        const k = 1 - (f - n.blastFraction) / (fr - n.blastFraction);
        this.hurt(i, config.npc.hp * (0.2 + 0.9 * k), ux * 10 * k, 2 + 3 * k, uz * 10 * k, 'nova');
      }
    });
  }

  /** Strength: a punch aimed along a ray. Returns the person hit (or -1). */
  punchRay(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    reach: number,
  ): number {
    let best = -1;
    let bestT = reach;
    this.forEachNear(ox + dx * reach * 0.5, oz + dz * reach * 0.5, reach * 0.5 + 1.5, (i) => {
      if (this.state[i] === ST.free) return;
      // Closest approach of the ray to the body's axis (a vertical segment).
      const cx = this.x[i]! - ox;
      const cz = this.z[i]! - oz;
      const t = cx * dx + cz * dz;
      if (t < 0 || t > bestT) return;
      const ex = cx - dx * t;
      const ez = cz - dz * t;
      if (ex * ex + ez * ez > 0.6 * 0.6) return;
      const hy = oy + dy * t - this.y[i]!;
      const lying = this.state[i] === ST.dead || this.state[i] === ST.injured;
      if (hy < -0.4 || hy > (lying ? 0.8 : 2.1)) return;
      best = i;
      bestT = t;
    });
    return best;
  }

  /** Something heavy landed: anyone under it is crushed. */
  crush(x: number, y: number, z: number, r: number) {
    this.forEachNear(x, z, r, (i) => {
      if (this.y[i]! > y + 1.5) return;
      if (this.isAlive(i)) this.kill(i, 0, 0, 0, 'crush');
    });
  }

  private toCorpse(i: number) {
    this.state[i] = ST.dead;
    this.deadOnLand[i] = 0;
    this.vx[i] = this.vy[i] = this.vz[i] = 0;
    if (this.corpse[i]) return;
    this.corpse[i] = 1;
    if (this.kind[i] === KIND.occupant) {
      this.stats.occupants--;
      this.detachUnit(i);
    }
    this.living--;
    this.corpses++;
    this.corpseOrder.push(i);
  }

  // --- simulation ------------------------------------------------------------------------------

  fixedUpdate(dt: number, heroX: number, heroY: number, heroZ: number, heroAlarm: boolean) {
    this.time += dt;
    this.heroX = heroX;
    this.heroY = heroY;
    this.heroZ = heroZ;
    if (heroAlarm) this.heroActive = 4;
    this.heroActive = Math.max(0, this.heroActive - dt);
    this.rebuildGrid();
    this.processThreats();
    const c = config.npc;
    let panicking = 0;
    let fleeing = 0;
    for (let i = 0; i < this.cap; i++) {
      const s = this.state[i]!;
      if (s === ST.free) continue;
      this.px[i] = this.x[i]!;
      this.py[i] = this.y[i]!;
      this.pz[i] = this.z[i]!;
      this.blendT[i] = this.blendT[i]! + dt;
      if (s >= ST.notice && s <= ST.film) panicking++;
      if (s === ST.flee) fleeing++;
      switch (s) {
        case ST.walk:
          this.walk(i, dt);
          break;
        case ST.idle:
        case ST.sit:
          this.timer[i] = this.timer[i]! - dt;
          if (this.timer[i]! <= 0 && this.kind[i] === KIND.street) this.resumeWalk(i);
          break;
        case ST.cross:
          this.crossStreet(i, dt);
          break;
        case ST.enter:
          this.enter(i, dt);
          break;
        case ST.notice:
          this.timer[i] = this.timer[i]! - dt;
          if (this.timer[i]! <= 0) this.react(i);
          break;
        case ST.react:
          this.face(i, this.tx[i]!, this.tz[i]!, dt);
          this.timer[i] = this.timer[i]! - dt;
          if (this.timer[i]! <= 0) this.afterReact(i);
          break;
        case ST.flee:
          this.flee(i, dt);
          break;
        case ST.hide:
        case ST.film:
          if (s === ST.film) this.face(i, this.tx[i]!, this.tz[i]!, dt);
          this.calm[i] = this.calm[i]! + dt;
          if (this.calm[i]! > c.calmTime) this.resumeWalk(i);
          break;
        case ST.injured:
          this.injured(i, dt);
          break;
        case ST.fallen:
          this.timer[i] = this.timer[i]! - dt;
          if (this.timer[i]! <= 0) {
            if (this.clip[i] === CLIP.fall || this.clip[i] === CLIP.prone) {
              this.setClip(i, CLIP.getUp, true);
              this.timer[i] = 1.3;
            } else if (this.hp[i]! < c.hp * 0.6) this.becomeInjured(i);
            else this.startFlee(i);
          } else if (this.clip[i] === CLIP.fall && this.clipT[i]! > 1)
            this.setClip(i, CLIP.prone, true);
          break;
        case ST.air:
          this.air(i, dt);
          break;
        case ST.dying:
          this.timer[i] = this.timer[i]! - dt;
          if (this.timer[i]! <= 0) this.toCorpse(i);
          break;
        case ST.dead:
          break;
      }
      if (s !== ST.dead && s !== ST.air && s !== ST.dying) this.settle(i, dt);
      this.advanceClip(i, dt);
    }
    this.stats.panicking = panicking;
    this.stats.fleeing = fleeing;
    this.recycle();
    this.trimCorpses();
  }

  private walk(i: number, dt: number) {
    const c = config.npc;
    const b = this.layout.blocks[this.block[i]!]!;
    const half = this.ringHalf[i]!;
    const side = half * 2;
    const before = this.ringS[i]!;
    const after = before + this.ringDir[i]! * this.speed[i]! * dt;
    this.ringS[i] = after;
    // Passing a corner: maybe cross the street to the next block.
    const kb = Math.floor(before / side);
    const ka = Math.floor(after / side);
    if (kb !== ka && this.rng.next() < 0.35 && this.startCross(i, this.ringDir[i]! > 0 ? ka : kb))
      return;
    ringPoint(b.x, b.z, half, after, _rp);
    this.moveToward(i, _rp[0]!, _rp[1]!, this.speed[i]!, dt);
    if (this.rng.next() < c.stopChance * dt) {
      const k = this.rng.next();
      if (k < 0.5) {
        this.state[i] = ST.idle;
        this.timer[i] = this.rng.range(3, 15);
        this.setClip(i, this.rng.next() < 0.5 ? CLIP.phone : CLIP.idle, false);
      } else if (k < 0.7 && !this.inView(this.x[i]!, 1, this.z[i]!, 1)) {
        // Walk into a building (only out of view: there are no door meshes).
        this.state[i] = ST.enter;
      }
    }
  }

  private resumeWalk(i: number) {
    const c = config.npc;
    const bx = this.nearestBlock(this.x[i]!, this.z[i]!);
    const b = this.layout.blocks[bx]!;
    const half =
      this.streets.blockSize / 2 - c.laneOffset + this.rng.range(-c.laneSpread, c.laneSpread);
    this.block[i] = bx;
    this.ringHalf[i] = half;
    this.ringS[i] = ringParam(b.x, b.z, half, this.x[i]!, this.z[i]!);
    if (this.ringDir[i] === 0) this.ringDir[i] = 1;
    this.state[i] = ST.walk;
    this.speed[i] = this.rng.range(c.walkSpeed[0], c.walkSpeed[1]);
    this.setClip(i, CLIP.walk, false);
  }

  /** Corner k (0: -x-z, 1: +x-z, 2: +x+z, 3: -x+z): cross to a neighbouring block. */
  private startCross(i: number, k: number): boolean {
    const blk = this.layout.blocks[this.block[i]!]!;
    const corner = ((k % 4) + 4) % 4;
    const sx = corner === 1 || corner === 2 ? 1 : -1;
    const sz = corner >= 2 ? 1 : -1;
    const alongX = this.rng.next() < 0.5;
    const ni = blk.i + (alongX ? sx : 0);
    const nj = blk.j + (alongX ? 0 : sz);
    const nb = this.blockAt.get(`${ni},${nj}`);
    if (nb === undefined) return false;
    const nbk = this.layout.blocks[nb]!;
    const half = this.ringHalf[i]!;
    this.tx[i] = alongX ? nbk.x - sx * half : blk.x + sx * half;
    this.tz[i] = alongX ? blk.z + sz * half : nbk.z - sz * half;
    this.block[i] = nb;
    this.state[i] = ST.cross;
    this.timer[i] = alongX ? 0 : 1;
    return true;
  }

  private crossStreet(i: number, dt: number) {
    // Wait at the kerb unless traffic parallel to the crossing has green; once off the kerb, go.
    const axis: 0 | 1 = this.timer[i]! < 0.5 ? 0 : 1;
    const d = Math.hypot(this.tx[i]! - this.x[i]!, this.tz[i]! - this.z[i]!);
    const started = d < config.city.streetWidth + 2 * config.npc.laneOffset - 0.8;
    if (!started) {
      const node = this.nearestNode(this.x[i]!, this.z[i]!);
      const c = config.traffic;
      if (node && lightState(node, axis, this.time, c.greenTime, c.amberTime) !== 0) {
        if (this.clip[i] !== CLIP.idle) this.setClip(i, CLIP.idle, false);
        this.face(i, this.tx[i]!, this.tz[i]!, dt);
        return;
      }
    }
    if (this.clip[i] !== CLIP.walk) this.setClip(i, CLIP.walk, false);
    if (this.moveToward(i, this.tx[i]!, this.tz[i]!, this.speed[i]! * 1.1, dt)) {
      const b = this.layout.blocks[this.block[i]!]!;
      this.ringS[i] = ringParam(b.x, b.z, this.ringHalf[i]!, this.x[i]!, this.z[i]!);
      this.state[i] = ST.walk;
    }
  }

  private nearestNode(x: number, z: number) {
    const st = this.streets;
    let bi = 0;
    let bd = Infinity;
    for (let k = 0; k < st.xs.length; k++) {
      const d = Math.abs(st.xs[k]! - x);
      if (d < bd) {
        bd = d;
        bi = k;
      }
    }
    let bj = 0;
    bd = Infinity;
    for (let k = 0; k < st.zs.length; k++) {
      const d = Math.abs(st.zs[k]! - z);
      if (d < bd) {
        bd = d;
        bj = k;
      }
    }
    return st.nodes[bj * st.xs.length + bi];
  }

  private enter(i: number, dt: number) {
    // Head for the nearest facade; vanish into it when there (out of view).
    const b = this.layout.blocks[this.block[i]!]!;
    const half = this.streets.blockSize / 2 - 4.2;
    const s = ringParam(b.x, b.z, half, this.x[i]!, this.z[i]!);
    ringPoint(b.x, b.z, half, s, _rp);
    const there = this.moveToward(i, _rp[0]!, _rp[1]!, this.speed[i]!, dt);
    if (there) {
      if (this.inView(this.x[i]!, 1, this.z[i]!, 1)) this.resumeWalk(i);
      else if (!this.respawnOutOfView(i)) this.resumeWalk(i);
    }
  }

  private react(i: number) {
    const sev = this.spread[i]!;
    this.state[i] = ST.react;
    const c = config.npc;
    this.timer[i] = c.reactTime * this.rng.range(0.6, 1.4) * (sev > 0.7 ? 0.6 : 1);
    // Big things make people flinch; smaller ones make them look and point (or freeze).
    const k = this.rng.next();
    this.setClip(i, sev > 0.6 || k < 0.4 ? CLIP.startle : k < 0.8 ? CLIP.point : CLIP.cower, true);
  }

  private afterReact(i: number) {
    const c = config.npc;
    const d = Math.hypot(this.tx[i]! - this.x[i]!, this.tz[i]! - this.z[i]!);
    const k = this.rng.next();
    if (this.kind[i] === KIND.occupant) {
      // Indoors: hide under the desk, or run for the stairs.
      if (k < 0.45) this.hide(i);
      else this.startFlee(i);
      return;
    }
    if (k < c.hideShare) this.hide(i);
    else if (k < c.hideShare + c.filmShare && d > 35 && this.spread[i]! < 0.8) {
      this.state[i] = ST.film;
      this.setClip(i, CLIP.film, false);
    } else this.startFlee(i);
  }

  private hide(i: number) {
    this.state[i] = ST.hide;
    this.setClip(i, CLIP.cower, false);
  }

  private flee(i: number, dt: number) {
    const c = config.npc;
    let ax = this.x[i]! - this.tx[i]!;
    let az = this.z[i]! - this.tz[i]!;
    // Once the hero has turned violent, people near him run from him.
    if (this.heroActive > 0) {
      const hx = this.x[i]! - this.heroX;
      const hz = this.z[i]! - this.heroZ;
      const hd = Math.hypot(hx, hz);
      if (hd < 45 && this.heroY < 30) {
        ax += (hx / Math.max(hd, 1)) * 40;
        az += (hz / Math.max(hd, 1)) * 40;
      }
    }
    const d = Math.hypot(ax, az) || 1;
    if (this.kind[i] === KIND.occupant) {
      // Run for the building core (the stairs), then out of sight.
      this.indoorFlee(i, dt);
      return;
    }
    // Prefer running along the street axis that points most away (people follow sidewalks).
    let dx = ax / d;
    let dz = az / d;
    const wob = Math.sin(this.time * 1.7 + i) * 0.25;
    dx += -dz * wob;
    dz += dx * wob;
    this.steer(i, dx, dz, this.speed[i]!, dt);
    this.calm[i] = d > c.fleeDistance ? this.calm[i]! + dt : 0;
    if (this.calm[i]! > c.calmTime * 0.3) this.resumeWalk(i);
    // Panic spreads through the crowd.
    this.spread[i] = this.spread[i]! - dt;
    if (this.spread[i]! <= 0) {
      this.spread[i] = c.spreadDelay;
      let crowded = 0;
      const n = this.near(this.x[i]!, this.z[i]!, c.spreadRadius);
      for (let k = 0; k < n; k++) {
        const j = this.nb[k]!;
        if (j === i || !this.isAlive(j)) continue;
        if (this.nbD2[k]! < 1.2) crowded++;
        const sj = this.state[j]!;
        if (
          sj === ST.walk ||
          sj === ST.idle ||
          sj === ST.sit ||
          sj === ST.cross ||
          sj === ST.enter
        ) {
          this.state[j] = ST.notice;
          this.timer[j] = this.rng.range(0.1, c.reactDelay);
          this.tx[j] = this.tx[i]!;
          this.tz[j] = this.tz[i]!;
          this.spread[j] = 0.5;
        }
      }
      // Crowds trip people up.
      if (crowded >= 2 && this.rng.next() < c.stumbleChance * c.spreadDelay * crowded)
        this.knockDown(i);
    }
  }

  private indoorFlee(i: number, dt: number) {
    // Head for the middle of the building on this floor, then gone (down the stairs).
    const bi = this.footIndex(this.x[i]!, this.z[i]!);
    const b = bi >= 0 ? this.layout.buildings[this.footGrid[bi]! - 1] : undefined;
    if (!b) {
      this.hide(i);
      return;
    }
    const there = this.moveToward(i, b.x, b.z, this.speed[i]! * 0.7, dt, true);
    if (there && !this.inView(this.x[i]!, this.y[i]! + 1, this.z[i]!, 1.2)) this.release(i);
  }

  private becomeInjured(i: number) {
    this.state[i] = ST.injured;
    const c = config.npc;
    const bad = this.hp[i]! < c.hp * 0.3;
    const k = this.rng.next();
    this.setClip(i, bad ? (k < 0.5 ? CLIP.crawl : CLIP.help) : CLIP.limp, false);
    this.speed[i] = bad ? c.crawlSpeed : c.limpSpeed;
  }

  private injured(i: number, dt: number) {
    if (this.clip[i] === CLIP.help) return;
    const dx = this.x[i]! - this.tx[i]!;
    const dz = this.z[i]! - this.tz[i]!;
    const d = Math.hypot(dx, dz) || 1;
    this.steer(i, dx / d, dz / d, this.speed[i]!, dt);
  }

  private air(i: number, dt: number) {
    this.vy[i] = this.vy[i]! - GRAVITY * dt;
    let nx = this.x[i]! + this.vx[i]! * dt;
    let nz = this.z[i]! + this.vz[i]! * dt;
    // Building walls stop them (they hit the facade and drop).
    if (
      this.kind[i] !== KIND.occupant &&
      this.blocked(nx, nz) &&
      !this.blocked(this.x[i]!, this.z[i]!)
    ) {
      const impact = Math.hypot(this.vx[i]!, this.vz[i]!);
      if (impact > 12 && !this.deadOnLand[i]) {
        this.deadOnLand[i] = 1;
        this.markDead(i, 'wall');
      }
      this.vx[i] = -this.vx[i]! * 0.15;
      this.vz[i] = -this.vz[i]! * 0.15;
      nx = this.x[i]!;
      nz = this.z[i]!;
    }
    this.x[i] = nx;
    this.z[i] = nz;
    this.y[i] = this.y[i]! + this.vy[i]! * dt;
    // Tumble.
    const h = 0.5 * dt;
    const ax = this.spinX[i]! * h;
    const az = this.spinZ[i]! * h;
    const qx = this.qx[i]!,
      qy = this.qy[i]!,
      qz = this.qz[i]!,
      qw = this.qw[i]!;
    // q = q + 0.5 * (0, w) * q * dt, world-space angular velocity w = (spinX, 0, spinZ)
    let rx = qx + (ax * qw + 0 * qz - az * qy);
    let ry = qy + (-ax * qz + az * qx + 0 * qw);
    let rz = qz + (az * qw + ax * qy - 0 * qx);
    let rw = qw + (-ax * qx - az * qz);
    const l = Math.hypot(rx, ry, rz, rw) || 1;
    rx /= l;
    ry /= l;
    rz /= l;
    rw /= l;
    this.qx[i] = rx;
    this.qy[i] = ry;
    this.qz[i] = rz;
    this.qw[i] = rw;
    const g = this.groundAt(i);
    if (this.y[i]! <= g && this.vy[i]! < 0) {
      const impact = Math.hypot(this.vx[i]!, this.vy[i]!, this.vz[i]!);
      this.y[i] = g;
      // Lie down facing the way the tumble left them.
      this.yaw[i] = Math.atan2(this.vx[i]!, this.vz[i]!);
      const faceUp = 1 - 2 * (rx * rx + rz * rz); // body up · world up
      if (this.deadOnLand[i] || impact > config.npc.lethalLandingSpeed) {
        if (!this.deadOnLand[i]) this.markDead(i, 'fall');
        this.toCorpse(i);
        this.setClip(i, faceUp > 0 ? CLIP.supine : CLIP.prone, true);
        this.blendT[i] = BLEND_TIME;
        events.emit('npc:land', { x: this.x[i]!, y: g, z: this.z[i]!, speed: impact });
      } else {
        this.state[i] = ST.fallen;
        this.timer[i] = this.rng.range(1.5, 3);
        this.setClip(i, CLIP.prone, true);
        this.hp[i] = this.hp[i]! - impact * 6;
      }
      this.vx[i] = this.vy[i] = this.vz[i] = 0;
    }
  }

  /** Counts a death that happens in mid-air (landing comes later). */
  private markDead(i: number, cause: string) {
    if (this.hp[i]! > 0) {
      this.casualties++;
      this.stats.deaths++;
      events.emit('npc:death', { x: this.x[i]!, y: this.y[i]!, z: this.z[i]!, cause });
    }
    this.hp[i] = 0;
    this.deadOnLand[i] = 1;
  }

  /** Floor height under a person: rubble on the street, a slab indoors. */
  private groundAt(i: number) {
    const x = this.x[i]!;
    const z = this.z[i]!;
    if (this.kind[i] === KIND.occupant || this.y[i]! > 2) {
      _floor.y = 0;
      _floor.slab = -1;
      this.debris.floorQuery?.(x, this.y[i]! + 0.5, z, _floor);
      if (_floor.y > 0) return _floor.y;
    }
    const h = this.debris.piles.heightAt(x, z);
    return h >= 0.4 ? h * 0.9 : 0;
  }

  /** Keeps people on the ground; occupants whose floor gave way fall. */
  private settle(i: number, dt: number) {
    if (this.kind[i] === KIND.occupant) {
      // Check the floor every few steps (spread across agents).
      if ((i + this.floorCursor) % 8 !== 0) return;
      const g = this.groundAt(i);
      if (g < this.y[i]! - 0.6)
        this.launch(i, this.rng.range(-0.5, 0.5), 0, this.rng.range(-0.5, 0.5));
      else this.y[i] = g;
      return;
    }
    const g = this.groundAt(i);
    this.y[i] = this.y[i]! + (g - this.y[i]!) * Math.min(1, dt * 10);
  }

  /** Moves toward a point; returns true when there. */
  private moveToward(i: number, tx: number, tz: number, speed: number, dt: number, indoor = false) {
    const dx = tx - this.x[i]!;
    const dz = tz - this.z[i]!;
    const d = Math.hypot(dx, dz);
    if (d < 0.25) return true;
    const step = Math.min(d, speed * dt);
    const nx = this.x[i]! + (dx / d) * step;
    const nz = this.z[i]! + (dz / d) * step;
    if (indoor || !this.blocked(nx, nz)) {
      this.x[i] = nx;
      this.z[i] = nz;
    }
    this.turnTo(i, Math.atan2(dx, dz), dt);
    this.separate(i, dt);
    return false;
  }

  /** Free steering (fleeing): slides along building walls, separates from others. */
  private steer(i: number, dx: number, dz: number, speed: number, dt: number) {
    const l = Math.hypot(dx, dz) || 1;
    dx /= l;
    dz /= l;
    const x = this.x[i]!;
    const z = this.z[i]!;
    const look = 2.5;
    if (this.blocked(x + dx * look, z + dz * look)) {
      // Slide along whichever axis is open (prefer the larger component).
      const ox = !this.blocked(x + Math.sign(dx) * look, z);
      const oz = !this.blocked(x, z + Math.sign(dz) * look);
      if (Math.abs(dx) > Math.abs(dz) ? ox : !oz && ox) {
        dz = 0;
        dx = Math.sign(dx) || 1;
      } else if (oz) {
        dx = 0;
        dz = Math.sign(dz) || 1;
      } else {
        dx = -dx;
        dz = -dz;
      }
    }
    // Stay inside the city.
    const lim = Math.max(this.layout.halfExtentX, this.layout.halfExtentZ) + 30;
    if (Math.abs(x) > lim) dx = -Math.sign(x);
    if (Math.abs(z) > lim) dz = -Math.sign(z);
    const nx = x + dx * speed * dt;
    const nz = z + dz * speed * dt;
    if (!this.blocked(nx, nz)) {
      this.x[i] = nx;
      this.z[i] = nz;
    }
    this.turnTo(i, Math.atan2(dx, dz), dt);
    this.separate(i, dt);
  }

  /** Neighbours within r of (x, z) into nb / nbD2 (no closures in the per-agent hot path). */
  private near(x: number, z: number, r: number): number {
    const c = this.cell;
    const i0 = Math.max(0, Math.floor((x - r + this.gridHalf) / c));
    const i1 = Math.min(this.gridN - 1, Math.floor((x + r + this.gridHalf) / c));
    const j0 = Math.max(0, Math.floor((z - r + this.gridHalf) / c));
    const j1 = Math.min(this.gridN - 1, Math.floor((z + r + this.gridHalf) / c));
    const r2 = r * r;
    let n = 0;
    for (let j = j0; j <= j1; j++)
      for (let g = i0; g <= i1; g++)
        for (let a = this.head[j * this.gridN + g]!; a >= 0; a = this.next[a]!) {
          const dx = this.x[a]! - x;
          const dz = this.z[a]! - z;
          const d2 = dx * dx + dz * dz;
          if (d2 <= r2 && n < this.nb.length) {
            this.nb[n] = a;
            this.nbD2[n++] = d2;
          }
        }
    return n;
  }

  private nb = new Int32Array(256);
  private nbD2 = new Float32Array(256);

  /** Local avoidance: push apart from close neighbours (no stacking). */
  private separate(i: number, dt: number) {
    const c = config.npc;
    const r = c.radius * 2;
    const x = this.x[i]!;
    const z = this.z[i]!;
    let sx = 0;
    let sz = 0;
    const n = this.near(x, z, r);
    for (let k = 0; k < n; k++) {
      const j = this.nb[k]!;
      if (j === i || this.state[j] === ST.dead || this.state[j] === ST.air) continue;
      const d = Math.sqrt(this.nbD2[k]!) || 0.01;
      const w = (r - d) / r;
      sx += ((x - this.x[j]!) / d) * w;
      sz += ((z - this.z[j]!) / d) * w;
    }
    if (sx === 0 && sz === 0) return;
    const nx = x + sx * c.separation * dt;
    const nz = z + sz * c.separation * dt;
    if (!this.blocked(nx, nz)) {
      this.x[i] = nx;
      this.z[i] = nz;
    }
  }

  private face(i: number, tx: number, tz: number, dt: number) {
    this.turnTo(i, Math.atan2(tx - this.x[i]!, tz - this.z[i]!), dt);
  }

  private turnTo(i: number, target: number, dt: number) {
    let d = target - this.yaw[i]!;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    const k = Math.min(1, config.npc.turnRate * dt);
    this.yaw[i] = this.yaw[i]! + d * k;
  }

  private setClip(i: number, clip: number, restart: boolean) {
    if (this.clip[i] === clip && !restart) return;
    const from = this.clip[i]!;
    this.prevClip[i] = from;
    this.prevT[i] = this.clipT[i]!;
    this.blendT[i] = 0;
    // Gait to gait keeps the stride phase, so feet don't skip.
    const fromRef = GAIT_REF[from];
    const toRef = GAIT_REF[clip];
    if (!restart && fromRef && toRef) {
      const a = this.assets.bake.clips[0]!;
      this.clipT[i] = (this.clipT[i]! / a[from]!.duration) * a[clip]!.duration;
    } else this.clipT[i] = 0;
    this.clip[i] = clip;
  }

  private advanceClip(i: number, dt: number) {
    const clip = this.clip[i]!;
    const ref = GAIT_REF[clip];
    let rate = 1;
    if (ref) {
      const moved =
        Math.hypot(this.x[i]! - this.px[i]!, this.z[i]! - this.pz[i]!) / Math.max(dt, 1e-4);
      rate = clamp(moved / ref, 0.3, 1.8);
    }
    if (this.frost[i]! >= 1 || this.state[i] === ST.dead)
      rate = this.state[i] === ST.dead && this.frost[i]! < 1 ? 1 : 0;
    this.clipT[i] = this.clipT[i]! + dt * rate;
    this.prevT[i] = this.prevT[i]! + dt * rate;
  }

  /** Street people too far from the hero come back on the far side of the view. */
  private recycle() {
    const c = config.npc;
    const r2 = c.liveRadius * c.liveRadius;
    let done = 0;
    for (let n = 0; n < this.cap && done < c.recyclePerStep; n++) {
      const i = (this.recycleCursor + n) % this.cap;
      const s = this.state[i]!;
      if (
        s === ST.free ||
        s === ST.dead ||
        s === ST.air ||
        s === ST.dying ||
        this.kind[i] !== KIND.street
      )
        continue;
      const dx = this.x[i]! - this.heroX;
      const dz = this.z[i]! - this.heroZ;
      if (dx * dx + dz * dz < r2) continue;
      if (
        this.inView(this.x[i]!, 1, this.z[i]!, 1.2) &&
        dx * dx + dz * dz < c.drawDistance * c.drawDistance
      )
        continue;
      if (this.respawnOutOfView(i)) done++;
    }
    this.recycleCursor = (this.recycleCursor + 37) % this.cap;
    this.floorCursor++;
    // Keep the living street population topped up (deaths are replaced out of view).
    let streetLiving = this.living - this.stats.occupants;
    while (streetLiving < c.count && done < c.recyclePerStep) {
      const i = this.alloc();
      if (i < 0) break;
      this.state[i] = ST.walk;
      if (!this.respawnOutOfView(i)) {
        this.state[i] = ST.free;
        this.free.push(i);
        break;
      }
      this.living++;
      streetLiving++;
      done++;
    }
  }

  private trimCorpses() {
    const cap = config.npc.corpseCap;
    if (this.corpses <= cap) return;
    // Oldest off-screen corpses go first (DESIGN.md §9.5).
    for (let k = 0; k < this.corpseOrder.length && this.corpses > cap; k++) {
      const i = this.corpseOrder[k]!;
      if (this.state[i] !== ST.dead) {
        this.corpseOrder.splice(k--, 1);
        continue;
      }
      if (this.inView(this.x[i]!, this.y[i]! + 0.3, this.z[i]!, 1.5)) continue;
      this.corpseOrder.splice(k--, 1);
      this.release(i);
    }
  }

  // --- rendering -------------------------------------------------------------------------------

  private order: number[] = [];

  frameUpdate(alpha: number, camera: THREE.Camera) {
    camera.updateMatrixWorld();
    _projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_projView);
    this.hasFrustum = true;
    const cx = camera.position.x;
    const cy = camera.position.y;
    const cz = camera.position.z;
    this.camX = cx;
    this.camZ = cz;
    const c = config.npc;
    const r = this.renderer;
    r.begin();
    const lod0Max = config.budgets.lod0Characters;
    const lod0D2 = c.lod0Distance * c.lod0Distance;
    const lod1D2 = c.lod1Distance * c.lod1Distance;
    const drawD2 = c.drawDistance * c.drawDistance;
    const clips = this.assets.bake.clips;
    // Nearest first, so the closest people get the detailed tiers.
    const order = this.order;
    order.length = 0;
    for (let i = 0; i < this.cap; i++) {
      if (this.state[i] === ST.free) continue;
      const x = this.px[i]! + (this.x[i]! - this.px[i]!) * alpha;
      const y = this.py[i]! + (this.y[i]! - this.py[i]!) * alpha;
      const z = this.pz[i]! + (this.z[i]! - this.pz[i]!) * alpha;
      const dx = x - cx;
      const dy = y - cy;
      const dz = z - cz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > drawD2) continue;
      _sphere.center.set(x, y + 0.9, z);
      _sphere.radius = 1.3;
      if (!_frustum.intersectsSphere(_sphere)) continue;
      const L = this.look;
      const o = i * FLOATS_PER_INSTANCE;
      L[o] = x;
      L[o + 1] = y;
      L[o + 2] = z;
      order.push(i);
      // Sort key in the spare dynamic slot (rewritten below).
      L[o + 8] = d2;
    }
    const L = this.look;
    if (order.length > lod0Max)
      order.sort((a, b) => L[a * FLOATS_PER_INSTANCE + 8]! - L[b * FLOATS_PER_INSTANCE + 8]!);
    let n0 = 0;
    let n1 = 0;
    for (const i of order) {
      const o = i * FLOATS_PER_INSTANCE;
      const d2 = L[o + 8]!;
      const body = this.body[i]!;
      let tier = 2;
      if (d2 < lod0D2 && n0 < lod0Max && r.room(0, body)) tier = 0;
      else if (d2 < lod1D2 && n1 < c.lod1Max && r.room(1, body)) tier = 1;
      // Rotation: yaw, or the tumble while airborne.
      if (this.state[i] === ST.air) {
        L[o + 4] = this.qx[i]!;
        L[o + 5] = this.qy[i]!;
        L[o + 6] = this.qz[i]!;
        L[o + 7] = this.qw[i]!;
      } else {
        const h = this.yaw[i]! / 2;
        L[o + 4] = 0;
        L[o + 5] = Math.sin(h);
        L[o + 6] = 0;
        L[o + 7] = Math.cos(h);
      }
      const ca = clips[body]![this.clip[i]!]!;
      const cb = clips[body]![this.prevClip[i]!]!;
      const k = Math.min(1, this.blendT[i]! / BLEND_TIME);
      L[o + 8] = clipRow(ca, this.clipT[i]!);
      L[o + 9] = k >= 1 ? L[o + 8]! : clipRow(cb, this.prevT[i]!);
      L[o + 10] = 1 - k;
      L[o + 11] = this.girth[i]!;
      L[o + 27] = this.frost[i]! > 0 ? -this.frost[i]! : this.char[i]!;
      if (r.push(tier, body, this.hairA[i]!, this.hairB[i]!, L, o)) {
        if (tier === 0) n0++;
        else if (tier === 1) n1++;
      }
    }
    r.end(c.shadowTier);
  }

  /** Camera position last frame (for spawn checks in tests). */
  get camera() {
    return { x: this.camX, z: this.camZ };
  }
}

const HAIR_COLORS = [
  [0.02, 0.016, 0.014],
  [0.05, 0.03, 0.018],
  [0.09, 0.05, 0.028],
  [0.16, 0.1, 0.05],
  [0.42, 0.3, 0.14],
  [0.22, 0.07, 0.03],
  [0.32, 0.31, 0.3],
];

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function clamp(v: number, a: number, b: number) {
  return Math.min(b, Math.max(a, v));
}

/** HSV (0..1) to linear RGB, written at out[o..o+2]. */
function hsvLinear(h: number, s: number, v: number, out: Float32Array, o: number) {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  const rgb = [
    [v, t, p],
    [q, v, p],
    [p, v, t],
    [p, q, v],
    [t, p, v],
    [v, p, q],
  ][i % 6]!;
  out[o] = rgb[0]! ** 2.2;
  out[o + 1] = rgb[1]! ** 2.2;
  out[o + 2] = rgb[2]! ** 2.2;
}
