import * as THREE from 'three/webgpu';
import type RAPIER from '@dimforge/rapier3d-compat';
import { config } from '../config';
import { events } from '../core/events';
import { Rng } from '../core/rng';
import type { Physics } from '../physics/physics';
import { batchGeometry, pieceMaterial, VI } from '../render/pieceMaterials';
import { uploadLive } from '../render/uploadRange';
import type { PieceRenderer } from '../render/pieceRenderer';
import type { BuildingModel } from './buildingModel';
import type { CityStructure } from './cityStructure';
import type { DebrisSystem } from './debris';
import { FLAG, STATE } from './pieces';

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _v = new THREE.Vector3();
const _box = new THREE.Box3();
const _obb = new THREE.Box3();
const _mat = new THREE.Matrix4();
const _r = { x: 0, y: 0, z: 0, w: 1 };
const _t = { x: 0, y: 0, z: 0 };

/** Callbacks the collapse system needs from the destruction system. */
export interface CollapseHost {
  /** Destroys a static piece by crushing (no flying fragments; rubble + dust). */
  crushStatic(id: number): void;
  /** Dust/fx for a crushed story at a world point. */
  crushFx(x: number, y: number, z: number, mass: number, nearGround: boolean): void;
  /** Property damage for pieces destroyed inside a falling section. */
  bill(id: number): void;
}

interface ClusterMesh {
  mesh: THREE.InstancedMesh;
  slotPiece: Int32Array;
  count: number;
}

/**
 * Pre-created instanced meshes for falling sections, one per section with every look set per
 * instance, reused between collapses: three.js generates shader code per instanced mesh, so
 * making one mid-collapse would stall.
 */
export class ClusterMeshPool {
  private free: ClusterMesh[] = [];
  private all: ClusterMesh[] = [];
  private box = new THREE.BoxGeometry(1, 1, 1);

  constructor(
    private readonly material: THREE.Material,
    private readonly capacity: number,
    count: number,
  ) {
    for (let i = 0; i < count; i++) this.free.push(this.create(capacity));
  }

  private create(n: number): ClusterMesh {
    const g = batchGeometry(this.box, n, 'structure');
    const mesh = new THREE.InstancedMesh(g.geometry, this.material, n);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.count = 0;
    const cm = { mesh, slotPiece: new Int32Array(n).fill(-1), count: 0 };
    this.all.push(cm);
    return cm;
  }

  acquire(n: number): ClusterMesh {
    const i = this.free.findIndex((c) => c.slotPiece.length >= n);
    if (i >= 0) return this.free.splice(i, 1)[0]!;
    return this.create(Math.max(n, this.capacity));
  }

  release(cm: ClusterMesh) {
    cm.mesh.removeFromParent();
    cm.count = 0;
    cm.mesh.count = 0;
    cm.slotPiece.fill(-1);
    this.free.push(cm);
  }

  /** Every pooled mesh (for the background shader warm-up). */
  allMeshes(): THREE.InstancedMesh[] {
    return this.all.map((c) => c.mesh);
  }
}

/**
 * A falling section of a building (DESIGN.md §7.6): one rigid body with a box per story. It starts
 * kinematic while it sags (stress failure), then falls. Whatever it lands on gets crushed one story
 * at a time, keeping most of its momentum, so tall sections pancake down and lopsided ones topple.
 */
export class Cluster {
  readonly group = new THREE.Group();
  readonly body: RAPIER.RigidBody;
  /** story → pieces, and story → collider. */
  readonly stories = new Map<number, number[]>();
  private colliders = new Map<number, RAPIER.Collider>();
  private cm: ClusterMesh;
  /** piece → slot in this section's mesh. */
  private slotOf = new Map<number, number>();
  readonly origin = new THREE.Vector3();
  private pos = new THREE.Vector3();
  private quat = new THREE.Quaternion();
  private prevPos = new THREE.Vector3();
  private prevQuat = new THREE.Quaternion();
  private prevVel = new THREE.Vector3();
  phase: 'sag' | 'falling' = 'falling';
  private sagT = 0;
  private sagDuration = 1;
  private sagAxis = new THREE.Vector3(1, 0, 0);
  private sagPivot = new THREE.Vector3();
  private crushTimer = 0;
  mass = 0;
  pieceCount = 0;

