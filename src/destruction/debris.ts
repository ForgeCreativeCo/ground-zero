import * as THREE from 'three/webgpu';
import type RAPIER from '@dimforge/rapier3d-compat';
import { config } from '../config';
import { Rng } from '../core/rng';
import type { Physics } from '../physics/physics';
import { batchGeometry, pieceMaterial, VI, type PieceVisual } from '../render/pieceMaterials';
import { uploadLive } from '../render/uploadRange';

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _e = new THREE.Euler();
const _t = { x: 0, y: 0, z: 0 };
const _r = { x: 0, y: 0, z: 0, w: 1 };

/** A loose chunk: a rigid body while active, or visual-only (ballistic, no collisions). */
export interface DebrisItem {
  id: number;
  visual: PieceVisual;
  hx: number;
  hy: number;
  hz: number;
  mass: number;
  body: RAPIER.RigidBody | null;
  collider: RAPIER.Collider | null;
  /** Current and previous step transforms (for interpolation). */
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  prevPos: THREE.Vector3;
  prevQuat: THREE.Quaternion;
  /** Visual-only motion. */
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  /** One fixed step of spin as a rotation (visual fragments; cheaper than an Euler per step). */
  spinQ: THREE.Quaternion;
  age: number;
  sleep: number;
  /** Seconds left counting as thrown (impacts deal damage). */
  thrown: number;
  /** Carried by the hero: never settles. */
  held: boolean;
  /** Small visual fragment fading out (s left), or -1. */
  fade: number;
  slot: number;
  /** Seconds before this item may deal impact damage again. */
  hitCooldown: number;
  live: boolean;
  /** Index in the live list (swap-remove). */
  liveIdx: number;
  /** Resting on an upper floor (a slab piece id) rather than the ground; -1 if not. */
  restSlab: number;
  parked: boolean;
  /** Visual fragments cache the floor under them (re-queried every few steps, or near it). */
  floorY: number;
  floorSlab: number;
  floorX: number;
  floorZ: number;
  floorAge: number;
}

/** Chunks use the plain (window-less) panel looks. */
const CHUNK_LOOK: Partial<Record<PieceVisual, PieceVisual>> = {
  concrete: 'frameConcrete',
  brick: 'frameBrick',
  frameGlass: 'glass',
};

/** Top of the floor under a point: height, and the slab piece it belongs to (-1 = ground). */
export interface FloorHit {
  y: number;
  slab: number;
}

/** One instanced mesh of chunks with swap-remove slots (flying chunks, or resting ones). */
interface Batch {
  mesh: THREE.InstancedMesh;
  slots: (DebrisItem | null)[];
  count: number;
  visual: THREE.InstancedBufferAttribute;
}

function addToBatch(b: Batch, it: DebrisItem) {
  it.slot = b.count;
  b.visual.setX(it.slot, VI(CHUNK_LOOK[it.visual] ?? it.visual));
  b.slots[b.count++] = it;
}

/** Swap-remove: the last chunk moves into the hole (matrix and look too). */
function removeFromBatch(b: Batch, it: DebrisItem) {
  const last = --b.count;
  const moved = b.slots[last]!;
  b.slots[it.slot] = moved;
  b.visual.setX(it.slot, b.visual.getX(last));
  if (moved !== it) {
    b.mesh.getMatrixAt(last, _m);
    b.mesh.setMatrixAt(it.slot, _m);
  }
  moved.slot = it.slot;
  b.slots[last] = null;
  it.slot = -1;
}

/** Growable instanced mesh for permanent rubble (never shrinks: damage is permanent). */
class RubbleBatch {
  mesh: THREE.InstancedMesh;
  count = 0;
  private capacity: number;
  constructor(
    private readonly group: THREE.Group,
    private readonly base: THREE.BufferGeometry,
    private readonly material: THREE.Material,
    capacity: number,
  ) {
    this.capacity = capacity;
    this.mesh = this.make(capacity);
  }

