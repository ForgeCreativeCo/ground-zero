import type RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three/webgpu';
import { config } from '../config';
import { events } from '../core/events';
import { Rng } from '../core/rng';
import type { DestructionSystem } from '../destruction/destruction';
import type { Effects } from '../fx/effects';
import type { FireSystem } from '../fx/fire';
import { ST, type CivilianSystem } from '../npc/civilians';
import { VEHICLE_GROUPS, type Physics } from '../physics/physics';
import {
  edgeLength,
  lanePoint,
  lightState,
  type RoadEdge,
  type RoadNode,
  type Streets,
} from '../world/streets';
import type { VehicleAssets } from './vehicleAssets';
import { VEHICLE_FLOATS, vehicleTime } from './vehicleMaterial';
import type { VehicleRenderer, WreckMesh } from './vehicleRenderer';

/** What a vehicle is doing. */
export const MODE = {
  /** Driving in traffic (kinematic). */
  drive: 0,
  /** Parked at the kerb, or stopped/abandoned in its lane (kinematic, still). */
  still: 1,
  /** Knocked loose: a dynamic rigid body (thrown, crashed, blasted). */
  physics: 2,
  /** Gone (shattered when frozen, or recycled). */
  gone: 3,
} as const;

/** Mass (kg) per type name (buses are heavy). */
const MASS: Record<string, number> = {
  bus: 12000,
  schoolbus: 11000,
  ambulance: 4500,
  suv: 2100,
};

export interface Vehicle {
  id: number;
  type: number;
  mode: number;
  /** Half extents (m). */
  hx: number;
  hy: number;
  hz: number;
  mass: number;
  x: number;
  y: number;
  z: number;
  q: THREE.Quaternion;
  px: number;
  py: number;
  pz: number;
  pq: THREE.Quaternion;
  yaw: number;
  speed: number;
  wheel: number;
  // Road position while driving.
  edge: number;
  dir: 1 | -1;
  lane: number;
  s: number;
  /** In an intersection: Bezier from (ax, az) via (bx, bz) to (cx, cz); u 0..1, length (m). */
  turning: boolean;
  tu: number;
  tlen: number;
  ax: number;
  az: number;
  bx: number;
  bz: number;
  cx: number;
  cz: number;
  nextEdge: number;
  nextDir: 1 | -1;
  nextLane: number;
  /** Desired speed (m/s). */
  v0: number;
  reckless: boolean;
  alarmed: boolean;
  hasDriver: boolean;
  parked: boolean;
  paint: [number, number, number];
  hp: number;
  glassBroken: boolean;
  char: number;
  frost: number;
  fuse: number;
  burning: number;
  exploded: boolean;
  beacons: boolean;
  body: RAPIER.RigidBody | null;
  collider: RAPIER.Collider | null;
  wreck: WreckMesh | null;
  // Strength grab interface (same fields the hero's hold/throw code uses on debris).
  held: boolean;
  thrown: number;
  sleep: number;
  live: boolean;
  hitCooldown: number;
}

const _lp = [0, 0, 0];
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _inv = new THREE.Quaternion();
const _frustum = new THREE.Frustum();
const _pv = new THREE.Matrix4();
const _sphere = new THREE.Sphere();
const _pos = new THREE.Vector3();

/**
 * Vehicles and traffic (DESIGN.md §7.10): cars follow lanes with an intelligent-driver model and
 * obey traffic lights; in a panic, drivers abandon their cars or drive recklessly, causing crashes
 * and pileups. Damage: dents (vertex crumple), glass, fire and fuel explosions, frost and shatter.
 * Undisturbed vehicles are kinematic colliders; anything that knocks one loose turns it into a
 * dynamic rigid body.
 */
export class VehicleSystem {
  readonly list: Vehicle[] = [];
  private byCollider = new Map<number, Vehicle>();
  private rng = new Rng(0x7aff1c);
  private time = 0;
  private hasFrustum = false;
  private heroX = 0;
  private heroY = 0;
  private heroZ = 0;
  private inst = new Float32Array(VEHICLE_FLOATS);
  /** Traffic light instances: [node, approach side 0..3]. */
  private lights: { node: RoadNode; x: number; z: number; yaw: number; axis: 0 | 1 }[] = [];
  private stepDt: number;
  /** Buckets of driving cars per directed lane (key: edge*8 + (dir>0?4:0) + lane). */
  private lanes = new Map<number, Vehicle[]>();
  readonly stats = {
    driving: 0,
    still: 0,
    physics: 0,
    wrecks: 0,
    exploded: 0,
    crashes: 0,
    burning: 0,
  };

  constructor(
    private readonly physics: Physics,
    private readonly streets: Streets,
    private readonly assets: VehicleAssets,
    private readonly renderer: VehicleRenderer,
    private readonly destruction: DestructionSystem,
    private readonly fx: Effects,
    private readonly fire: FireSystem,
    private readonly people: CivilianSystem,
  ) {
    this.stepDt = 1 / config.loop.stepHz;
    physics.contactListeners.push((h1, h2, f) => this.onContact(h1, h2, f));
    this.placeLights();
    this.wireEvents();
  }

  // --- setup -----------------------------------------------------------------------------------

  private typeIndex(name: string) {
    return this.assets.types.findIndex((t) => t.name === name);
  }

  private pickType(parked: boolean): number {
    const c = config.traffic;
    const r = this.rng.next();
    let acc = 0;
    if (!parked) {
      if (r < (acc += c.busShare))
        return this.typeIndex(this.rng.next() < 0.75 ? 'bus' : 'schoolbus');
      if (r < (acc += c.ambulanceShare)) return this.typeIndex('ambulance');
    }
    if (r < (acc += c.policeShare * (parked ? 0.3 : 1))) return this.typeIndex('police');
    if (r < acc + c.taxiShare) return this.typeIndex('taxi');
    const cars = ['sedan', 'hatch', 'suv', 'sports', 'coupe', 'sedan', 'hatch'];
    return this.typeIndex(cars[Math.floor(this.rng.next() * cars.length)]!);
  }

