import * as THREE from 'three/webgpu';
import {
  abs,
  attribute,
  color,
  float,
  fract,
  max,
  mix,
  normalGeometry,
  positionWorld,
  select,
  smoothstep,
  step,
  cameraPosition,
  floor,
  normalize,
  pow,
  vec3,
} from 'three/tsl';
import { config } from '../config';
import type { CityStructure } from '../destruction/cityStructure';
import { MAT } from '../destruction/pieces';
import { SHADOW_ONLY_LAYER } from './environment';
import { hash, roomRadiance } from './interiorMapping';

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
      g.setAttribute('aInfo', new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4));
      g.setAttribute(
        'aKind',
        new THREE.InstancedBufferAttribute(new Float32Array(n).fill(KINDS.indexOf(k)), 1),
      );
      const mesh = new THREE.InstancedMesh(g, proxyMaterial(), n);
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
      // Building seed for its rooms (look and which lights are on).
      const info = mesh.geometry.getAttribute('aInfo') as THREE.InstancedBufferAttribute;
      info.setXYZW(index, ((i * 0.6180339) % 1) * 97.13, 1, 0, 0);
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
let sharedProxy: THREE.MeshStandardNodeMaterial | null = null;

/**
 * One facade material for every untouched building (look chosen per instance by aKind), in the
 * same bay/floor coordinates as its panels so it matches the piece materials: window openings,
 * curtain-wall mullions, brick courses, open parking decks, and the room behind every window.
 */
function proxyMaterial(): THREE.MeshStandardNodeMaterial {
  if (sharedProxy) return sharedProxy;
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.85, metalness: 0.02 });
  const t = attribute<'vec3'>('aTint', 'vec3');
  const grid = attribute<'vec4'>('aGrid', 'vec4');
  const kind = attribute<'float'>('aKind', 'float');
  const isGlass = abs(kind.sub(KINDS.indexOf('glass'))).lessThan(0.5);
  const isBrick = abs(kind.sub(KINDS.indexOf('brick'))).lessThan(0.5);
  const isParking = abs(kind.sub(KINDS.indexOf('parking'))).lessThan(0.5);
  const H = config.construction.floorHeight;
  // Proxies are never rotated, so the box's own normal is its world normal. Reading the attribute
  // (rather than normalWorld) also avoids three.js emitting the shared world normal inside one of the
  // branches below, which left the lighting with an unset normal (black facades).
  const nW = normalGeometry;
  const n = abs(nW);
  const top = step(0.5, n.y);
  const along = select(
    n.x.greaterThan(0.5),
    positionWorld.z.sub(grid.y).div(grid.w),
    positionWorld.x.sub(grid.x).div(grid.z),
  );
  const u = fract(along);
  const v = fract(positionWorld.y.div(H));
  const roof = t.mul(color(0x8a8986));
  // Interior mapping: the room behind each bay's window on each floor.
  const info = attribute<'vec4'>('aInfo', 'vec4');
  const bay = floor(along);
  const storey = floor(positionWorld.y.div(H));
  const seed = hash(
    info.x.add(storey.mul(0.137)),
    bay.mul(0.311).add(nW.x.mul(3.1)).add(nW.z.mul(7.3)),
  );
  const tangent = select(n.x.greaterThan(0.5), vec3(0, 0, 1), vec3(1, 0, 0));
  const { radiance } = roomRadiance({
    u,
    v,
    tangent,
    outward: nW,
    width: select(n.x.greaterThan(0.5), grid.w, grid.z),
    height: H,
    seed,
    power: info.y,
    fire: info.z,
    burnt: info.w,
  });
  const view = normalize(positionWorld.sub(cameraPosition));
  const seeThrough = float(1).sub(pow(float(1).sub(abs(view.dot(nW))), 3).mul(0.85));
  const roomLight = radiance.mul(seeThrough).mul(float(1).sub(top));

  // Curtain wall.
  const mullion = max(
    float(1)
      .sub(smoothstep(0.015, 0.03, u))
      .add(smoothstep(0.97, 0.985, u)),
    float(1)
      .sub(smoothstep(0.02, 0.04, v))
      .add(smoothstep(0.96, 0.98, v)),
  );
  const spandrel = step(v, 0.22);
  const tinted = t.mul(color(0x5d7d96));
  const glassFace = mix(mix(tinted, tinted.mul(0.55), spandrel), color(0x3a3f45), mullion);
  const glassVision = float(1).sub(max(mullion, spandrel));
  // Punched windows.
  const win = smoothstep(0.12, 0.15, u)
    .mul(float(1).sub(smoothstep(0.85, 0.88, u)))
    .mul(smoothstep(0.28, 0.31, v))
    .mul(float(1).sub(smoothstep(0.86, 0.89, v)));
  // Brick courses.
  const y = positionWorld.y.div(0.075);
  const bx = fract(
    along
      .mul(select(n.x.greaterThan(0.5), grid.w, grid.z))
      .div(0.22)
      .add(y.floor().mul(0.5)),
  );
  const mortar = max(
    float(1).sub(smoothstep(0.0, 0.08, fract(y))),
    float(1).sub(smoothstep(0.0, 0.05, bx)),
  );
  const brickness = select(isBrick, float(1), float(0));
  const wallBase = mix(
    t.mul(color(0xa9a59d)),
    mix(t.mul(color(0x9b4f3a)), color(0xb9b1a4), mortar.mul(0.7)),
    brickness,
  );
  const punchedFace = mix(wallBase, color(0x2a333c), win);
  // Parking: a parapet band at the bottom of each floor, dark beyond it.
  const open = step(config.construction.parapetHeight / H, v).mul(float(1).sub(step(0.9, v)));
  const parkingFace = mix(t.mul(color(0xa9a59d)), color(0x16171a), open);

  const face = select(isGlass, glassFace, select(isParking, parkingFace, punchedFace));
  m.colorNode = mix(face, roof, top);
  m.roughnessNode = mix(
    select(
      isGlass,
      mix(float(0.06), float(0.5), max(mullion, spandrel)),
      select(isParking, float(0.85), mix(float(0.88), float(0.12), win)),
    ),
    float(0.8),
    top,
  );
  m.metalnessNode = mix(
    select(
      isGlass,
      mix(float(0.75), float(0.3), mullion),
      select(isParking, float(0.02), mix(float(0.02), float(0.55), win)),
    ),
    float(0.05),
    top,
  );
  m.emissiveNode = roomLight.mul(
    select(isGlass, glassVision.mul(0.9), select(isParking, float(0), win)),
  );
  sharedProxy = m;
  return m;
}