  private make(capacity: number) {
    const g = batchGeometry(this.base, capacity, 'structure');
    const mesh = new THREE.InstancedMesh(g.geometry, this.material, capacity);
    mesh.count = 0;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    this.group.add(mesh);
    return mesh;
  }

  add(m: THREE.Matrix4, crack: number, visual: number) {
    if (this.count >= this.capacity) {
      // Double the capacity and copy everything over.
      const old = this.mesh;
      this.capacity *= 2;
      this.mesh = this.make(this.capacity);
      const oldState = old.geometry.getAttribute('aState') as THREE.InstancedBufferAttribute;
      const newState = this.mesh.geometry.getAttribute('aState') as THREE.InstancedBufferAttribute;
      const oldVis = old.geometry.getAttribute('aVisual') as THREE.InstancedBufferAttribute;
      const newVis = this.mesh.geometry.getAttribute('aVisual') as THREE.InstancedBufferAttribute;
      for (let i = 0; i < this.count; i++) {
        old.getMatrixAt(i, _m);
        this.mesh.setMatrixAt(i, _m);
        newState.setXYZW(i, oldState.getX(i), oldState.getY(i), 0, 0);
        newVis.setX(i, oldVis.getX(i));
      }
      this.group.remove(old);
      old.geometry.dispose();
    }
    const i = this.count++;
    this.mesh.setMatrixAt(i, m);
    (this.mesh.geometry.getAttribute('aState') as THREE.InstancedBufferAttribute).setXYZW(
      i,
      crack,
      1,
      0,
      0,
    );
    const vis = this.mesh.geometry.getAttribute('aVisual') as THREE.InstancedBufferAttribute;
    vis.setX(i, visual);
    this.mesh.count = this.count;
    uploadLive(
      this.count,
      this.mesh.instanceMatrix,
      this.mesh.geometry.getAttribute('aState') as THREE.InstancedBufferAttribute,
      vis,
    );
  }
}

/**
 * Rubble height field: rubble that lands adds volume to a coarse grid; cells with enough rubble
 * get one merged static collider, so piles are solid without a collider per chunk.
 */
class RubblePiles {
  readonly cell = 6;
  private n: number;
  private half: number;
  readonly height: Float32Array;
  private colliders: (RAPIER.Collider | null)[];
  private builtHeight: Float32Array;
  private dirty = new Set<number>();
  private body: RAPIER.RigidBody;
  count = 0;

  constructor(
    private readonly physics: Physics,
    halfExtent: number,
  ) {
    this.half = Math.ceil(halfExtent / this.cell) * this.cell;
    this.n = Math.round((this.half * 2) / this.cell);
    this.height = new Float32Array(this.n * this.n);
    this.builtHeight = new Float32Array(this.n * this.n);
    this.colliders = new Array(this.n * this.n).fill(null);
    this.body = physics.world.createRigidBody(physics.R.RigidBodyDesc.fixed());
  }

  private index(x: number, z: number) {
    const i = Math.floor((x + this.half) / this.cell);
    const j = Math.floor((z + this.half) / this.cell);
    if (i < 0 || j < 0 || i >= this.n || j >= this.n) return -1;
    return j * this.n + i;
  }

  heightAt(x: number, z: number) {
    const k = this.index(x, z);
    return k < 0 ? 0 : this.height[k]!;
  }

  /** Adds rubble volume (m³) at x/z; loose rubble packs at roughly half density. */
  add(x: number, z: number, volume: number) {
    const k = this.index(x, z);
    if (k < 0) return;
    this.height[k]! += (volume * 0.55) / (this.cell * this.cell);
    if (this.height[k]! - this.builtHeight[k]! > 0.3) this.dirty.add(k);
  }