  private create(type: number): Vehicle {
    const info = this.assets.types[type]!;
    const name = info.name;
    const [w, h, l] = info.size;
    const paints = config.traffic.paints;
    const hex = paints[Math.floor(this.rng.next() * paints.length)]!;
    const col = new THREE.Color(hex);
    const v: Vehicle = {
      id: this.list.length,
      type,
      mode: MODE.still,
      hx: w / 2 - 0.08,
      hy: h / 2,
      hz: l / 2,
      mass: MASS[name] ?? (name === 'sports' || name === 'coupe' ? 1350 : 1500),
      x: 0,
      y: 0,
      z: 0,
      q: new THREE.Quaternion(),
      px: 0,
      py: 0,
      pz: 0,
      pq: new THREE.Quaternion(),
      yaw: 0,
      speed: 0,
      wheel: 0,
      edge: -1,
      dir: 1,
      lane: 0,
      s: 0,
      turning: false,
      tu: 0,
      tlen: 0,
      ax: 0,
      az: 0,
      bx: 0,
      bz: 0,
      cx: 0,
      cz: 0,
      nextEdge: -1,
      nextDir: 1,
      nextLane: 0,
      v0: config.traffic.speedLimit * this.rng.range(0.85, 1.1),
      reckless: false,
      alarmed: false,
      hasDriver: true,
      parked: false,
      paint: [col.r, col.g, col.b],
      hp: config.traffic.hp * (MASS[name] ? 2.5 : 1),
      glassBroken: false,
      char: 0,
      frost: 0,
      fuse: 0,
      burning: 0,
      exploded: false,
      beacons: name === 'police' || name === 'ambulance',
      body: null,
      collider: null,
      wreck: null,
      held: false,
      thrown: 0,
      sleep: 0,
      live: true,
      hitCooldown: 0,
    };
    // Kinematic body + collider (vehicle collision group: the hero's controller ignores it).
    const R = this.physics.R;
    const body = this.physics.world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased());
    const collider = this.physics.world.createCollider(
      R.ColliderDesc.cuboid(v.hx, v.hy * 0.85, v.hz)
        .setTranslation(0, v.hy * 0.85, 0)
        .setCollisionGroups(VEHICLE_GROUPS)
        .setDensity(v.mass / (8 * v.hx * v.hy * 0.85 * v.hz))
        .setFriction(0.7)
        .setRestitution(0.1),
      body,
    );
    v.body = body;
    v.collider = collider;
    this.byCollider.set(collider.handle, v);
    this.list.push(v);
    return v;
  }

  /** Parked cars along the kerbs of inside streets, and the driving pool around the hero. */
  populate(hx: number, hz: number) {
    const c = config.traffic;
    const st = this.streets;
    const inner = st.edges.filter((e) => e.lanes > 1);
    for (let n = 0; n < c.parked && inner.length; n++) {
      const e = inner[Math.floor(this.rng.next() * inner.length)]!;
      const len = edgeLength(e);
      const s = this.rng.range(e.half + 6, len - e.half - 6);
      const dir: 1 | -1 = this.rng.next() < 0.5 ? 1 : -1;
      const v = this.create(this.pickType(true));
      v.parked = true;
      v.hasDriver = false;
      v.beacons = false;
      this.parkAt(v, e, dir, s);
      if (this.list.some((o) => o !== v && Math.hypot(o.x - v.x, o.z - v.z) < v.hz + o.hz + 0.6)) {
        this.parkAt(v, e, dir, this.rng.range(e.half + 6, len - e.half - 6));
      }
    }
    for (let n = 0; n < c.driving; n++) {
      const v = this.create(this.pickType(false));
      if (!this.spawnDriving(v, hx, hz, true)) {
        // No room right now: parked out of the way until the recycler finds it a lane.
        v.mode = MODE.gone;
        v.body?.setTranslation({ x: 0, y: -500, z: 0 }, false);
      }
    }
  }

  private parkAt(v: Vehicle, e: RoadEdge, dir: 1 | -1, s: number) {
    const off = config.traffic.parkingOffset;
    const along = (dir === 1 ? e.from : e.to) + dir * s;
    if (e.axis === 0) {
      v.x = along;
      v.z = e.line + dir * off;
      v.yaw = dir === 1 ? Math.PI / 2 : -Math.PI / 2;
    } else {
      v.x = e.line - dir * off;
      v.z = along;
      v.yaw = dir === 1 ? 0 : Math.PI;
    }
    v.y = 0;
    v.mode = MODE.still;
    v.speed = 0;
    v.q.setFromAxisAngle(_up, v.yaw);
    this.syncKinematic(v, true);
  }

  /** Puts a car on a random lane near (but not too near) the hero, out of view. */
  private spawnDriving(v: Vehicle, hx: number, hz: number, boot: boolean): boolean {
    const c = config.traffic;
    const st = this.streets;
    for (let tries = 0; tries < 12; tries++) {
      const e = st.edges[Math.floor(this.rng.next() * st.edges.length)]!;
      const dir: 1 | -1 = this.rng.next() < 0.5 ? 1 : -1;
      const lane = Math.floor(this.rng.next() * e.lanes);
      const big = v.hz > 3;
      if (big && e.lanes < 2) continue;
      const useLane = big ? e.lanes - 1 : lane;
      const len = edgeLength(e);
      const s = this.rng.range(e.half + 4, Math.max(e.half + 5, len - e.half - 10));
      lanePoint(st, e, dir, useLane, s, _lp);
      const d = Math.hypot(_lp[0]! - hx, _lp[1]! - hz);
      if (d > c.liveRadius || (!boot && d < c.minSpawnDistance) || (boot && d < 12)) continue;
      if (!boot && this.inView(_lp[0]!, 1, _lp[1]!, 4)) continue;
      const key = laneKey(e.id, dir, useLane);
      const others = this.lanes.get(key);
      if (others?.some((o) => Math.abs(o.s - s) < 12)) continue;
      v.mode = MODE.drive;
      v.edge = e.id;
      v.dir = dir;
      v.lane = useLane;
      v.s = s;
      v.turning = false;
      v.speed = v.v0 * 0.6;
      v.reckless = false;
      v.alarmed = false;
      v.hasDriver = true;
      v.nextEdge = -1;
      this.placeOnLane(v);
      v.px = v.x;
      v.py = v.y;
      v.pz = v.z;
      v.pq.copy(v.q);
      this.syncKinematic(v, true);
      this.addToLane(v);
      return true;
    }
    return false;
  }

  /** Traffic lights at the corners of signalled intersections, facing the approaching traffic. */
  private placeLights() {
    const st = this.streets;
    for (const n of st.nodes) {
      if (!n.signal) continue;
      // One pole per approach, on the near-right kerb as seen by drivers arriving.
      const approaches: [number, number, number, 0 | 1][] = [
        // arriving travelling +x (from -x side): stands at (-halfZ, +halfX) corner... facing -x
        [n.x - n.halfZ - 0.8, n.z + n.halfX + 0.8, -Math.PI / 2, 0],
        [n.x + n.halfZ + 0.8, n.z - n.halfX - 0.8, Math.PI / 2, 0],
        [n.x - n.halfZ - 0.8, n.z - n.halfX - 0.8, Math.PI, 1],
        [n.x + n.halfZ + 0.8, n.z + n.halfX + 0.8, 0, 1],
      ];
      approaches.forEach(([x, z, yaw, axis], k) => {
        if (n.edges[k]! < 0) return;
        this.lights.push({ node: n, x, z, yaw, axis });
      });
    }
  }

  get lightCount() {
    return this.lights.length;
  }

  private wireEvents() {
    events.on('player:slam', (e) =>
      this.blast(e.x, e.y, e.z, e.radius, config.slam.damage, config.slam.launch * 1.5),
    );
    events.on('power:energyBlast', (e) =>
      this.blast(e.x, e.y, e.z, e.radius, 400 * (0.5 + e.charge), 25 * (0.5 + e.charge)),
    );
    events.on('cluster:crush', (e) => this.crush(e.x, e.y, e.z, 4 + Math.cbrt(e.mass) * 0.08));
    events.on('player:sonicBoom', (e) =>
      this.shatterGlass(e.x, e.y, e.z, config.sonicCity.boomShatterRadius),
    );
    // Panic reaches drivers too.
    const alarm = (x: number, z: number, r: number) => this.alarm(x, z, r);
    events.on('player:punch', (e) => e.target !== 'none' && alarm(e.x, e.z, 30));
    events.on('building:collapse', (e) => alarm(e.x, e.z, 220));
    events.on('nova:windup', (e) => alarm(e.x, e.z, 400));
    events.on('vehicle:explode', (e) => alarm(e.x, e.z, 100));
    events.on('npc:death', (e) => alarm(e.x, e.z, 25));
    events.on('player:landing', (e) => e.hard && alarm(e.x, e.z, 40));
  }

  // --- helpers ---------------------------------------------------------------------------------

  private inView(x: number, y: number, z: number, r: number) {
    if (!this.hasFrustum) return false;
    _sphere.center.set(x, y, z);
    _sphere.radius = r;
    return _frustum.intersectsSphere(_sphere);
  }

  private placeOnLane(v: Vehicle) {
    const e = this.streets.edges[v.edge]!;
    lanePoint(this.streets, e, v.dir, v.lane, v.s, _lp);
    v.x = _lp[0]!;
    v.z = _lp[1]!;
    v.y = 0;
    v.yaw = _lp[2]!;
    v.q.setFromAxisAngle(_up, v.yaw);
  }

  private addToLane(v: Vehicle) {
    const key = laneKey(v.edge, v.dir, v.lane);
    let l = this.lanes.get(key);
    if (!l) this.lanes.set(key, (l = []));
    l.push(v);
  }

  private removeFromLane(v: Vehicle) {
    const l = this.lanes.get(laneKey(v.edge, v.dir, v.lane));
    if (!l) return;
    const k = l.indexOf(v);
    if (k >= 0) l.splice(k, 1);
  }

  private syncKinematic(v: Vehicle, teleport: boolean) {
    const b = v.body;
    if (!b || v.mode === MODE.physics) return;
    if (teleport) {
      b.setTranslation({ x: v.x, y: v.y, z: v.z }, false);
      b.setRotation({ x: v.q.x, y: v.q.y, z: v.q.z, w: v.q.w }, false);
    } else {
      b.setNextKinematicTranslation({ x: v.x, y: v.y, z: v.z });
      b.setNextKinematicRotation({ x: v.q.x, y: v.q.y, z: v.q.z, w: v.q.w });
    }
  }

  private alarm(x: number, z: number, r: number) {
    const c = config.traffic;
    for (const v of this.list) {
      if (v.mode !== MODE.drive || v.alarmed) continue;
      if (Math.hypot(v.x - x, v.z - z) > r) continue;
      v.alarmed = true;
      if (this.rng.next() < c.abandonShare) {
        // Brake hard and run for it.
        v.v0 = 0;
        v.hasDriver = true;
        v.fuse = -this.rng.range(0.6, 1.6); // seconds until the driver bails (negative timer)
      } else {
        v.reckless = true;
        v.v0 = c.speedLimit * c.recklessSpeed * this.rng.range(0.9, 1.2);
      }
    }
  }

  // --- simulation ------------------------------------------------------------------------------

  fixedUpdate(
    dt: number,
    heroX: number,
    heroY: number,
    heroZ: number,
    hvx: number,
    hvy: number,
    hvz: number,
  ) {
    this.time += dt;
    this.heroX = heroX;
    this.heroY = heroY;
    this.heroZ = heroZ;
    const c = config.traffic;
    let driving = 0;
    let still = 0;
    let phys = 0;
    let burning = 0;
    for (const v of this.list) {
      if (v.mode === MODE.gone) continue;
      v.px = v.x;
      v.py = v.y;
      v.pz = v.z;
      v.pq.copy(v.q);
      if (v.hitCooldown > 0) v.hitCooldown -= dt;
      if (v.thrown > 0) v.thrown -= dt;
      if (v.mode === MODE.drive) {
        this.drive(v, dt);
        driving++;
      } else if (v.mode === MODE.still) {
        still++;
        this.bail(v, dt);
      } else if (v.mode === MODE.physics) {
        this.readBody(v);
        phys++;
      }
      if (v.burning > 0) {
        burning++;
        v.burning -= dt;
        v.char = Math.min(1, v.char + dt * 0.08);
        // A burning car's fuel goes up after a while.
        if (!v.exploded) {
          v.fuse += dt * 0.25;
          if (v.fuse >= c.fuseTime) this.explode(v);
        }
      }
      if (v.frost > 0 && v.frost < 1) v.frost = Math.max(0, v.frost - dt * 0.02);
    }
    this.stats.driving = driving;
    this.stats.still = still;
    this.stats.physics = phys;
    this.stats.burning = burning;
    this.heroContact(heroX, heroY, heroZ, hvx, hvy, hvz);
    this.recycle(heroX, heroZ);
  }

  /** Abandoning drivers: once stopped, they get out and run. */
  private bail(v: Vehicle, dt: number) {
    if (!v.hasDriver || v.parked) return;
    if (v.fuse < 0) {
      v.fuse = Math.min(0, v.fuse + dt);
      if (v.fuse === 0) this.ejectDriver(v);
    }
  }

  private ejectDriver(v: Vehicle) {
    if (!v.hasDriver || v.parked) return;
    v.hasDriver = false;
    // Out of the driver's door (left side), running.
    _v.set(-(v.hx + 0.6), 0, 0.4).applyQuaternion(v.q);
    this.people.spawnFleeing(v.x + _v.x, v.z + _v.z, this.heroX, this.heroZ);
  }

  private drive(v: Vehicle, dt: number) {
    const c = config.traffic;
    const st = this.streets;
    // Abandoning: braking to a stop, then out.
    if (v.v0 === 0 && v.speed < 0.3) {
      this.removeFromLane(v);
      v.mode = MODE.still;
      v.speed = 0;
      if (v.fuse === 0) v.fuse = -0.5;
      return;
    }
    if (v.turning) {
      v.tu += (v.speed * dt) / Math.max(1, v.tlen);
      // Gentle accel in the turn.
      v.speed = Math.min(v.v0 * 0.7, v.speed + c.accel * dt);
      if (v.tu >= 1) {
        v.turning = false;
        v.edge = v.nextEdge;
        v.dir = v.nextDir;
        v.lane = v.nextLane;
        const e = st.edges[v.edge]!;
        v.s = e.half;
        v.nextEdge = -1;
        this.addToLane(v);
        this.placeOnLane(v);
      } else {
        const u = v.tu;
        const a = (1 - u) * (1 - u);
        const b = 2 * u * (1 - u);
        const cc = u * u;
        v.x = a * v.ax + b * v.bx + cc * v.cx;
        v.z = a * v.az + b * v.bz + cc * v.cz;
        const dx = 2 * (1 - u) * (v.bx - v.ax) + 2 * u * (v.cx - v.bx);
        const dz = 2 * (1 - u) * (v.bz - v.az) + 2 * u * (v.cz - v.bz);
        v.yaw = Math.atan2(dx, dz);
        v.q.setFromAxisAngle(_up, v.yaw);
      }
      this.wheels(v, dt);
      this.hitPedestrians(v);
      this.syncKinematic(v, false);
      return;
    }
    const e = st.edges[v.edge]!;
    const len = edgeLength(e);
    const endNode = st.nodes[v.dir === 1 ? e.b : e.a]!;
    const crossHalf = e.axis === 0 ? endNode.halfZ : endNode.halfX;
    const stopS = len - crossHalf - 1.5;
    if (v.nextEdge < 0) this.planTurn(v, e, endNode);
    // Gap to whatever is ahead: leader, red light, the hero, people, wrecks, rubble.
    let gap = Infinity;
    let dv = 0;
    const lane = this.lanes.get(laneKey(v.edge, v.dir, v.lane));
    if (lane) {
      for (const o of lane) {
        if (o === v || o.s <= v.s) continue;
        const g = o.s - o.hz - (v.s + v.hz);
        if (g < gap) {
          gap = g;
          dv = v.speed - o.speed;
        }
      }
    }
    const light = lightState(endNode, e.axis, this.time, c.greenTime, c.amberTime);
    const toStop = stopS - (v.s + v.hz);
    if (!v.reckless && light !== 0 && toStop > -1) {
      // Amber: stop only if there's room to.
      const canStop = light === 2 || toStop > (v.speed * v.speed) / (2 * c.brake);
      if (canStop && toStop < gap) {
        gap = Math.max(0, toStop);
        dv = v.speed;
      }
    }
    // Don't enter a blocked junction: room on the destination lane.
    if (!v.reckless && v.nextEdge >= 0 && toStop < 15 && toStop > -1) {
      const dest = this.lanes.get(laneKey(v.nextEdge, v.nextDir, v.nextLane));
      const ne = st.edges[v.nextEdge]!;
      if (dest?.some((o) => o.s - o.hz < ne.half + v.hz * 2 + 2) && toStop < gap) {
        gap = Math.max(0, toStop);
        dv = v.speed;
      }
    }
    const ahead = this.obstacleAhead(v);
    if (ahead < gap) {
      gap = ahead;
      dv = v.speed;
    }
    // Intelligent-driver model.
    const s0 = c.minGap;
    const T = v.reckless ? c.headway * 0.3 : c.headway;
    const sStar =
      s0 + Math.max(0, v.speed * T + (v.speed * dv) / (2 * Math.sqrt(c.accel * c.brake)));
    const free = 1 - Math.pow(v.speed / Math.max(0.1, v.v0), 4);
    const inter = gap === Infinity ? 0 : (sStar / Math.max(0.1, gap)) ** 2;
    let acc = c.accel * (free - inter);
    acc = Math.max(-c.brake * (v.reckless ? 0.6 : 2.5), acc);
    v.speed = Math.max(0, v.speed + acc * dt);
    // Reckless drivers plough into whatever is ahead: a crash.
    if (gap < 0.2 && dv > c.crashSpeed * 0.5 && lane) {
      for (const o of lane) {
        if (o === v || o.s <= v.s) continue;
        if (o.s - o.hz - (v.s + v.hz) < 0.3) {
          this.crash(v, o);
          return;
        }
      }
    }
    v.s += v.speed * dt;
    if (v.s + v.hz >= len - crossHalf && v.nextEdge >= 0) {
      this.enterJunction(v, e);
    } else if (v.s > len) {
      // Dead end (shouldn't happen): turn around.
      this.removeFromLane(v);
      v.dir = (v.dir === 1 ? -1 : 1) as 1 | -1;
      v.s = e.half;
      this.addToLane(v);
    }
    if (!v.turning) this.placeOnLane(v);
    this.wheels(v, dt);
    this.hitPedestrians(v);
    this.syncKinematic(v, false);
  }

  private wheels(v: Vehicle, dt: number) {
    v.wheel = (v.wheel + (v.speed * dt) / 0.34) % (Math.PI * 2);
  }

  /** Picks the exit at the coming junction: straight, left or right (no U-turns). */
  private planTurn(v: Vehicle, e: RoadEdge, node: RoadNode) {
    // Arriving direction as an exit side index (0 -x, 1 +x, 2 -z, 3 +z).
    const arriving = e.axis === 0 ? (v.dir === 1 ? 1 : 0) : v.dir === 1 ? 3 : 2;
    const back = arriving ^ 1;
    const options: number[] = [];
    for (let k = 0; k < 4; k++) if (k !== back && node.edges[k]! >= 0) options.push(k);
    if (!options.length) options.push(back);
    // Straight more often than turning.
    let k = options[Math.floor(this.rng.next() * options.length)]!;
    if (options.includes(arriving) && this.rng.next() < 0.5) k = arriving;
    const ne = this.streets.edges[node.edges[k]!]!;
    const dir: 1 | -1 = k % 2 === 1 ? 1 : -1;
    // Turning right ends in the outer lane, left in the inner one; buses stay outer.
    const right = isRightTurn(arriving, k);
    let lane = k === arriving ? v.lane : right ? ne.lanes - 1 : 0;
    if (v.hz > 3) lane = ne.lanes - 1;
    v.nextEdge = ne.id;
    v.nextDir = dir;
    v.nextLane = Math.min(lane, ne.lanes - 1);
  }

  private enterJunction(v: Vehicle, e: RoadEdge) {
    const st = this.streets;
    this.removeFromLane(v);
    lanePoint(st, e, v.dir, v.lane, v.s, _lp);
    v.ax = _lp[0]!;
    v.az = _lp[1]!;
    const ne = st.edges[v.nextEdge]!;
    lanePoint(st, ne, v.nextDir, v.nextLane, ne.half, _lp);
    v.cx = _lp[0]!;
    v.cz = _lp[1]!;
    if (ne.axis === e.axis) {
      v.bx = (v.ax + v.cx) / 2;
      v.bz = (v.az + v.cz) / 2;
    } else if (e.axis === 0) {
      v.bx = v.cx;
      v.bz = v.az;
    } else {
      v.bx = v.ax;
      v.bz = v.cz;
    }
    const chord = Math.hypot(v.cx - v.ax, v.cz - v.az);
    v.tlen = ne.axis === e.axis ? chord : chord * 1.11;
    v.tu = 0;
    v.turning = true;
  }

  /** Distance to an obstacle in this car's lane ahead (m), or Infinity. */
  private obstacleAhead(v: Vehicle): number {
    const look = 6 + v.speed * 2.5;
    const fx = Math.sin(v.yaw);
    const fz = Math.cos(v.yaw);
    let best = Infinity;
    const consider = (x: number, z: number, r: number) => {
      const dx = x - v.x;
      const dz = z - v.z;
      const along = dx * fx + dz * fz - v.hz;
      if (along < -0.5 || along > look) return;
      const side = Math.abs(dx * fz - dz * fx);
      if (side > v.hx + r + 0.4) return;
      best = Math.min(best, Math.max(0, along - r));
    };
    // The hero standing (or hovering low) in the road. Reckless drivers don't stop for him.
    if (!v.reckless && this.heroY < 3) consider(this.heroX, this.heroZ, 0.8);
    // Knocked-loose and abandoned vehicles.
    for (const o of this.list) {
      if (o === v || o.mode === MODE.drive || o.mode === MODE.gone) continue;
      if (Math.abs(o.x - v.x) > look + 8 || Math.abs(o.z - v.z) > look + 8) continue;
      consider(o.x, o.z, Math.max(o.hx, Math.min(o.hz, 2.5)));
    }
    // People in the road (reckless drivers don't brake: that's how they run them down).
    if (!v.reckless) {
      const cx = v.x + fx * (look * 0.5 + v.hz);
      const cz = v.z + fz * (look * 0.5 + v.hz);
      this.people.forEachNear(cx, cz, look * 0.5 + 2, (i) => {
        if (!this.people.isAlive(i) && this.people.state[i] !== ST.dead) return;
        consider(this.people.x[i]!, this.people.z[i]!, 0.4);
      });
    }
    // Rubble.
    for (let d = 4; d < look; d += 4) {
      const x = v.x + fx * (v.hz + d);
      const z = v.z + fz * (v.hz + d);
      if (this.destruction.debris.piles.heightAt(x, z) > 0.5) {
        best = Math.min(best, d - 1);
        break;
      }
    }
    return best;
  }

  /** A moving car hits whoever is in front of it. */
  private hitPedestrians(v: Vehicle) {
    if (v.speed < 4) return;
    const fx = Math.sin(v.yaw);
    const fz = Math.cos(v.yaw);
    const cx = v.x + fx * v.hz;
    const cz = v.z + fz * v.hz;
    this.people.forEachNear(cx, cz, v.hx + 0.6, (i) => {
      if (!this.people.isAlive(i)) return;
      const k = v.speed;
      this.people.hurt(i, k * 9, fx * k * 1.1, 2 + k * 0.25, fz * k * 1.1, 'car');
    });
  }

  private crash(a: Vehicle, b: Vehicle) {
    const sp = a.speed;
    const fx = Math.sin(a.yaw);
    const fz = Math.cos(a.yaw);
    this.stats.crashes++;
    events.emit('vehicle:crash', { x: (a.x + b.x) / 2, y: 0.8, z: (a.z + b.z) / 2, speed: sp });
    events.emit('camera:shake', {
      trauma: Math.min(0.25, sp / 120) / (1 + Math.hypot(a.x - this.heroX, a.z - this.heroZ) / 30),
    });
    this.toPhysics(a, fx * sp * 0.4, 0.5, fz * sp * 0.4);
    this.toPhysics(b, fx * sp * 0.6, 0.8, fz * sp * 0.6);
    this.damage(a, sp * 18, a.x + fx * a.hz, a.y + a.hy, a.z + fz * a.hz, -fx, 0, -fz);
    this.damage(b, sp * 14, b.x - fx * b.hz, b.y + b.hy, b.z - fz * b.hz, fx, 0, fz);
    this.fx.sparks.ring(a.x + fx * a.hz, 0.6, a.z + fz * a.hz, 0.8, 18, 5);
  }

  // --- physics ---------------------------------------------------------------------------------

  /** Knocks a vehicle loose: from now on it's a dynamic rigid body. */
  toPhysics(v: Vehicle, vx: number, vy: number, vz: number, spin = 0) {
    if (v.mode === MODE.gone) return;
    if (v.mode === MODE.drive) this.removeFromLane(v);
    if (v.hasDriver && v.mode === MODE.drive && !v.parked) {
      // Whoever was driving is in there (people inside cars are M6's crush/gore).
      v.hasDriver = false;
    }
    const b = v.body;
    if (!b) return;
    if (v.mode !== MODE.physics) {
      b.setBodyType(this.physics.R.RigidBodyType.Dynamic, true);
      b.setLinearDamping(0.05);
      b.setAngularDamping(0.4);
      v.collider?.setActiveEvents(this.physics.R.ActiveEvents.CONTACT_FORCE_EVENTS);
      v.collider?.setContactForceEventThreshold(v.mass * 30);
      v.mode = MODE.physics;
      // Carry the driving velocity over.
      const fx = Math.sin(v.yaw) * v.speed;
      const fz = Math.cos(v.yaw) * v.speed;
      b.setLinvel({ x: fx + vx, y: vy, z: fz + vz }, true);
    } else {
      const l = b.linvel();
      b.setLinvel({ x: l.x + vx, y: l.y + vy, z: l.z + vz }, true);
    }
    if (spin)
      b.setAngvel(
        {
          x: this.rng.range(-spin, spin),
          y: this.rng.range(-spin, spin),
          z: this.rng.range(-spin, spin),
        },
        true,
      );
    b.enableCcd(Math.hypot(vx, vy, vz) > 25);
    v.speed = 0;
    v.sleep = 0;
  }

  private readBody(v: Vehicle) {
    const b = v.body!;
    const t = b.translation();
    const r = b.rotation();
    v.x = t.x;
    v.y = t.y;
    v.z = t.z;
    v.q.set(r.x, r.y, r.z, r.w);
    _e.setFromQuaternion(v.q, 'YXZ');
    v.yaw = _e.y;
    if (t.y < -60) {
      b.setTranslation({ x: t.x, y: 1, z: t.z }, true);
      b.setLinvel({ x: 0, y: 0, z: 0 }, true);
    }
    const lv = b.linvel();
    v.wheel = (v.wheel + Math.hypot(lv.x, lv.z) * this.stepDt * 2) % (Math.PI * 2);
  }

  /** Contact forces: debris landing on cars, thrown cars hitting buildings and each other. */
  private onContact(h1: number, h2: number, force: number) {
    let v = this.byCollider.get(h1);
    let other = h2;
    if (!v) {
      v = this.byCollider.get(h2);
      other = h1;
    }
    if (!v || v.hitCooldown > 0) return;
    const c = config.traffic;
    const ov = this.byCollider.get(other);
    const debris = this.destruction.debris.itemOfCollider.get(other);
    const building = this.destruction.colliders.buildingOfCollider.get(other);
    let speed = 0;
    if (v.mode === MODE.physics && v.body) {
      const l = v.body.linvel();
      speed = Math.hypot(l.x, l.y, l.z);
    }
    if (debris) {
      // Falling debris dents the roof and smashes the glass.
      this.destruction.debris.velocityOf(debris, this.stepDt, _v);
      const e = 0.5 * debris.mass * _v.lengthSq();
      const dmg = e * 0.002;
      if (dmg < 4) return;
      v.hitCooldown = 0.12;
      this.damage(v, dmg, debris.pos.x, debris.pos.y, debris.pos.z, _v.x, _v.y, _v.z);
      if (dmg > 60 && v.mode !== MODE.physics) this.toPhysics(v, _v.x * 0.05, 0, _v.z * 0.05);
      return;
    }
    if (speed < c.impactDamageSpeed) {
      if (force < v.mass * 60) return;
    }
    v.hitCooldown = 0.2;
    const b = v.body!;
    const l = b.linvel();
    const dmg = speed * c.impactDamagePerSpeed * (v.thrown > 0 ? 3 : 1);
    // Dent on the leading side.
    const ln = Math.max(0.1, speed);
    this.damage(
      v,
      dmg,
      v.x + (l.x / ln) * v.hz,
      v.y + v.hy,
      v.z + (l.z / ln) * v.hz,
      -l.x / ln,
      -l.y / ln,
      -l.z / ln,
    );
    if (building !== undefined && speed > c.impactDamageSpeed) {
      // A thrown car or bus caves a building in (energy into damage, like thrown debris).
      const energy = 0.5 * v.mass * speed * speed;
      const bd = energy * config.damage.energyToDamage;
      const r = Math.max(v.hx, v.hz) + config.damage.impactSpread;
      this.destruction.hitAt(v.x, v.y + v.hy, v.z, r, bd, l.x * 0.3, l.y * 0.3, l.z * 0.3);
      this.fx.dust.ring(v.x, v.y + v.hy, v.z, r * 0.6, 10, 5);
    }
    if (ov && ov.mode !== MODE.physics && speed > 4) {
      this.toPhysics(ov, l.x * 0.4, 1, l.z * 0.4);
      this.damage(ov, dmg * 0.8, ov.x, ov.y + ov.hy, ov.z, l.x / ln, 0, l.z / ln);
      this.stats.crashes++;
    }
    if (speed > 10) {
      events.emit('vehicle:crash', { x: v.x, y: v.y, z: v.z, speed });
      this.fx.sparks.ring(v.x, v.y + 0.5, v.z, 1, Math.min(30, speed), 6);
      // People in the way of a tumbling car.
      this.people.blast(
        v.x,
        v.y + 1,
        v.z,
        Math.max(v.hx, v.hz) + 1,
        speed * 12,
        speed * 0.5,
        'car',
      );
    }
  }

  // --- damage ----------------------------------------------------------------------------------

  /**
   * Damage at a world point, pushing inward along (dx, dy, dz): dents the body there, breaks the
   * glass, and wrecks it at zero HP.
   */
  damage(
    v: Vehicle,
    amount: number,
    x: number,
    y: number,
    z: number,
    dx: number,
    dy: number,
    dz: number,
  ) {
    if (v.mode === MODE.gone || amount <= 0) return;
    const c = config.traffic;
    if (v.frost >= 1) {
      this.shatter(v, dx, dy, dz);
      return;
    }
    v.hp -= amount;
    if (amount > 30 || v.hp < c.hp * 0.6) v.glassBroken = true;
    if (amount > 15) this.dent(v, x, y, z, dx, dy, dz, Math.min(1, amount / 300));
    if (v.hp < -c.hp * 1.5 && !v.exploded && this.rng.next() < 0.25) this.ignite(v);
    // Property damage: a car is worth ~$40k; damage up to its HP counts toward the bill.
    this.destruction.bill +=
      Math.min(amount, Math.max(0, v.hp + amount)) * config.traffic.dollarsPerHp;
    events.emit('damage:bill', { total: this.destruction.bill });
  }

  /** Crumples the body around a point (vertex deformation on the vehicle's own wreck mesh). */
  private dent(
    v: Vehicle,
    x: number,
    y: number,
    z: number,
    dx: number,
    dy: number,
    dz: number,
    k: number,
  ) {
    if (!v.wreck) {
      v.wreck = this.renderer.acquireWreck(v.type);
      if (!v.wreck) return;
    }
    const c = config.traffic;
    // Into the vehicle's local frame.
    _inv.copy(v.q).invert();
    _v.set(x - v.x, y - v.y, z - v.z).applyQuaternion(_inv);
    _w.set(dx, dy, dz);
    if (_w.lengthSq() < 1e-6) _w.set(-_v.x, -_v.y, -_v.z);
    _w.normalize().applyQuaternion(_inv);
    // Clamp the dent centre onto the body box.
    _v.x = clamp(_v.x, -v.hx - 0.1, v.hx + 0.1);
    _v.y = clamp(_v.y, 0, v.hy * 2);
    _v.z = clamp(_v.z, -v.hz - 0.1, v.hz + 0.1);
    const R = c.crumpleRadius * (0.6 + k * 0.8);
    const depth = c.crumpleDepth * k;
    const p = v.wreck.positions;
    const rest = v.wreck.rest;
    for (let i = 0; i < p.length; i += 3) {
      const ex = rest[i]! - _v.x;
      const ey = rest[i + 1]! - _v.y;
      const ez = rest[i + 2]! - _v.z;
      const d = Math.sqrt(ex * ex + ey * ey + ez * ez);
      if (d > R) continue;
      const f = (1 - d / R) ** 2 * depth;
      p[i] = p[i]! + _w.x * f;
      p[i + 1] = Math.max(0.02, p[i + 1]! + _w.y * f);
      p[i + 2] = p[i + 2]! + _w.z * f;
    }
    this.renderer.dentsChanged(v.wreck);
  }

  /** Heat vision on a vehicle: catches fire, then the fuel goes up. */
  heat(v: Vehicle, dt: number) {
    if (v.mode === MODE.gone || v.exploded) return;
    v.frost = 0;
    v.char = Math.min(1, v.char + dt * 0.4);
    v.fuse += dt;
    if (v.fuse > config.traffic.fuseTime * 0.3 && v.burning <= 0) this.ignite(v);
    if (v.fuse >= config.traffic.fuseTime) this.explode(v);
  }

  private ignite(v: Vehicle) {
    if (v.burning > 0) return;
    v.burning = config.traffic.burnTime;
    this.fire.ignitePoint(v.x, v.y + v.hy, v.z, config.traffic.burnTime);
    events.emit('vehicle:ignite', { x: v.x, y: v.y, z: v.z });
  }

  /** Fuel explosion: blast damage around it, the car leaps and burns out (DESIGN.md §7.10). */
  explode(v: Vehicle) {
    if (v.exploded || v.mode === MODE.gone) return;
    const c = config.traffic;
    v.exploded = true;
    v.fuse = 0;
    v.glassBroken = true;
    v.char = 1;
    this.stats.exploded++;
    const x = v.x;
    const y = v.y + v.hy;
    const z = v.z;
    this.toPhysics(v, this.rng.range(-2, 2), 7 + this.rng.range(0, 4), this.rng.range(-2, 2), 2.5);
    this.dent(v, x, y + v.hy, z, 0, -1, 0, 0.6);
    this.ignite(v);
    v.burning = c.burnTime;
    this.destruction.blast(x, y, z, c.explosionRadius, c.explosionDamage, c.explosionLaunch);
    this.destruction.shatterWindows(x, y + 4, z, c.explosionRadius * 2.5);
    this.people.blast(
      x,
      y,
      z,
      c.explosionRadius * 1.3,
      c.explosionDamage,
      c.explosionLaunch,
      'explosion',
    );
    // Chain reactions.
    for (const o of this.list) {
      if (o === v || o.mode === MODE.gone) continue;
      const d = Math.hypot(o.x - x, o.z - z);
      if (d > c.explosionRadius) continue;
      const kk = 1 - d / c.explosionRadius;
      this.toPhysics(
        o,
        ((o.x - x) / Math.max(d, 1)) * c.explosionLaunch * kk,
        4 * kk,
        ((o.z - z) / Math.max(d, 1)) * c.explosionLaunch * kk,
        1,
      );
      this.damage(o, c.explosionDamage * kk, x, y, z, o.x - x, 0, o.z - z);
      o.fuse += kk * c.fuseTime * 0.8;
      if (kk > 0.4) this.ignite(o);
    }
    _pos.set(x, y, z);
    this.fx.shockwaves.spawn(_pos, _up, c.explosionRadius * 2, 0.5, 0.8);
    // Fireball and a column of black smoke.
    this.fire.flames.ring(x, y, z, 1.8, 70, 7);
    this.fire.flames.ring(x, y + 1.5, z, 1.2, 40, 4);
    this.fire.smoke.ring(x, y + 2, z, 2, 30, 3);
    this.fx.sparks.ring(x, y, z, 1.5, 60, 14);
    this.fx.dust.ring(x, 0.3, z, c.explosionRadius * 0.5, 40, 8);
    this.fx.collapseDust.ring(x, y, z, 3, 8, 4);
    events.emit('vehicle:explode', { x, y, z, radius: c.explosionRadius });
    events.emit('camera:shake', {
      trauma: 0.5 / (1 + Math.hypot(x - this.heroX, z - this.heroZ) / 25),
    });
  }

  /** Freeze breath: frost builds up; frozen solid, it's brittle. */
  freeze(v: Vehicle, dt: number) {
    if (v.mode === MODE.gone) return;
    v.frost = Math.min(1, v.frost + dt * 0.8);
    v.char = Math.max(0, v.char - dt);
    if (v.burning > 0) {
      v.burning = 0;
      this.fire.extinguish(v.x, v.y + 1, v.z, Math.max(v.hx, v.hz) + 1);
    }
    v.fuse = Math.max(0, v.fuse - dt * 2);
    if (v.mode === MODE.drive && v.frost >= 1) {
      // Frozen solid in its lane.
      this.removeFromLane(v);
      v.mode = MODE.still;
      v.speed = 0;
      v.hasDriver = false;
    }
  }

  /** A frozen vehicle struck: it shatters into frozen chunks (which stay as rubble). */
  private shatter(v: Vehicle, dx: number, dy: number, dz: number) {
    const c = config.traffic;
    const n = c.shatterChunks;
    const l = Math.hypot(dx, dy, dz) || 1;
    for (let k = 0; k < n; k++) {
      _v.set(
        this.rng.range(-v.hx, v.hx),
        this.rng.range(0.2, v.hy * 1.8),
        this.rng.range(-v.hz, v.hz),
      ).applyQuaternion(v.q);
      _e.set(this.rng.range(0, 6), this.rng.range(0, 6), 0);
      _q.setFromEuler(_e);
      const s = this.rng.range(0.15, 0.45);
      this.destruction.debris.spawn(
        k % 3 === 0 ? 'glass' : 'metal',
        v.x + _v.x,
        v.y + _v.y,
        v.z + _v.z,
        s,
        s * 0.5,
        s * 0.8,
        _q,
        (dx / l) * 6 + this.rng.range(-4, 4),
        this.rng.range(1, 5),
        (dz / l) * 6 + this.rng.range(-4, 4),
        2500,
        k < 4,
      );
    }
    this.fx.frostMist.ring(v.x, v.y + 1, v.z, 2, 30, 3);
    events.emit('vehicle:shatter', { x: v.x, y: v.y, z: v.z });
    this.remove(v);
  }

  private remove(v: Vehicle) {
    if (v.mode === MODE.drive) this.removeFromLane(v);
    v.mode = MODE.gone;
    v.live = false;
    if (v.body) {
      if (v.collider) this.byCollider.delete(v.collider.handle);
      this.physics.world.removeRigidBody(v.body);
      v.body = null;
      v.collider = null;
    }
    if (v.wreck) {
      v.wreck.inUse = false;
      v.wreck.batch.mesh.visible = false;
      v.wreck = null;
    }
  }

  private shatterGlass(x: number, y: number, z: number, r: number) {
    for (const v of this.list) {
      if (v.mode === MODE.gone || v.glassBroken) continue;
      if (Math.hypot(v.x - x, v.y - y, v.z - z) < r) {
        v.glassBroken = true;
        this.fx.sparks.ring(v.x, v.y + v.hy * 1.4, v.z, v.hx, 6, 2);
      }
    }
  }

  /** Blast: vehicles inside are damaged and thrown outward. */
  blast(x: number, y: number, z: number, r: number, damage: number, launch: number) {
    for (const v of this.list) {
      if (v.mode === MODE.gone) continue;
      const dx = v.x - x;
      const dy = v.y + v.hy - y;
      const dz = v.z - z;
      const d = Math.hypot(dx, dy, dz);
      if (d > r + v.hz) continue;
      const k = Math.max(0, 1 - d / (r + v.hz));
      const scale = Math.min(1, 1600 / v.mass);
      const push = launch * k * scale;
      const h = Math.max(0.5, Math.hypot(dx, dz));
      this.damage(v, damage * k, x, y, z, dx, dy, dz);
      if (v.mode === MODE.gone) continue;
      if (push > 1.5)
        this.toPhysics(v, (dx / h) * push, push * 0.5 + k * 3, (dz / h) * push, k * 3);
    }
  }

  /** The vehicle whose box contains a point (padded), or null. */
  atPoint(x: number, y: number, z: number, pad: number): Vehicle | null {
    for (const v of this.list) {
      if (v.mode === MODE.gone) continue;
      if (Math.abs(v.x - x) > v.hz + pad + 1 || Math.abs(v.z - z) > v.hz + pad + 1) continue;
      _inv.copy(v.q).invert();
      _v.set(x - v.x, y - v.y - v.hy, z - v.z).applyQuaternion(_inv);
      if (
        Math.abs(_v.x) <= v.hx + pad &&
        Math.abs(_v.y) <= v.hy + pad &&
        Math.abs(_v.z) <= v.hz + pad
      )
        return v;
    }
    return null;
  }

  /** Freeze breath cone. */
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
    for (const v of this.list) {
      if (v.mode === MODE.gone) continue;
      const px = v.x - ox;
      const py = v.y + v.hy - oy;
      const pz = v.z - oz;
      const d = Math.hypot(px, py, pz);
      if (d > range + v.hz || d < 0.1) continue;
      // Big things fill more of the cone.
      const cosv = (px * dx + py * dy + pz * dz) / d;
      if (cosv < cosHalf - Math.min(0.4, v.hz / Math.max(1, d))) continue;
      this.freeze(v, dt);
    }
  }

  /**
   * The Nova front passing radius r0..r1 (DESIGN.md §6.6): vehicles in the core and blast zone
   * are flung as burning wrecks (some explode), the edge rocks them and breaks their glass.
   */
  novaRing(cx: number, cy: number, cz: number, r0: number, r1: number, R: number) {
    const n = config.nova;
    for (const v of this.list) {
      if (v.mode === MODE.gone) continue;
      const dx = v.x - cx;
      const dz = v.z - cz;
      const d = Math.hypot(dx, v.y - cy, dz);
      if (d < r0 || d >= r1) continue;
      const f = d / R;
      const h = Math.max(1, Math.hypot(dx, dz));
      if (f <= n.blastFraction) {
        const k =
          f <= n.coreFraction ? 1 : 1 - (f - n.coreFraction) / (n.blastFraction - n.coreFraction);
        const sp = n.blastLaunch * (0.3 + 0.7 * k) * Math.min(1, 3000 / v.mass);
        v.glassBroken = true;
        this.damage(v, config.traffic.hp * (1 + 3 * k), cx, cy, cz, dx, 0, dz);
        if (v.mode === MODE.gone) continue;
        this.toPhysics(v, (dx / h) * sp, sp * 0.35, (dz / h) * sp, 4 * k);
        v.char = Math.max(v.char, k);
        if (k > 0.5 && !v.exploded && this.rng.next() < 0.6) this.explode(v);
        else if (k > 0.2) this.ignite(v);
      } else if (f <= n.fringeFraction) {
        v.glassBroken = true;
        const k = 1 - (f - n.blastFraction) / (n.fringeFraction - n.blastFraction);
        if (k > 0.4) this.toPhysics(v, (dx / h) * 6 * k, 1.5 * k, (dz / h) * 6 * k, k);
      }
    }
  }

  /** A falling section landed: vehicles under it are crushed. */
  crush(x: number, y: number, z: number, r: number) {
    for (const v of this.list) {
      if (v.mode === MODE.gone) continue;
      if (Math.hypot(v.x - x, v.z - z) > r + v.hz || v.y > y + 2) continue;
      this.damage(v, config.traffic.hp * 3, v.x, v.y + v.hy * 2, v.z, 0, -1, 0);
      this.dent(v, v.x, v.y + v.hy * 2, v.z, 0, -1, 0, 1);
      if (v.mode === MODE.drive) {
        this.removeFromLane(v);
        v.mode = MODE.still;
        v.speed = 0;
      }
    }
  }

  /** The hero's body: smashing into cars at speed crumples and launches them; walking shoves them. */
  private heroContact(x: number, y: number, z: number, vx: number, vy: number, vz: number) {
    const c = config.traffic;
    const speed = Math.hypot(vx, vy, vz);
    if (speed < 1) return;
    const cy = y + config.player.height / 2;
    for (const v of this.list) {
      if (v.mode === MODE.gone || v.held || v.hitCooldown > 0) continue;
      if (Math.abs(v.x - x) > v.hz + 2 || Math.abs(v.z - z) > v.hz + 2) continue;
      // Into the vehicle's frame.
      _inv.copy(v.q).invert();
      _v.set(x - v.x, cy - v.y, z - v.z).applyQuaternion(_inv);
      const pad = 0.6;
      if (
        Math.abs(_v.x) > v.hx + pad ||
        Math.abs(_v.z) > v.hz + pad ||
        _v.y < -1 ||
        _v.y > v.hy * 2 + 1
      )
        continue;
      v.hitCooldown = 0.25;
      if (speed >= c.heroImpactSpeed) {
        const k = Math.min(1, 1800 / v.mass);
        this.damage(v, speed * 14, x, cy, z, vx, vy, vz);
        if (v.mode === MODE.gone) continue;
        this.toPhysics(
          v,
          vx * k * 0.9,
          Math.abs(vy) * k * 0.5 + speed * 0.08 * k,
          vz * k * 0.9,
          k * 4,
        );
        events.emit('camera:shake', { trauma: Math.min(0.4, speed / 250) });
        this.fx.sparks.ring(x, cy, z, 0.6, 20, 6);
        if (v.thrown <= 0) v.thrown = 1.5;
      } else if (y < 2) {
        const l = Math.hypot(vx, vz) || 1;
        this.toPhysics(
          v,
          (vx / l) * c.heroShove * Math.min(1, 1800 / v.mass),
          0.3,
          (vz / l) * c.heroShove * Math.min(1, 1800 / v.mass),
        );
      }
    }
  }

  /** Ray (the hero's punch or grab): nearest vehicle hit within reach, and where. */
  rayHit(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    reach: number,
    out: THREE.Vector3,
  ): Vehicle | null {
    let best: Vehicle | null = null;
    let bestT = reach;
    for (const v of this.list) {
      if (v.mode === MODE.gone || v.held) continue;
      if (Math.abs(v.x - ox) > reach + v.hz + 2 || Math.abs(v.z - oz) > reach + v.hz + 2) continue;
      _inv.copy(v.q).invert();
      _v.set(ox - v.x, oy - v.y - v.hy, oz - v.z).applyQuaternion(_inv);
      _w.set(dx, dy, dz).applyQuaternion(_inv);
      const t = rayBoxT(_v, _w, v.hx, v.hy, v.hz);
      if (t >= 0 && t < bestT) {
        bestT = t;
        best = v;
      }
    }
    if (best) out.set(ox + dx * bestT, oy + dy * bestT, oz + dz * bestT);
    return best;
  }

  /** Strength: a punch on a vehicle. */
  punch(
    v: Vehicle,
    px: number,
    py: number,
    pz: number,
    ix: number,
    iy: number,
    iz: number,
    damage: number,
  ) {
    const l = Math.hypot(ix, iy, iz) || 1;
    this.damage(v, damage * 1.5, px, py, pz, ix / l, iy / l, iz / l);
    if (v.mode === MODE.gone) return;
    const k = Math.min(1.5, 2000 / v.mass);
    this.toPhysics(v, ix * k, iy * k + 2 * k, iz * k, 3 * k);
    v.thrown = 1.2;
  }

  /** Strength: grab a vehicle (lift it overhead). Returns it as a body the hold code can steer. */
  grab(v: Vehicle) {
    if (v.mode === MODE.gone) return null;
    this.toPhysics(v, 0, 2, 0);
    return v;
  }

  // --- recycling -------------------------------------------------------------------------------

  private recycle(hx: number, hz: number) {
    const c = config.traffic;
    let done = 0;
    for (const v of this.list) {
      if (done >= 2) break;
      if (v.parked || (v.mode !== MODE.drive && v.mode !== MODE.gone)) continue;
      if (v.mode === MODE.gone && (v.exploded || v.live === false) && v.body === null) continue;
      if (v.mode === MODE.drive) {
        const d = Math.hypot(v.x - hx, v.z - hz);
        if (d < c.liveRadius || this.inView(v.x, 1, v.z, 4)) continue;
        this.removeFromLane(v);
      }
      if (this.spawnDriving(v, hx, hz, false)) done++;
      else if (v.mode === MODE.drive) this.addToLane(v);
    }
  }

  // --- render ----------------------------------------------------------------------------------

  frameUpdate(alpha: number, camera: THREE.Camera, dt: number) {
    camera.updateMatrixWorld();
    _pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_pv);
    this.hasFrustum = true;
    vehicleTime.value += dt;
    const r = this.renderer;
    r.begin();
    const night = config.sun.elevationDeg < 4 ? 1 : 0;
    const d = this.inst;
    let wrecks = 0;
    for (const v of this.list) {
      if (v.mode === MODE.gone) continue;
      const x = v.px + (v.x - v.px) * alpha;
      const y = v.py + (v.y - v.py) * alpha;
      const z = v.pz + (v.z - v.pz) * alpha;
      _sphere.center.set(x, y + v.hy, z);
      _sphere.radius = v.hz + 1;
      const far =
        (x - camera.position.x) ** 2 + (z - camera.position.z) ** 2 >
        config.traffic.drawDistance ** 2;
      const visible = !far && _frustum.intersectsSphere(_sphere);
      if (!visible && !v.wreck) continue;
      _q.copy(v.pq).slerp(v.q, alpha);
      d[0] = x;
      d[1] = y;
      d[2] = z;
      d[3] = v.wheel;
      d[4] = _q.x;
      d[5] = _q.y;
      d[6] = _q.z;
      d[7] = _q.w;
      d[8] = v.paint[0];
      d[9] = v.paint[1];
      d[10] = v.paint[2];
      d[11] = v.glassBroken ? 1 : 0;
      d[12] = v.char;
      d[13] = v.frost;
      d[14] = v.beacons && v.alarmed && v.hasDriver ? 1 : 0;
      d[15] = night && v.hasDriver && !v.exploded ? 1 : 0;
      if (v.wreck) {
        r.drawWreck(v.wreck, d, 0);
        wrecks++;
      } else r.push(v.type, d, 0);
    }
    this.stats.wrecks = wrecks;
    // Traffic lights.
    const c = config.traffic;
    for (const l of this.lights) {
      _sphere.center.set(l.x, 2.5, l.z);
      _sphere.radius = 3;
      if (!_frustum.intersectsSphere(_sphere)) continue;
      const s = lightState(l.node, l.axis, this.time, c.greenTime, c.amberTime);
      d[0] = l.x;
      d[1] = 0;
      d[2] = l.z;
      d[3] = 0;
      const h = l.yaw / 2;
      d[4] = 0;
      d[5] = Math.sin(h);
      d[6] = 0;
      d[7] = Math.cos(h);
      d[8] = d[9] = d[10] = 1;
      d[11] = 0;
      d[12] = 0;
      d[13] = 0;
      d[14] = s === 0 ? 2 : s === 1 ? 1 : 0;
      d[15] = 0;
      r.pushLight(d, 0);
    }
    r.end();
  }

  /** Vehicles the hero is holding or that are flying (for the strength system). */
  vehicleOfCollider(h: number) {
    return this.byCollider.get(h);
  }
}

