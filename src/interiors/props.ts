import * as THREE from 'three/webgpu';
import { abs, attribute, color, float, mix, select, smoothstep, vec3 } from 'three/tsl';
import type { Node } from 'three/webgpu';
import { uploadLive } from '../render/uploadRange';
import type { Prop, PropVisual } from './furnishing';

export const PROP_VISUALS: PropVisual[] = [
  'wood',
  'fabric',
  'metal',
  'drywall',
  'plant',
  'light',
  'screen',
];

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

/** Live prop records, structure-of-arrays, with a free list. */
export class PropStore {
  readonly visual: Uint8Array;
  readonly unit: Int32Array;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly z: Float32Array;
  readonly hx: Float32Array;
  readonly hy: Float32Array;
  readonly hz: Float32Array;
  readonly yaw: Float32Array;
  readonly hp: Float32Array;
  readonly fuel: Float32Array;
  readonly alive: Uint8Array;
  /** Slot in its visual's instanced mesh. */
  readonly slot: Int32Array;
  private free: number[] = [];
  private next = 0;
  liveCount = 0;

  constructor(readonly capacity: number) {
    this.visual = new Uint8Array(capacity);
    this.unit = new Int32Array(capacity).fill(-1);
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.z = new Float32Array(capacity);
    this.hx = new Float32Array(capacity);
    this.hy = new Float32Array(capacity);
    this.hz = new Float32Array(capacity);
    this.yaw = new Float32Array(capacity);
    this.hp = new Float32Array(capacity);
    this.fuel = new Float32Array(capacity);
    this.alive = new Uint8Array(capacity);
    this.slot = new Int32Array(capacity).fill(-1);
  }

  alloc(): number {
    const id = this.free.pop() ?? (this.next < this.capacity ? this.next++ : -1);
    if (id >= 0) {
      this.alive[id] = 1;
      this.liveCount++;
    }
    return id;
  }

  release(id: number) {
    if (!this.alive[id]) return;
    this.alive[id] = 0;
    this.unit[id] = -1;
    this.slot[id] = -1;
    this.free.push(id);
    this.liveCount--;
  }

  get highWater() {
    return this.next;
  }
}

class PropMesh {
  readonly mesh: THREE.InstancedMesh;
  readonly tint: THREE.InstancedBufferAttribute;
  /** x = char 0..1, y = light on (light panels / screens), z, w unused. */
  readonly state: THREE.InstancedBufferAttribute;
  readonly visual: THREE.InstancedBufferAttribute;
  readonly slotProp: Int32Array;
  count = 0;
  dirty = false;

  constructor(geometry: THREE.BufferGeometry, material: THREE.Material, capacity: number) {
    const g = new THREE.BufferGeometry();
    for (const name of ['position', 'normal', 'uv'])
      g.setAttribute(name, geometry.getAttribute(name));
    g.setIndex(geometry.getIndex());
    this.tint = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3).fill(1), 3);
    this.state = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.tint.setUsage(THREE.DynamicDrawUsage);
    this.state.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aTint', this.tint);
    g.setAttribute('aProp', this.state);
    this.visual = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    this.visual.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aPropVisual', this.visual);
    this.mesh = new THREE.InstancedMesh(g, material, capacity);
    this.mesh.count = 0;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.slotProp = new Int32Array(capacity).fill(-1);
  }

  flush() {
    if (!this.dirty) return;
    this.dirty = false;
    this.mesh.count = this.count;
    uploadLive(this.count, this.mesh.instanceMatrix, this.tint, this.state, this.visual);
  }
}

/**
 * Interior props (furniture, interior walls, lights): two instanced meshes (boxes and round plants)
 * with the look picked per instance, made up front (three.js generates shader code per instanced
 * mesh, so making meshes mid-play would stall).
 */
export class PropRenderer {
  readonly group = new THREE.Group();
  readonly store: PropStore;
  private meshes: PropMesh[] = [];

  constructor(scene: THREE.Scene, capacity: number) {
    this.store = new PropStore(capacity);
    const box = new THREE.BoxGeometry(1, 1, 1);
    const blob = new THREE.IcosahedronGeometry(0.5, 1);
    for (const [geo, cap] of [
      [box, capacity],
      [blob, Math.ceil(capacity / 8)],
    ] as const) {
      const pm = new PropMesh(geo, propMaterial(), cap);
      this.meshes.push(pm);
      this.group.add(pm.mesh);
    }
    scene.add(this.group);
  }

  /** Adds a prop; returns its id or -1 when full. */
  add(p: Prop, unit: number): number {
    const vi = PROP_VISUALS.indexOf(p.visual);
    const pm = this.meshes[p.visual === 'plant' ? 1 : 0]!;
    if (pm.count >= pm.slotProp.length) return -1;
    const s = this.store;
    const id = s.alloc();
    if (id < 0) return -1;
    s.visual[id] = vi;
    s.unit[id] = unit;
    s.x[id] = p.x;
    s.y[id] = p.y;
    s.z[id] = p.z;
    s.hx[id] = p.hx;
    s.hy[id] = p.hy;
    s.hz[id] = p.hz;
    s.yaw[id] = p.yaw;
    s.hp[id] = p.hp;
    s.fuel[id] = p.fuel;
    const slot = pm.count++;
    s.slot[id] = slot;
    pm.slotProp[slot] = id;
    _q.setFromAxisAngle(_up, p.yaw);
    _m.compose(_p.set(p.x, p.y, p.z), _q, _s.set(p.hx * 2, p.hy * 2, p.hz * 2));
    pm.mesh.setMatrixAt(slot, _m);
    pm.tint.setXYZ(slot, p.r, p.g, p.b);
    pm.state.setXYZW(slot, 0, 0, 0, 0);
    pm.visual.setX(slot, vi);
    pm.dirty = true;
    return id;
  }