  constructor(
    private readonly physics: Physics,
    private readonly city: CityStructure,
    renderer: PieceRenderer,
    readonly building: BuildingModel,
    pieces: number[],
    kinematic: boolean,
    scene: THREE.Scene,
    private readonly pool: ClusterMeshPool,
  ) {
    const s = city.store;
    const R = physics.R;
    // Origin at the centroid; pieces are stored relative to it.
    let mx = 0;
    let my = 0;
    let mz = 0;
    let total = 0;
    for (const id of pieces) {
      const w = s.mass[id]!;
      mx += s.cx[id]! * w;
      my += s.cy[id]! * w;
      mz += s.cz[id]! * w;
      total += w;
      s.flags[id]! |= FLAG.inCluster;
      renderer.hide(id);
      const f = building.floorOf(id);
      let list = this.stories.get(f);
      if (!list) this.stories.set(f, (list = []));
      list.push(id);
    }
    this.mass = total;
    this.pieceCount = pieces.length;
    this.origin.set(mx / total, my / total, mz / total);
    this.pos.copy(this.origin);
    this.prevPos.copy(this.origin);

    this.body = physics.world.createRigidBody(
      (kinematic ? R.RigidBodyDesc.kinematicPositionBased() : R.RigidBodyDesc.dynamic())
        .setTranslation(this.origin.x, this.origin.y, this.origin.z)
        .setCanSleep(false),
    );
    for (const [f, list] of this.stories) {
      _box.makeEmpty();
      let m = 0;
      for (const id of list) {
        _box.expandByPoint(
          _p.set(s.cx[id]! - s.hx[id]!, s.cy[id]! - s.hy[id]!, s.cz[id]! - s.hz[id]!),
        );
        _box.expandByPoint(
          _p.set(s.cx[id]! + s.hx[id]!, s.cy[id]! + s.hy[id]!, s.cz[id]! + s.hz[id]!),
        );
        m += s.mass[id]!;
      }
      _box.getCenter(_p).sub(this.origin);
      _box.getSize(_s).multiplyScalar(0.5);
      const c = physics.world.createCollider(
        R.ColliderDesc.cuboid(Math.max(0.1, _s.x), Math.max(0.1, _s.y), Math.max(0.1, _s.z))
          .setTranslation(_p.x, _p.y, _p.z)
          .setMass(m)
          .setFriction(0.9)
          .setRestitution(0),
        this.body,
      );
      this.colliders.set(f, c);
    }

    // Render: one instanced mesh for the whole section, local to the body.
    const cm = (this.cm = this.pool.acquire(pieces.length));
    this.group.add(cm.mesh);
    const visAttr = cm.mesh.geometry.getAttribute('aVisual') as THREE.InstancedBufferAttribute;
    for (const id of pieces) {
      const slot = cm.count++;
      visAttr.setX(slot, VI(renderer.visualFor(id)));
      _m.compose(
        _p.set(s.cx[id]! - this.origin.x, s.cy[id]! - this.origin.y, s.cz[id]! - this.origin.z),
        _q.identity(),
        _s.set(s.hx[id]! * 2, s.hy[id]! * 2, s.hz[id]! * 2),
      );
      cm.mesh.setMatrixAt(slot, _m);
      const frac = s.maxHp[id]! > 0 ? s.hp[id]! / s.maxHp[id]! : 1;
      (cm.mesh.geometry.getAttribute('aState') as THREE.InstancedBufferAttribute).setXYZW(
        slot,
        frac < 0.99 ? 1 - frac : 0,
        s.flags[id]! & FLAG.windowsBroken ? 1 : 0,
        0,
        0,
      );
      cm.slotPiece[slot] = id;
      this.slotOf.set(id, slot);
    }
    cm.mesh.count = cm.count;
    uploadLive(
      cm.count,
      cm.mesh.instanceMatrix,
      cm.mesh.geometry.getAttribute('aState') as THREE.InstancedBufferAttribute,
      visAttr,
    );
    this.group.position.copy(this.origin);
    scene.add(this.group);
  }