  update(max: number) {
    let done = 0;
    for (const k of this.dirty) {
      this.dirty.delete(k);
      const h = this.height[k]!;
      const old = this.colliders[k];
      if (old) {
        this.physics.world.removeCollider(old, false);
        this.count--;
      }
      this.colliders[k] = null;
      this.builtHeight[k] = h;
      if (h >= 0.4) {
        const i = k % this.n;
        const j = Math.floor(k / this.n);
        const x = -this.half + (i + 0.5) * this.cell;
        const z = -this.half + (j + 0.5) * this.cell;
        // Slightly smaller than the cell, and shaved so the hero can step/hop onto piles.
        this.colliders[k] = this.physics.world.createCollider(
          this.physics.R.ColliderDesc.cuboid(
            this.cell * 0.48,
            h * 0.45,
            this.cell * 0.48,
          ).setTranslation(x, h * 0.45, z),
          this.body,
        );
        this.count++;
      }
      if (++done >= max) break;
    }
  }
}

/**
 * Debris lifecycle (DESIGN.md §7.8): active rigid bodies (capped by budgets.activeRigidBodies),
 * visual-only fragments past the budget, and permanent static rubble. Large rubble never
 * disappears; only small fragments fade.
 */
export class DebrisSystem {
  readonly group = new THREE.Group();
  readonly piles: RubblePiles;
  private items: DebrisItem[] = [];
  private free: DebrisItem[] = [];
  private live: DebrisItem[] = [];
  /**
   * One instanced mesh for every flying chunk and one for all rubble, the look set per instance:
   * three.js builds shader code per instanced mesh, so they're made once, up front.
   */
  private dyn: Batch;
  /**
   * Chunks resting on upper floors: they don't move, so they live in their own mesh that only
   * uploads when one is added or removed (thousands can pile up after a fly-through).
   */
  private parkedBatch: Batch;
  private parkedDirty = false;
  private rubble: RubbleBatch;
  readonly itemOfCollider = new Map<number, DebrisItem>();
  /** Floor under a point inside buildings (set by the destruction system); null = ground only. */
  floorQuery: ((x: number, y: number, z: number, out: FloorHit) => void) | null = null;
  /** Is a slab piece still standing (for debris resting on upper floors)? */
  slabStanding: (id: number) => boolean = () => true;
  private floorHit: FloorHit = { y: 0, slab: -1 };
  private rng = new Rng(0xdeb715);
  private box = new THREE.BoxGeometry(1, 1, 1);
  activeBodies = 0;
  rubbleCount = 0;
  /** Bodies created this step (capped so a big blast can't stall a frame creating hundreds). */
  private newBodies = 0;

  constructor(
    scene: THREE.Scene,
    private readonly physics: Physics,
    halfExtent: number,
  ) {
    this.piles = new RubblePiles(physics, halfExtent);
    const cap = config.budgets.activeRigidBodies + config.debris.visualCapacity;
    const material = pieceMaterial();
    const makeBatch = (n: number): Batch => {
      const g = batchGeometry(this.box, n, 'structure');
      for (let i = 0; i < n; i++) g.state.setXYZW(i, 0.55, 1, 0, 0);
      const mesh = new THREE.InstancedMesh(g.geometry, material, n);
      mesh.count = 0;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.group.add(mesh);
      return { mesh, slots: new Array(n).fill(null), count: 0, visual: g.visual };
    };
    this.dyn = makeBatch(cap);
    this.parkedBatch = makeBatch(config.debris.visualCapacity);
    this.rubble = new RubbleBatch(
      this.group,
      this.box,
      material,
      config.debris.rubbleInitialCapacity,
    );
    scene.add(this.group);
  }

  get liveCount() {
    return this.live.length;
  }

  get visualCount() {
    return this.live.length - this.activeBodies;
  }

  allMaterials() {
    return [pieceMaterial()];
  }

  /** The debris and rubble meshes (for the shader warm-up). */
  get meshes() {
    return [this.dyn.mesh, this.parkedBatch.mesh, this.rubble.mesh];
  }

