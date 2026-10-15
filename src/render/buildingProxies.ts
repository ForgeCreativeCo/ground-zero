import * as THREE from 'three/webgpu';
import {
  abs,
  attribute,
  color,
  float,
  fract,
  max,
  mix,
  normalWorld,
  positionWorld,
  select,
  smoothstep,
  step,
} from 'three/tsl';
import { config } from '../config';
import type { CityStructure } from '../destruction/cityStructure';
import { MAT } from '../destruction/pieces';
import { SHADOW_ONLY_LAYER } from './environment';

type ProxyKind = 'glass' | 'concrete' | 'brick' | 'parking';
const KINDS: ProxyKind[] = ['glass', 'concrete', 'brick', 'parking'];

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();

/**
 * Cheap stand-ins for buildings nobody has touched yet. An intact building draws as one box whose
 * shader reproduces its exact bay/floor/window layout (so the swap to real pieces on first damage
 * doesn't jump), instead of thousands of piece instances. Damaged ("active") buildings render
 * their real pieces; they cast shadows through merged shadow-only boxes built from their colliders.
 */
export class BuildingProxies {
  readonly group = new THREE.Group();
  private meshes = new Map<ProxyKind, THREE.InstancedMesh>();
  /** building → [kind, instance index] */
  private slot: { kind: ProxyKind; index: number }[] = [];
  private shadow: THREE.InstancedMesh;
  private shadowBoxes = new Map<number, Float32Array>();
  private shadowDirty = false;

  constructor(
    scene: THREE.Scene,
    private readonly city: CityStructure,
    tints: Float32Array,
  ) {
    const counts = new Map<ProxyKind, number>();
    const kindOf = (i: number): ProxyKind => {
      const b = city.buildings[i]!;
      if (b.src.parking) return 'parking';
      return b.facadeMat === MAT.glass ? 'glass' : b.facadeMat === MAT.brick ? 'brick' : 'concrete';
    };
    city.buildings.forEach((_b, i) => counts.set(kindOf(i), (counts.get(kindOf(i)) ?? 0) + 1));
    const box = new THREE.BoxGeometry(1, 1, 1);
    for (const k of KINDS) {
      const n = counts.get(k) ?? 0;
      if (n === 0) continue;
      const g = new THREE.BufferGeometry();
      for (const name of ['position', 'normal', 'uv']) g.setAttribute(name, box.getAttribute(name));
      g.setIndex(box.getIndex());
      g.setAttribute('aTint', new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3));
      g.setAttribute('aGrid', new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4));
      const mesh = new THREE.InstancedMesh(g, proxyMaterial(k), n);
      mesh.count = 0;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.meshes.set(k, mesh);
      this.group.add(mesh);
    }
    const pt = config.construction.panelThickness;
    city.buildings.forEach((b, i) => {
      const k = kindOf(i);
      const mesh = this.meshes.get(k)!;
      const index = mesh.count++;
      this.slot[i] = { kind: k, index };
      _m.compose(
        _p.set((b.x0 + b.x1) / 2, b.height / 2, (b.z0 + b.z1) / 2),
        _q.identity(),
        _s.set(b.x1 - b.x0, b.height, b.z1 - b.z0),
      );
      mesh.setMatrixAt(index, _m);
      const tint = mesh.geometry.getAttribute('aTint') as THREE.InstancedBufferAttribute;
      tint.setXYZ(index, tints[i * 3]!, tints[i * 3 + 1]!, tints[i * 3 + 2]!);
      // Grid origin and bay widths, matching BuildingModel's panel layout exactly.
      const grid = mesh.geometry.getAttribute('aGrid') as THREE.InstancedBufferAttribute;
      grid.setXYZW(index, b.x0, b.z0 + pt, b.bwx, b.bwz);
    });
    for (const m of this.meshes.values()) {
      m.instanceMatrix.needsUpdate = true;
      m.computeBoundingSphere();
    }

    // Shadow casters for active buildings: merged boxes on a layer only shadow cameras render.
    const shadowMat = new THREE.MeshBasicNodeMaterial();
    this.shadow = new THREE.InstancedMesh(box, shadowMat, 8192);
    this.shadow.layers.set(SHADOW_ONLY_LAYER);
    this.shadow.count = 0;
    this.shadow.castShadow = true;
    this.shadow.receiveShadow = false;
    this.shadow.frustumCulled = false;
    this.shadow.renderOrder = -1;
    this.group.add(this.shadow);
    scene.add(this.group);
  }

  /** Startup shader prewarm: draw one shadow box so its shadow-pass shader is compiled. */
  setPrewarm(on: boolean) {
    if (on) {
      this.shadow.setMatrixAt(0, _m.makeTranslation(0, -50, 0));
      this.shadow.count = Math.max(1, this.shadow.count);
    } else {
      this.shadowDirty = true;
      this.shadow.count = 0;
    }
    this.shadow.instanceMatrix.needsUpdate = true;
  }

  /** Hide/show a building's proxy (active buildings draw their real pieces). */
  setActive(building: number, active: boolean) {
    const s = this.slot[building]!;
    const mesh = this.meshes.get(s.kind)!;
    const b = this.city.buildings[building]!;
    if (active) _m.makeScale(0, 0, 0);
    else
      _m.compose(
        _p.set((b.x0 + b.x1) / 2, b.height / 2, (b.z0 + b.z1) / 2),
        _q.identity(),
        _s.set(b.x1 - b.x0, b.height, b.z1 - b.z0),
      );
    mesh.setMatrixAt(s.index, _m);
    mesh.instanceMatrix.needsUpdate = true;
  }

  /** Shadow boxes for an active building: flat array of [cx, cy, cz, hx, hy, hz] per box. */
  setShadowBoxes(building: number, boxes: Float32Array) {
    this.shadowBoxes.set(building, boxes);
    this.shadowDirty = true;
  }

  flush() {
    if (!this.shadowDirty) return;
    this.shadowDirty = false;
    let n = 0;
    const cap = this.shadow.instanceMatrix.count;
    for (const boxes of this.shadowBoxes.values()) {
      for (let k = 0; k + 5 < boxes.length && n < cap; k += 6) {
        _m.compose(
          _p.set(boxes[k]!, boxes[k + 1]!, boxes[k + 2]!),
          _q.identity(),
          _s.set(boxes[k + 3]! * 2, boxes[k + 4]! * 2, boxes[k + 5]! * 2),
        );
        this.shadow.setMatrixAt(n++, _m);
      }
    }
    this.shadow.count = n;
    this.shadow.instanceMatrix.needsUpdate = true;
  }
}