  /** Start a sag: tilt toward (tx, tz) about the base, over `duration` seconds. */
  startSag(tx: number, tz: number, duration: number) {
    this.phase = 'sag';
    this.sagT = 0;
    this.sagDuration = duration;
    const len = Math.hypot(tx, tz);
    // Rotation axis is horizontal and perpendicular to the topple direction.
    if (len > 1e-3) this.sagAxis.set(tz / len, 0, -tx / len);
    else this.sagAxis.set(1, 0, 0);
    let minY = Infinity;
    for (const [f] of this.stories) minY = Math.min(minY, f * config.construction.floorHeight);
    this.sagPivot.set(this.origin.x, minY, this.origin.z);
  }

  /** Switch from sagging (kinematic) to falling (dynamic), with an initial topple spin. */
  release(spin: number) {
    this.phase = 'falling';
    this.body.setBodyType(this.physics.R.RigidBodyType.Dynamic, true);
    this.body.setLinvel({ x: 0, y: -1, z: 0 }, true);
    this.body.setAngvel({ x: this.sagAxis.x * spin, y: 0, z: this.sagAxis.z * spin }, true);
  }

  /** Fixed step. Returns false once nothing is left. */
  fixedUpdate(dt: number, host: CollapseHost): boolean {
    this.prevPos.copy(this.pos);
    this.prevQuat.copy(this.quat);
    const st = config.structure;
    if (this.phase === 'sag') {
      this.sagT = Math.min(this.sagDuration, this.sagT + dt);
      // Sag accelerates toward the end: slow groan, then it goes.
      const k = Math.pow(this.sagT / this.sagDuration, 2);
      const angle = THREE.MathUtils.degToRad(st.sagMaxDeg) * k;
      _q.setFromAxisAngle(this.sagAxis, angle);
      _p.copy(this.origin).sub(this.sagPivot).applyQuaternion(_q).add(this.sagPivot);
      _p.y -= st.sagDrop * k;
      _t.x = _p.x;
      _t.y = _p.y;
      _t.z = _p.z;
      _r.x = _q.x;
      _r.y = _q.y;
      _r.z = _q.z;
      _r.w = _q.w;
      this.body.setNextKinematicTranslation(_t);
      this.body.setNextKinematicRotation(_r);
      this.pos.copy(_p);
      this.quat.copy(_q);
      return true;
    }

    const t = this.body.translation();
    const r = this.body.rotation();
    this.pos.set(t.x, t.y, t.z);
    this.quat.set(r.x, r.y, r.z, r.w);
    const lv = this.body.linvel();
    _v.set(lv.x, lv.y, lv.z);

    // Which story is touching something that isn't part of this section?
    let contactStory = -1;
    let contactY = Infinity;
    for (const [f, c] of this.colliders) {
      let touching = false;
      this.physics.world.contactPairsWith(c, (other) => {
        if (touching || other.parent()?.handle === this.body.handle) return;
        this.physics.world.contactPair(c, other, (manifold) => {
          if (manifold.numContacts() > 0) touching = true;
        });
      });
      if (!touching) continue;
      const tr = c.translation();
      if (tr.y < contactY) {
        contactY = tr.y;
        contactStory = f;
      }
    }

    if (contactStory >= 0) {
      this.crushTimer += dt;
      if (this.crushTimer >= st.crushInterval) {
        this.crushTimer = 0;
        this.crushStory(contactStory, host);
        // Pancake momentum: keep most of the speed it had before the impact.
        const before = this.prevVel.length();
        const want = before * st.crushMomentum;
        if (_v.length() < want && before > 0.5) {
          _v.copy(this.prevVel).multiplyScalar(st.crushMomentum);
          this.body.setLinvel({ x: _v.x, y: _v.y, z: _v.z }, true);
        }
      }
    } else {
      this.crushTimer = Math.min(this.crushTimer, st.crushInterval * 0.5);
    }
    this.prevVel.copy(_v);
    if (this.pos.y < -30) {
      for (const f of [...this.stories.keys()]) this.crushStory(f, host);
    }
    return this.stories.size > 0;
  }