  /**
   * Spawns a chunk. With `wantBody` it becomes a rigid body if the budget allows (or `force`
   * evicts the oldest active body to make room); otherwise it flies as a visual fragment.
   */
  spawn(
    visual: PieceVisual,
    x: number,
    y: number,
    z: number,
    hx: number,
    hy: number,
    hz: number,
    q: THREE.Quaternion,
    vx: number,
    vy: number,
    vz: number,
    density: number,
    wantBody: boolean,
    force = false,
  ): DebrisItem | null {
    const v = this.dyn;
    if (v.count >= v.slots.length) return null;
    const it = this.free.pop() ?? this.newItem();
    it.visual = visual;
    it.hx = hx;
    it.hy = hy;
    it.hz = hz;
    it.mass = 8 * hx * hy * hz * density;
    it.pos.set(x, y, z);
    it.prevPos.copy(it.pos);
    it.quat.copy(q);
    it.prevQuat.copy(q);
    it.vel.set(vx, vy, vz);
    it.spin.set(this.rng.range(-4, 4), this.rng.range(-4, 4), this.rng.range(-4, 4));
    it.spinQ.setFromEuler(_e.set(it.spin.x / 60, it.spin.y / 60, it.spin.z / 60));
    it.age = 0;
    it.sleep = 0;
    it.thrown = 0;
    it.held = false;
    it.fade = -1;
    it.hitCooldown = 0;
    it.restSlab = -1;
    it.parked = false;
    it.floorAge = 0;
    it.live = true;
    it.body = null;
    it.collider = null;

    const big = Math.max(hx, hy, hz) >= config.debris.minBodySize;
    if (wantBody && big && (force || this.newBodies < config.debris.maxNewBodiesPerStep)) {
      if (this.activeBodies >= config.budgets.activeRigidBodies && force) this.settleOldest();
      if (this.activeBodies < config.budgets.activeRigidBodies) {
        this.makeBody(it, density);
        this.newBodies++;
      }
    }
    addToBatch(v, it);
    it.liveIdx = this.live.length;
    this.live.push(it);
    return it;
  }

  private newItem(): DebrisItem {
    const it: DebrisItem = {
      id: this.items.length,
      visual: 'concrete',
      hx: 0,
      hy: 0,
      hz: 0,
      mass: 0,
      body: null,
      collider: null,
      pos: new THREE.Vector3(),
      quat: new THREE.Quaternion(),
      prevPos: new THREE.Vector3(),
      prevQuat: new THREE.Quaternion(),
      vel: new THREE.Vector3(),
      spin: new THREE.Vector3(),
      spinQ: new THREE.Quaternion(),
      age: 0,
      sleep: 0,
      thrown: 0,
      held: false,
      fade: -1,
      slot: -1,
      hitCooldown: 0,
      live: false,
      liveIdx: -1,
      restSlab: -1,
      parked: false,
      floorY: 0,
      floorSlab: -1,
      floorX: 0,
      floorZ: 0,
      floorAge: 0,
    };
    this.items.push(it);
    return it;
  }

  private makeBody(it: DebrisItem, density: number) {
    const R = this.physics.R;
    const fast = it.vel.lengthSq() > 30 * 30;
    _t.x = it.pos.x;
    _t.y = it.pos.y;
    _t.z = it.pos.z;
    _r.x = it.quat.x;
    _r.y = it.quat.y;
    _r.z = it.quat.z;
    _r.w = it.quat.w;
    const body = this.physics.world.createRigidBody(
      R.RigidBodyDesc.dynamic()
        .setTranslation(_t.x, _t.y, _t.z)
        .setRotation(_r)
        .setLinvel(it.vel.x, it.vel.y, it.vel.z)
        .setAngvel({ x: it.spin.x * 0.5, y: it.spin.y * 0.5, z: it.spin.z * 0.5 })
        .setCcdEnabled(fast)
        .setLinearDamping(0.05)
        .setAngularDamping(0.3),
    );
    const col = this.physics.world.createCollider(
      R.ColliderDesc.cuboid(it.hx, it.hy, it.hz)
        .setDensity(density)
        .setFriction(0.85)
        .setRestitution(0.05)
        .setActiveEvents(R.ActiveEvents.CONTACT_FORCE_EVENTS)
        .setContactForceEventThreshold(it.mass * 40),
      body,
    );
    it.body = body;
    it.collider = col;
    this.itemOfCollider.set(col.handle, it);
    this.activeBodies++;
  }