function laneKey(edge: number, dir: number, lane: number) {
  return edge * 8 + (dir > 0 ? 4 : 0) + lane;
}

/** Arriving along side `a` (travel direction index), leaving by side `k`: is it a right turn? */
function isRightTurn(a: number, k: number) {
  // Travel directions as vectors: 0 -x, 1 +x, 2 -z, 3 +z. Right of heading h is h x up.
  const dir = [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ];
  const [hx, hz] = dir[a]!;
  const [kx, kz] = dir[k]!;
  // right = (hx, 0, hz) x (0, 1, 0) = (-hz, 0, hx)
  return -hz! * kx! + hx! * kz! > 0.5;
}

function clamp(v: number, a: number, b: number) {
  return Math.min(b, Math.max(a, v));
}

/** Ray vs box centred at the origin (half extents), local frame. Returns t or -1. */
function rayBoxT(o: THREE.Vector3, d: THREE.Vector3, hx: number, hy: number, hz: number) {
  let t0 = 0;
  let t1 = Infinity;
  const ax = [o.x, o.y, o.z];
  const dx = [d.x, d.y, d.z];
  const h = [hx, hy, hz];
  for (let i = 0; i < 3; i++) {
    const oi = ax[i]!;
    const di = dx[i]!;
    const hi = h[i]!;
    if (Math.abs(di) < 1e-9) {
      if (oi < -hi || oi > hi) return -1;
      continue;
    }
    let a = (-hi - oi) / di;
    let b = (hi - oi) / di;
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, b);
    if (t0 > t1) return -1;
  }
  return t0;
}