  /**
   * Crushes one story: its pieces fall away as rubble chunks, and static pieces of whatever it
   * hit (directly beneath that story's box) are crushed too, which is how collapses propagate.
   */
  crushStory(f: number, host: CollapseHost) {
    const list = this.stories.get(f);
    if (!list) return;
    const s = this.city.store;
    const c = this.colliders.get(f)!;
    // World AABB of the story box (rotated), then crush static pieces just below/inside it.
    const he = (c.shape as RAPIER.Cuboid).halfExtents;
    const ct = c.translation();
    const cr = c.rotation();
    _mat.compose(_p.set(ct.x, ct.y, ct.z), _q.set(cr.x, cr.y, cr.z, cr.w), _s.set(1, 1, 1));
    _obb.set(_p.set(-he.x, -he.y, -he.z), _v.set(he.x, he.y, he.z)).applyMatrix4(_mat);
    const H = config.construction.floorHeight;
    this.city.forEachBuildingNear(
      (_obb.min.x + _obb.max.x) / 2,
      _obb.min.y,
      (_obb.min.z + _obb.max.z) / 2,
      Math.max(_obb.max.x - _obb.min.x, _obb.max.z - _obb.min.z),
      (b) => {
        b.forEachInBox(
          s,
          _obb.min.x + 0.3,
          _obb.min.y - H * 0.6,
          _obb.min.z + 0.3,
          _obb.max.x - 0.3,
          _obb.min.y + 0.2,
          _obb.max.z - 0.3,
          (id) => host.crushStatic(id),
        );
      },
    );

    // This story's own pieces become rubble chunks falling from where they are.
    let mass = 0;
    for (const id of list) {
      const slot = this.slotOf.get(id);
      if (slot !== undefined) {
        const moved = removeSlot(this.cm, slot);
        if (moved >= 0) this.slotOf.set(moved, slot);
        this.slotOf.delete(id);
      }
      s.state[id] = STATE.destroyed;
      mass += s.mass[id]!;
      host.bill(id);
    }
    host.crushFx(
      (_obb.min.x + _obb.max.x) / 2,
      (_obb.min.y + _obb.max.y) / 2,
      (_obb.min.z + _obb.max.z) / 2,
      mass,
      _obb.min.y < 6,
    );
    this.pendingRubble.push(...list);
    this.physics.world.removeCollider(c, true);
    this.colliders.delete(f);
    this.stories.delete(f);
    this.cm.mesh.count = this.cm.count;
    uploadLive(
      this.cm.count,
      this.cm.mesh.instanceMatrix,
      this.cm.mesh.geometry.getAttribute('aState') as THREE.InstancedBufferAttribute,
      this.cm.mesh.geometry.getAttribute('aVisual') as THREE.InstancedBufferAttribute,
    );
    events.emit('cluster:crush', { x: ct.x, y: ct.y, z: ct.z, mass });
  }

  /** Pieces crushed this step, waiting to be turned into rubble chunks (world transforms). */
  pendingRubble: number[] = [];

  /** World transform of a piece's centre given the section's current pose. */
  pieceWorld(id: number, out: THREE.Vector3) {
    const s = this.city.store;
    return out
      .set(s.cx[id]! - this.origin.x, s.cy[id]! - this.origin.y, s.cz[id]! - this.origin.z)
      .applyQuaternion(this.quat)
      .add(this.pos);
  }

  get rotation() {
    return this.quat;
  }

  render(alpha: number) {
    this.group.position.lerpVectors(this.prevPos, this.pos, alpha);
    this.group.quaternion.slerpQuaternions(this.prevQuat, this.quat, alpha);
  }

  dispose(scene: THREE.Scene) {
    scene.remove(this.group);
    this.pool.release(this.cm);
    if (this.physics.world.getRigidBody(this.body.handle))
      this.physics.world.removeRigidBody(this.body);
  }
}

function removeSlot(cm: ClusterMesh, slot: number): number {
  const last = --cm.count;
  if (slot === last) {
    cm.slotPiece[slot] = -1;
    return -1;
  }
  cm.mesh.getMatrixAt(last, _m);
  cm.mesh.setMatrixAt(slot, _m);
  const st = cm.mesh.geometry.getAttribute('aState') as THREE.InstancedBufferAttribute;
  st.setXYZW(slot, st.getX(last), st.getY(last), 0, 0);
  const vis = cm.mesh.geometry.getAttribute('aVisual') as THREE.InstancedBufferAttribute;
  vis.setX(slot, vis.getX(last));
  const moved = cm.slotPiece[last]!;
  cm.slotPiece[slot] = moved;
  cm.slotPiece[last] = -1;
  return moved;
}