  private removeBody(it: DebrisItem) {
    if (!it.body) return;
    if (it.collider) this.itemOfCollider.delete(it.collider.handle);
    this.physics.world.removeRigidBody(it.body);
    it.body = null;
    it.collider = null;
    this.activeBodies--;
  }

  /** Turns the oldest settling body into rubble to free budget. */
  private settleOldest() {
    let oldest: DebrisItem | null = null;
    for (const it of this.live) {
      if (!it.body || it.held || it.thrown > 0) continue;
      if (!oldest || it.age > oldest.age) oldest = it;
    }
    if (oldest) this.toRubble(oldest);
  }

  /** Fixed step: integrate visual fragments, read bodies, settle, fade. */
  fixedUpdate(dt: number) {
    const s = config.debris;
    this.newBodies = 0;
    const g = config.world.gravity;
    for (let i = this.live.length - 1; i >= 0; i--) {
      const it = this.live[i]!;
      it.prevPos.copy(it.pos);
      it.prevQuat.copy(it.quat);
      it.age += dt;
      if (it.thrown > 0) it.thrown -= dt;
      if (it.hitCooldown > 0) it.hitCooldown -= dt;

      if (it.parked) {
        // Resting on an upper floor: falls again if that floor goes.
        if (it.restSlab >= 0 && !this.slabStanding(it.restSlab)) {
          // No room among the flying chunks: it drops straight to the rubble below.
          if (this.dyn.count >= this.dyn.slots.length) {
            this.toRubble(it, true);
            continue;
          }
          removeFromBatch(this.parkedBatch, it);
          this.parkedDirty = true;
          it.parked = false;
          it.restSlab = -1;
          addToBatch(this.dyn, it);
        }
        continue;
      }

      if (it.fade >= 0) {
        it.fade -= dt;
        if (it.fade <= 0) this.kill(it);
        continue;
      }

      if (it.body) {
        if (it.body.isSleeping()) {
          it.sleep += dt;
          if (it.sleep >= s.settleTime && !it.held) {
            this.readBody(it);
            const fl = this.restHeight(it.pos.x, it.pos.y, it.pos.z);
            if (fl.slab >= 0 && it.pos.y - fl.y < 3) this.park(it, fl);
            else this.toRubble(it);
          }
          continue;
        }
        it.sleep = 0;
        this.readBody(it);
        if (it.pos.y < -50) this.kill(it);
        continue;
      }

      // Visual fragment: ballistic, lands on the ground or a rubble pile.
      it.vel.y += g * dt;
      it.pos.addScaledVector(it.vel, dt);
      it.quat.multiply(it.spinQ);
      const minHalf = Math.min(it.hx, it.hy, it.hz);
      // The floor under it barely changes while it flies: look it up again every few steps, when
      // it has moved sideways, or when it is about to land (thousands fly after a Nova).
      if (
        --it.floorAge <= 0 ||
        Math.abs(it.pos.x - it.floorX) + Math.abs(it.pos.z - it.floorZ) > 3 ||
        it.pos.y - minHalf - it.floorY < Math.abs(it.vel.y) * dt * 3 + 0.5
      ) {
        const f = this.restHeight(it.pos.x, it.pos.y + 0.5, it.pos.z);
        it.floorY = f.y;
        it.floorSlab = f.slab;
        it.floorX = it.pos.x;
        it.floorZ = it.pos.z;
        it.floorAge = 6;
      }
      if (it.pos.y - minHalf <= it.floorY) {
        it.pos.y = it.floorY + minHalf;
        const fl = this.floorHit;
        fl.y = it.floorY;
        fl.slab = it.floorSlab;
        if (Math.max(it.hx, it.hy, it.hz) < s.minBodySize) it.fade = s.smallFadeTime;
        else if (fl.slab >= 0) this.park(it, fl);
        else this.toRubble(it, true);
      }
    }
  }