  remove(id: number) {
    const s = this.store;
    if (!s.alive[id]) return;
    const pm = this.meshOf(id);
    const slot = s.slot[id]!;
    const last = --pm.count;
    if (slot !== last) {
      pm.mesh.getMatrixAt(last, _m);
      pm.mesh.setMatrixAt(slot, _m);
      pm.tint.setXYZ(slot, pm.tint.getX(last), pm.tint.getY(last), pm.tint.getZ(last));
      pm.state.setXYZW(
        slot,
        pm.state.getX(last),
        pm.state.getY(last),
        pm.state.getZ(last),
        pm.state.getW(last),
      );
      pm.visual.setX(slot, pm.visual.getX(last));
      const moved = pm.slotProp[last]!;
      pm.slotProp[slot] = moved;
      s.slot[moved] = slot;
    }
    pm.slotProp[last] = -1;
    pm.dirty = true;
    s.release(id);
  }

  /** Char (0..1) and light-on state for a prop. */
  setState(id: number, char: number, lit: number) {
    const s = this.store;
    if (!s.alive[id]) return;
    const pm = this.meshOf(id);
    pm.state.setXYZW(s.slot[id]!, char, lit, 0, 0);
    pm.dirty = true;
  }

  private meshOf(id: number) {
    return this.meshes[PROP_VISUALS[this.store.visual[id]!] === 'plant' ? 1 : 0]!;
  }

  /** The instanced meshes (for the shader warm-up). */
  get instancedMeshes() {
    return this.meshes.map((m) => m.mesh);
  }

  flush() {
    for (const m of this.meshes) m.flush();
  }

  /** Startup prewarm: draw each mesh once with a degenerate instance. */
  setPrewarm(on: boolean) {
    for (const m of this.meshes) {
      if (on && m.count === 0) {
        m.mesh.setMatrixAt(0, _m.makeScale(0, 0, 0));
        m.mesh.count = 1;
      } else if (!on) {
        m.mesh.count = m.count;
      }
      m.mesh.instanceMatrix.needsUpdate = true;
    }
  }
}

let sharedProp: THREE.MeshStandardNodeMaterial | null = null;

/**
 * One material for every prop look (picked per instance by aPropVisual), so furniture costs one
 * shader pipeline to compile instead of seven.
 */
function propMaterial(): THREE.MeshStandardNodeMaterial {
  if (sharedProp) return sharedProp;
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.8 });
  const t = attribute<'vec3'>('aTint', 'vec3');
  const st = attribute<'vec4'>('aProp', 'vec4');
  const pv = attribute<'float'>('aPropVisual', 'float');
  const is = (v: PropVisual) => abs(pv.sub(PROP_VISUALS.indexOf(v))).lessThan(0.5);
  const base: Record<PropVisual, number> = {
    wood: 0x8a6a4a,
    fabric: 0x7a6a64,
    metal: 0x9a9ea4,
    drywall: 0xdedad2,
    plant: 0x456a32,
    light: 0xf2f0ea,
    screen: 0x15181c,
  };
  // Per-look values by select (props are cheap; no expensive branches to skip).
  const pick = <T extends Node<'vec3'> | Node<'float'>>(vals: T[]) => {
    let out = vals[vals.length - 1]!;
    for (let k = vals.length - 2; k >= 0; k--)
      out = select(is(PROP_VISUALS[k]!), vals[k]!, out) as T;
    return out;
  };
  const col = pick(PROP_VISUALS.map((v) => color(base[v]) as unknown as Node<'vec3'>));
  const rough = pick(
    PROP_VISUALS.map((v) =>
      float(v === 'fabric' ? 0.98 : v === 'metal' ? 0.45 : v === 'screen' ? 0.2 : 0.8),
    ),
  );
  const metal = select(is('metal'), float(0.6), float(0));
  const glow = select(
    is('light'),
    vec3(1.0, 0.95, 0.85).mul(st.y).mul(2.5),
    select(is('screen'), vec3(0.35, 0.5, 0.7).mul(st.y).mul(0.6), vec3(0, 0, 0)),
  );
  const c = t.mul(col);
  // Charring: brown, then black as it burns; embers glow while it burns.
  const charred = mix(
    mix(c, color(0x2a1a10), smoothstep(0, 0.5, st.x)),
    color(0x080707),
    smoothstep(0.5, 1, st.x),
  );
  const ember = smoothstep(0.2, 0.6, st.x).mul(float(1).sub(smoothstep(0.85, 1, st.x)));
  m.colorNode = charred as Node<'vec3'>;
  m.roughnessNode = rough;
  m.metalnessNode = metal;
  m.emissiveNode = glow.add(vec3(1.4, 0.45, 0.1).mul(ember).mul(st.z.add(0.4)));
  sharedProp = m;
  return m;
}