interface Failure {
  building: number;
  story: number;
  timer: number;
  duration: number;
  cluster: Cluster | null;
  imbalance: number;
  tx: number;
  tz: number;
  trickle: number;
}

/**
 * Structural integrity (DESIGN.md §7.6): connectivity checks from the ground after damage, and
 * delayed stress failure (creak → dust → sag → collapse after 2–8 s) for under-supported stories.
 */
export class StructuralSystem {
  readonly clusters: Cluster[] = [];
  private dirty = new Set<number>();
  readonly failures = new Map<number, Failure>();
  readonly pool: ClusterMeshPool;
  private rng = new Rng(0x57c);

  constructor(
    private readonly scene: THREE.Scene,
    private readonly physics: Physics,
    private readonly city: CityStructure,
    private readonly renderer: PieceRenderer,
    private readonly debris: DebrisSystem,
    private readonly host: CollapseHost & {
      /** Make a single piece loose debris (small unsupported groups). */
      dropPiece(id: number): void;
      /** Rebuild a building's colliders right now (before a section takes over its pieces). */
      rebuildNow(building: number): void;
      /** Story-0 trickle and creak fx while a story is failing. */
      stressFx(x: number, y: number, z: number, intensity: number): void;
    },
  ) {
    this.pool = new ClusterMeshPool(
      pieceMaterial(),
      config.structure.clusterMeshCapacity,
      config.structure.clusterMeshPool,
    );
  }

  markDirty(building: number) {
    this.dirty.add(building);
  }

  get pendingChecks() {
    return this.dirty.size;
  }

  /** Per frame: run a few queued structural checks. */
  update(maxChecks: number) {
    let n = 0;
    for (const bi of this.dirty) {
      this.dirty.delete(bi);
      this.check(bi);
      if (++n >= maxChecks) break;
    }
  }

  private check(bi: number) {
    const b = this.city.buildings[bi]!;
    const s = this.city.store;
    const groups = b.findUnsupported(s, this.city.mark, this.city.queue);
    let changed = false;
    for (const g of groups) {
      if (g.length <= config.structure.smallClusterPieces) {
        for (const id of g) this.host.dropPiece(id);
      } else {
        this.host.rebuildNow(bi);
        this.spawnCluster(b, g, false);
      }
      changed = true;
    }
    if (changed) this.host.rebuildNow(bi);

    if (!this.failures.has(bi)) {
      const over = b.findOverloadedStory(s, config.structure.minColumnFraction, (id) =>
        this.capacity(id),
      );
      if (over) this.startFailure(bi, over);
    }
  }

  /** Column load capacity (1 = intact). Hot steel loses strength (heat vision, M4). */
  capacity(id: number) {
    const s = this.city.store;
    const t = s.temperature[id]!;
    return t > 300 ? Math.max(0, 1 - (t - 300) / 500) : 1;
  }

  private startFailure(
    bi: number,
    over: { story: number; tx: number; tz: number; imbalance: number },
  ) {
    const st = config.structure;
    const duration = this.rng.range(st.failDelayMin, Math.max(st.failDelayMin, st.failDelayMax));
    const f: Failure = {
      building: bi,
      story: over.story,
      timer: 0,
      duration,
      cluster: null,
      imbalance: over.imbalance,
      tx: over.tx,
      tz: over.tz,
      trickle: 0,
    };
    this.failures.set(bi, f);
    const b = this.city.buildings[bi]!;
    events.emit('building:stress', {
      building: bi,
      x: (b.x0 + b.x1) / 2,
      y: (over.story + 0.5) * config.construction.floorHeight,
      z: (b.z0 + b.z1) / 2,
      duration,
    });
  }