  /** Where something at this point would come to rest: a pile on the ground, or an upper floor. */
  private restHeight(x: number, y: number, z: number): FloorHit {
    const f = this.floorHit;
    f.y = this.piles.heightAt(x, z);
    f.slab = -1;
    if (this.floorQuery) {
      const before = f.y;
      this.floorQuery(x, y, z, f);
      if (f.y < before) {
        f.y = before;
        f.slab = -1;
      }
    }
    return f;
  }

  private park(it: DebrisItem, floor: FloorHit) {
    // No room left among the resting chunks: it becomes rubble where it is instead.
    if (this.parkedBatch.count >= this.parkedBatch.slots.length) {
      this.toRubble(it);
      return;
    }
    this.removeBody(it);
    it.parked = true;
    it.restSlab = floor.slab;
    it.vel.set(0, 0, 0);
    it.spin.set(0, 0, 0);
    // Lie flat on the floor.
    const dims = [it.hx, it.hy, it.hz].sort((a, b) => a - b);
    it.hx = dims[2]!;
    it.hz = dims[1]!;
    it.hy = dims[0]!;
    _e.set(0, this.rng.range(0, Math.PI * 2), 0);
    it.quat.setFromEuler(_e);
    it.pos.y = floor.y + it.hy;
    it.prevPos.copy(it.pos);
    it.prevQuat.copy(it.quat);
    removeFromBatch(this.dyn, it);
    addToBatch(this.parkedBatch, it);
    _m.compose(it.pos, it.quat, _s.set(it.hx * 2, it.hy * 2, it.hz * 2));
    this.parkedBatch.mesh.setMatrixAt(it.slot, _m);
    this.parkedDirty = true;
  }

  private readBody(it: DebrisItem) {
    const t = it.body!.translation();
    const r = it.body!.rotation();
    it.pos.set(t.x, t.y, t.z);
    it.quat.set(r.x, r.y, r.z, r.w);
  }

  /** Converts a chunk to permanent static rubble where it lies. */
  toRubble(it: DebrisItem, layFlat = false) {
    if (!it.live) return;
    if (layFlat) {
      // Rest on its largest face: smallest extent vertical, random heading.
      const dims = [it.hx, it.hy, it.hz].sort((a, b) => a - b);
      it.hx = dims[2]!;
      it.hz = dims[1]!;
      it.hy = dims[0]!;
      _e.set(
        this.rng.range(-0.15, 0.15),
        this.rng.range(0, Math.PI * 2),
        this.rng.range(-0.15, 0.15),
      );
      it.quat.setFromEuler(_e);
      it.pos.y = this.piles.heightAt(it.pos.x, it.pos.z) + it.hy;
    }
    this.removeBody(it);
    _m.compose(it.pos, it.quat, _s.set(it.hx * 2, it.hy * 2, it.hz * 2));
    this.rubble.add(_m, 0.6, VI(CHUNK_LOOK[it.visual] ?? it.visual));
    this.rubbleCount++;
    // Only rubble resting on the ground or a pile builds the pile up.
    const ground = this.piles.heightAt(it.pos.x, it.pos.z);
    if (it.pos.y - it.hy - ground < 0.6)
      this.piles.add(it.pos.x, it.pos.z, 8 * it.hx * it.hy * it.hz);
    this.kill(it);
  }

  private kill(it: DebrisItem) {
    if (!it.live) return;
    this.removeBody(it);
    it.live = false;
    if (it.parked) {
      removeFromBatch(this.parkedBatch, it);
      this.parkedDirty = true;
      it.parked = false;
    } else removeFromBatch(this.dyn, it);
    const tail = this.live.pop()!;
    if (tail !== it) {
      this.live[it.liveIdx] = tail;
      tail.liveIdx = it.liveIdx;
    }
    it.liveIdx = -1;
    this.free.push(it);
  }

