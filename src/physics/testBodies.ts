import * as THREE from 'three/webgpu';
import type RAPIER from '@dimforge/rapier3d-compat';
import { config } from '../config';
import { events } from '../core/events';
import { Rng } from '../core/rng';
import type { Physics } from './physics';

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qa = new THREE.Quaternion();
const _s = new THREE.Vector3();

/**
 * Debug rigid bodies (M0): exercises Rapier, sleeping, the body budget and interpolated
 * rendering through one InstancedMesh (one draw call). Later debris uses the same pattern.
 */
export class TestBodies {
  readonly mesh: THREE.InstancedMesh;
  private bodies: RAPIER.RigidBody[] = [];
  private sizes: Float32Array;
  /** prev/curr transforms for interpolation: pos xyz + quat xyzw. */
  private prev: Float32Array;
  private curr: Float32Array;
  private rng = new Rng(0xb0d1e5);

  constructor(
    private readonly physics: Physics,
    scene: THREE.Scene,
    readonly capacity: number,
  ) {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshStandardNodeMaterial({
      color: 0xb8b2a6,
      roughness: 0.7,
      metalness: 0.05,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.count = 0;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const colors = new Float32Array(capacity * 3);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);
    this.sizes = new Float32Array(capacity);
    this.prev = new Float32Array(capacity * 7);
    this.curr = new Float32Array(capacity * 7);
    scene.add(this.mesh);
  }

  get count() {
    return this.bodies.length;
  }

  /** Spawns up to `n` bodies in a loose cloud around `center`. Returns how many were spawned. */
  spawn(n: number, center: THREE.Vector3): number {
    const R = this.physics.R;
    const budgetLeft = config.budgets.activeRigidBodies - this.physics.countActiveDynamic();
    const room = Math.min(n, this.capacity - this.bodies.length, Math.max(0, budgetLeft));
    const color = new THREE.Color();
    for (let i = 0; i < room; i++) {
      const size = config.debug.testBodySize * this.rng.range(0.6, 1.6);
      const x = center.x + this.rng.range(-6, 6);
      const y = center.y + this.rng.range(0, 12);
      const z = center.z + this.rng.range(-6, 6);
      const body = this.physics.world.createRigidBody(
        R.RigidBodyDesc.dynamic()
          .setTranslation(x, y, z)
          .setRotation(randomQuat(this.rng))
          .setLinvel(this.rng.range(-3, 3), this.rng.range(-2, 2), this.rng.range(-3, 3))
          .setAngvel({
            x: this.rng.range(-2, 2),
            y: this.rng.range(-2, 2),
            z: this.rng.range(-2, 2),
          }),
      );
      const h = size / 2;
      this.physics.world.createCollider(
        R.ColliderDesc.cuboid(h, h, h).setDensity(2400).setFriction(0.8).setRestitution(0.1),
        body,
      );
      const idx = this.bodies.length;
      this.bodies.push(body);
      this.sizes[idx] = size;
      color.setHSL(0.08, this.rng.range(0.05, 0.25), this.rng.range(0.45, 0.7));
      this.mesh.setColorAt(idx, color);
      this.readInto(this.curr, idx, body);
      this.prev.set(this.curr.subarray(idx * 7, idx * 7 + 7), idx * 7);
    }
    this.mesh.count = this.bodies.length;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    if (room > 0) events.emit('physics:bodiesSpawned', { count: room });
    return room;
  }

  /** Call right after each physics step. */
  afterStep() {
    const tmp = this.prev;
    this.prev = this.curr;
    this.curr = tmp;
    for (let i = 0; i < this.bodies.length; i++) {
      const body = this.bodies[i]!;
      // Rapier's translation()/rotation() allocate; sleeping bodies keep their last transform.
      if (body.isSleeping()) this.copyPrev(i);
      else this.readInto(this.curr, i, body);
    }
  }

  private copyPrev(i: number) {
    const o = i * 7;
    for (let k = 0; k < 7; k++) this.curr[o + k] = this.prev[o + k]!;
  }

  /** Interpolated transforms into the instance buffer. */
  render(alpha: number) {
    const p = this.prev;
    const c = this.curr;
    for (let i = 0; i < this.bodies.length; i++) {
      const o = i * 7;
      _p.set(
        p[o]! + (c[o]! - p[o]!) * alpha,
        p[o + 1]! + (c[o + 1]! - p[o + 1]!) * alpha,
        p[o + 2]! + (c[o + 2]! - p[o + 2]!) * alpha,
      );
      _qa.set(p[o + 3]!, p[o + 4]!, p[o + 5]!, p[o + 6]!);
      _q.set(c[o + 3]!, c[o + 4]!, c[o + 5]!, c[o + 6]!);
      _qa.slerp(_q, alpha);
      const s = this.sizes[i]!;
      _s.set(s, s, s);
      _m.compose(_p, _qa, _s);
      this.mesh.setMatrixAt(i, _m);
    }
    this.mesh.instanceMatrix.needsUpdate = this.bodies.length > 0;
  }

  /** Debug/test: physics vs rendered position of body i. */
  debugSample(i: number) {
    const b = this.bodies[i];
    if (!b) return null;
    const m = new THREE.Matrix4();
    this.mesh.getMatrixAt(i, m);
    const p = new THREE.Vector3().setFromMatrixPosition(m);
    return {
      physics: b.translation(),
      rendered: { x: p.x, y: p.y, z: p.z },
      sleeping: b.isSleeping(),
    };
  }

  clear() {
    for (const b of this.bodies) this.physics.world.removeRigidBody(b);
    this.bodies.length = 0;
    this.mesh.count = 0;
  }

  private readInto(buf: Float32Array, i: number, body: RAPIER.RigidBody) {
    const t = body.translation();
    const r = body.rotation();
    const o = i * 7;
    buf[o] = t.x;
    buf[o + 1] = t.y;
    buf[o + 2] = t.z;
    buf[o + 3] = r.x;
    buf[o + 4] = r.y;
    buf[o + 5] = r.z;
    buf[o + 6] = r.w;
  }
}

function randomQuat(rng: Rng) {
  const q = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(
      rng.range(0, Math.PI * 2),
      rng.range(0, Math.PI * 2),
      rng.range(0, Math.PI * 2),
    ),
  );
  return { x: q.x, y: q.y, z: q.z, w: q.w };
}