  fixedUpdate(dt: number) {
    for (const [bi, f] of this.failures) {
      f.timer += dt;
      const b = this.city.buildings[bi]!;
      const H = config.construction.floorHeight;
      const k = f.timer / f.duration;
      // Phase 1 (first third): creak only. Then dust trickles and the section begins to sag.
      f.trickle -= dt;
      if (k > 0.2 && f.trickle <= 0) {
        f.trickle = 0.25 - 0.15 * k;
        const x = this.rng.range(b.x0, b.x1);
        const z = this.rng.range(b.z0, b.z1);
        this.host.stressFx(x, (f.story + 0.9) * H, z, k);
      }
      if (k > 0.35 && !f.cluster) {
        const above = this.sectionAbove(b, f.story);
        if (above.length === 0) {
          this.failures.delete(bi);
          continue;
        }
        this.host.rebuildNow(bi);
        f.cluster = this.spawnCluster(b, above, true);
        this.host.rebuildNow(bi);
        f.cluster.startSag(f.tx, f.tz, f.duration - f.timer);
      }
      if (f.timer >= f.duration) {
        // Collapse: the failing story gives way completely.
        for (let id = b.base; id < b.end; id++) {
          if (b.floorOf(id) === f.story && this.city.store.isStatic(id) && id < b.roofBase) {
            this.host.crushStatic(id);
          }
        }
        this.host.rebuildNow(bi);
        f.cluster?.release(config.structure.toppleRate * f.imbalance);
        events.emit('building:collapse', {
          building: bi,
          x: (b.x0 + b.x1) / 2,
          z: (b.z0 + b.z1) / 2,
          story: f.story,
        });
        this.failures.delete(bi);
        this.dirty.add(bi);
      }
    }

    for (let i = this.clusters.length - 1; i >= 0; i--) {
      const c = this.clusters[i]!;
      const alive = c.fixedUpdate(dt, this.host);
      this.flushRubble(c);
      if (!alive) {
        c.dispose(this.scene);
        this.clusters.splice(i, 1);
      }
    }
  }

  /** Static pieces above story f, plus the slab at its top (what the story carried). */
  private sectionAbove(b: BuildingModel, f: number) {
    const s = this.city.store;
    const out: number[] = [];
    for (let id = b.base; id < b.end; id++) {
      if (!s.isStatic(id)) continue;
      const fl = b.floorOf(id);
      const isSlab = id >= b.slabBase && id < b.panelBase;
      if (fl > f || (fl === f && isSlab) || id >= b.roofBase) out.push(id);
    }
    return out;
  }

  private spawnCluster(b: BuildingModel, pieces: number[], kinematic: boolean) {
    const c = new Cluster(
      this.physics,
      this.city,
      this.renderer,
      b,
      pieces,
      kinematic,
      this.scene,
      this.pool,
    );
    this.clusters.push(c);
    events.emit('cluster:spawn', { building: b.id, pieces: pieces.length, mass: c.mass });
    return c;
  }

  /** Crushed pieces of a section fall as rubble chunks from their current world position. */
  private flushRubble(c: Cluster) {
    if (c.pendingRubble.length === 0) return;
    const s = this.city.store;
    const sc = config.debris.rubbleScale;
    for (const id of c.pendingRubble) {
      c.pieceWorld(id, _p);
      const v = this.renderer.visualFor(id, true);
      const it = this.debris.spawn(
        v,
        _p.x,
        _p.y,
        _p.z,
        s.hx[id]! * sc,
        s.hy[id]! * sc,
        s.hz[id]! * sc,
        c.rotation,
        this.rng.range(-2, 2),
        this.rng.range(-3, 0),
        this.rng.range(-2, 2),
        1000,
        false,
      );
      if (!it) {
        // Visual pool full: drop it straight onto the pile below.
        const ground = this.debris.piles.heightAt(_p.x, _p.z);
        this.debris.addRubble(
          v,
          _p.x,
          ground + s.hy[id]! * sc,
          _p.z,
          s.hx[id]! * sc,
          Math.min(s.hy[id]!, s.hz[id]!, s.hx[id]!) * sc,
          s.hz[id]! * sc,
          this.rng.range(0, 6.28),
          this.rng.range(-0.3, 0.3),
        );
        this.debris.piles.add(_p.x, _p.z, s.volume(id));
      }
    }
    c.pendingRubble.length = 0;
  }

  /** For the HUD/tests. */
  get fallingPieces() {
    let n = 0;
    for (const c of this.clusters) n += c.pieceCount;
    return n;
  }
}