/**
 * Facade shader for a whole building, in the same bay/floor coordinates as its panels, so it
 * matches the piece materials (window openings, curtain-wall mullions, brick courses).
 */
function proxyMaterial(kind: ProxyKind) {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.85, metalness: 0.02 });
  const t = attribute<'vec3'>('aTint', 'vec3');
  const grid = attribute<'vec4'>('aGrid', 'vec4');
  const H = config.construction.floorHeight;
  const n = abs(normalWorld);
  const top = step(0.5, n.y);
  const along = select(
    n.x.greaterThan(0.5),
    positionWorld.z.sub(grid.y).div(grid.w),
    positionWorld.x.sub(grid.x).div(grid.z),
  );
  const u = fract(along);
  const v = fract(positionWorld.y.div(H));
  const roof = t.mul(color(0x8a8986));
  if (kind === 'glass') {
    const mullion = max(
      float(1)
        .sub(smoothstep(0.015, 0.03, u))
        .add(smoothstep(0.97, 0.985, u)),
      float(1)
        .sub(smoothstep(0.02, 0.04, v))
        .add(smoothstep(0.96, 0.98, v)),
    );
    const spandrel = step(v, 0.22);
    const glass = t.mul(color(0x5d7d96));
    const face = mix(mix(glass, glass.mul(0.55), spandrel), color(0x3a3f45), mullion);
    m.colorNode = mix(face, roof, top);
    m.roughnessNode = mix(mix(float(0.06), float(0.5), max(mullion, spandrel)), float(0.8), top);
    m.metalnessNode = mix(mix(float(0.75), float(0.3), mullion), float(0.1), top);
    return m;
  }
  const win = smoothstep(0.12, 0.15, u)
    .mul(float(1).sub(smoothstep(0.85, 0.88, u)))
    .mul(smoothstep(0.28, 0.31, v))
    .mul(float(1).sub(smoothstep(0.86, 0.89, v)));
  if (kind === 'parking') {
    // Open decks: a parapet band at the bottom of each floor, dark beyond it.
    const parapet = config.construction.parapetHeight / H;
    const open = step(parapet, v).mul(float(1).sub(step(0.9, v)));
    const face = mix(t.mul(color(0xa9a59d)), color(0x16171a), open);
    m.colorNode = mix(face, roof, top);
    return m;
  }
  let base;
  if (kind === 'brick') {
    const y = positionWorld.y.div(0.075);
    const course = y.floor();
    const bx = fract(
      along
        .mul(select(n.x.greaterThan(0.5), grid.w, grid.z))
        .div(0.22)
        .add(course.mul(0.5)),
    );
    const mortar = max(
      float(1).sub(smoothstep(0.0, 0.08, fract(y))),
      float(1).sub(smoothstep(0.0, 0.05, bx)),
    );
    base = mix(t.mul(color(0x9b4f3a)), color(0xb9b1a4), mortar.mul(0.7));
  } else {
    base = t.mul(color(0xa9a59d));
  }
  const glass = color(kind === 'brick' ? 0x2f3a44 : 0x34414e);
  m.colorNode = mix(mix(base, glass, win), roof, top);
  m.roughnessNode = mix(mix(float(0.88), float(0.18), win), float(0.8), top);
  m.metalnessNode = mix(mix(float(0.02), float(0.5), win), float(0.05), top);
  return m;
}