  /** Places a chunk straight into rubble (crushed pieces that never fly). */
  addRubble(
    visual: PieceVisual,
    x: number,
    y: number,
    z: number,
    hx: number,
    hy: number,
    hz: number,
    yaw: number,
    tilt: number,
  ) {
    _e.set(tilt, yaw, tilt * 0.5);
    _q.setFromEuler(_e);
    _m.compose(_p.set(x, y, z), _q, _s.set(hx * 2, hy * 2, hz * 2));
    this.rubble.add(_m, 0.6, VI(CHUNK_LOOK[visual] ?? visual));
    this.rubbleCount++;
  }

  /** Render: interpolated transforms into the dynamic batches. */
  render(alpha: number) {
    {
      const v = this.dyn;
      for (let i = 0; i < v.count; i++) {
        const it = v.slots[i]!;
        _p.lerpVectors(it.prevPos, it.pos, alpha);
        _q.slerpQuaternions(it.prevQuat, it.quat, alpha);
        const shrink = it.fade >= 0 ? Math.max(0, it.fade / config.debris.smallFadeTime) : 1;
        _m.compose(_p, _q, _s.set(it.hx * 2 * shrink, it.hy * 2 * shrink, it.hz * 2 * shrink));
        v.mesh.setMatrixAt(i, _m);
      }
      v.mesh.count = v.count;
      v.mesh.visible = v.count > 0;
      if (v.count > 0) uploadLive(v.count, v.mesh.instanceMatrix, v.visual);
    }
    if (this.parkedDirty) {
      const p = this.parkedBatch;
      p.mesh.count = p.count;
      p.mesh.visible = p.count > 0;
      uploadLive(p.count, p.mesh.instanceMatrix, p.visual);
      this.parkedDirty = false;
    }
  }

  /** Items within r of a point (for blasts and grabs). */
  forEachNear(x: number, y: number, z: number, r: number, fn: (it: DebrisItem) => void) {
    const r2 = r * r;
    for (const it of this.live) {
      if (it.pos.distanceToSquared(_p.set(x, y, z)) <= r2) fn(it);
    }
  }

  /** Velocity of an item estimated from its last step (no allocation). */
  velocityOf(it: DebrisItem, dt: number, out: THREE.Vector3) {
    return out.subVectors(it.pos, it.prevPos).divideScalar(Math.max(dt, 1e-4));
  }

  /** Pushes an item (body impulse as a velocity change, or visual velocity). */
  push(it: DebrisItem, vx: number, vy: number, vz: number) {
    if (it.body) {
      it.body.wakeUp();
      const v = it.body.linvel();
      it.body.setLinvel({ x: v.x + vx, y: v.y + vy, z: v.z + vz }, true);
      it.sleep = 0;
    } else if (it.fade < 0) {
      it.vel.x += vx;
      it.vel.y += vy;
      it.vel.z += vz;
    }
  }

  /** Startup prewarm: draw every debris/rubble mesh once (degenerate instance). */
  setPrewarm(on: boolean) {
    const meshes: { mesh: THREE.InstancedMesh; count: number }[] = [];
    meshes.push({ mesh: this.dyn.mesh, count: this.dyn.count });
    meshes.push({ mesh: this.parkedBatch.mesh, count: this.parkedBatch.count });
    meshes.push({ mesh: this.rubble.mesh, count: this.rubble.count });
    for (const { mesh, count } of meshes) {
      if (on && count === 0) {
        mesh.setMatrixAt(0, _m.makeScale(0, 0, 0));
        mesh.count = 1;
        mesh.visible = true;
      } else if (!on) {
        mesh.count = count;
        mesh.visible = count > 0 || mesh.frustumCulled === false;
      }
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  updatePiles(max: number) {
    this.piles.update(max);
  }
}
