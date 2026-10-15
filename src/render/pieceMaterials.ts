import * as THREE from 'three/webgpu';
import {
  abs,
  attribute,
  color,
  float,
  fract,
  max,
  mix,
  mx_noise_float,
  normalWorld,
  positionWorld,
  select,
  smoothstep,
  step,
  uv,
  vec2,
  vec3,
} from 'three/tsl';
import type { Node } from 'three/webgpu';

/**
 * Materials for building pieces and debris (DESIGN.md §7.4, §12). Every mesh using them carries
 * two instanced attributes on its geometry:
 * - aTint  (vec3): per-instance colour multiplier (building variety);
 * - aState (vec4): x = crack amount 0..1, y = windows blown out, z = scorch (M4), w = frost (M4).
 */
export type PieceVisual =
  | 'structure'
  | 'concrete'
  | 'brick'
  | 'glass'
  | 'roof'
  | 'frameConcrete'
  | 'frameBrick'
  | 'frameGlass'
  | 'asphalt';

export const PIECE_VISUALS: PieceVisual[] = [
  'structure',
  'concrete',
  'brick',
  'glass',
  'roof',
  'frameConcrete',
  'frameBrick',
  'frameGlass',
  'asphalt',
];

const tint = () => attribute<'vec3'>('aTint', 'vec3');
const state = () => attribute<'vec4'>('aState', 'vec4');

/**
 * Cracks on the face plane: thin isolines of Perlin noise, wider and denser as damage rises.
 * No branch: only damaged buildings draw real pieces (the rest are proxies), so this is cheap.
 */
function crackMask(damage: Node<'float'>) {
  const n = abs(normalWorld);
  const p = select(
    n.x.greaterThan(0.5),
    vec2(positionWorld.z, positionWorld.y),
    select(
      n.z.greaterThan(0.5),
      vec2(positionWorld.x, positionWorld.y),
      vec2(positionWorld.x, positionWorld.z),
    ),
  );
  const width = damage.mul(0.06).add(0.008);
  const fine = float(1).sub(smoothstep(0, width, abs(mx_noise_float(p.mul(1.6)))));
  // A larger octave for the big structural cracks of heavy damage.
  const big = float(1).sub(smoothstep(0, width.mul(0.8), abs(mx_noise_float(p.mul(0.45)))));
  return max(fine.mul(smoothstep(0.05, 0.4, damage)), big.mul(smoothstep(0.45, 0.9, damage)));
}

/** Window opening mask from the face UVs (one window per bay, sill and head bands). */
function windowMask() {
  const u = uv();
  const inX = smoothstep(0.12, 0.15, u.x).mul(float(1).sub(smoothstep(0.85, 0.88, u.x)));
  const inY = smoothstep(0.28, 0.31, u.y).mul(float(1).sub(smoothstep(0.86, 0.89, u.y)));
  // Only on the big faces of a panel, not its thin edges.
  return inX.mul(inY);
}

const cache = new Map<PieceVisual, THREE.MeshStandardNodeMaterial>();

/** Shared material per visual (buildings, falling sections, debris and rubble all use these). */
export function pieceMaterial(kind: PieceVisual): THREE.MeshStandardNodeMaterial {
  let m = cache.get(kind);
  if (!m) cache.set(kind, (m = createPieceMaterial(kind)));
  return m;
}

export function createPieceMaterial(kind: PieceVisual): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.85, metalness: 0.02 });
  const s = state();
  const t = tint();
  const cracks = crackMask(s.x);
  const darkCrack = (base: Node<'vec3'>) => mix(base, base.mul(0.18), cracks);
  const broken = s.y;

  switch (kind) {
    case 'structure': {
      m.colorNode = darkCrack(t.mul(color(0xb3aea4)));
      m.roughnessNode = float(0.88);
      break;
    }
    case 'concrete':
    case 'frameConcrete': {
      const base = t.mul(color(0xa9a59d));
      if (kind === 'concrete') {
        const win = windowMask();
        const glass = mix(color(0x34414e), color(0x07090b), broken);
        m.colorNode = darkCrack(mix(base, glass, win) as Node<'vec3'>);
        m.roughnessNode = mix(float(0.85), mix(float(0.18), float(0.95), broken), win);
        m.metalnessNode = mix(float(0.02), mix(float(0.5), float(0), broken), win);
      } else {
        m.colorNode = darkCrack(base);
      }
      break;
    }
    case 'brick':
    case 'frameBrick': {
      // Running-bond brick: courses every 0.075 m, offset each course, mortar lines.
      const y = positionWorld.y.div(0.075);
      const course = y.floor();
      const along = select(abs(normalWorld.x).greaterThan(0.5), positionWorld.z, positionWorld.x);
      const bx = fract(along.div(0.22).add(course.mul(0.5)));
      const mortar = max(
        float(1).sub(smoothstep(0.0, 0.08, fract(y))),
        float(1).sub(smoothstep(0.0, 0.05, bx)),
      );
      const brick = t.mul(color(0x9b4f3a));
      const base = mix(brick, color(0xb9b1a4), mortar.mul(0.7));
      if (kind === 'brick') {
        const win = windowMask();
        const glass = mix(color(0x2f3a44), color(0x07090b), broken);
        m.colorNode = darkCrack(mix(base, glass, win) as Node<'vec3'>);
        m.roughnessNode = mix(float(0.92), mix(float(0.2), float(0.95), broken), win);
      } else {
        m.colorNode = darkCrack(base as Node<'vec3'>);
      }
      break;
    }
    case 'glass': {
      // Curtain wall: reflective tinted glass with mullions at the bay edges and a spandrel band.
      const u = uv();
      const mullion = max(
        float(1)
          .sub(smoothstep(0.015, 0.03, u.x))
          .add(smoothstep(0.97, 0.985, u.x)),
        float(1)
          .sub(smoothstep(0.02, 0.04, u.y))
          .add(smoothstep(0.96, 0.98, u.y)),
      );
      const spandrel = step(u.y, 0.22);
      const glass = t.mul(color(0x5d7d96));
      const frame = color(0x3a3f45);
      const base = mix(mix(glass, glass.mul(0.55), spandrel), frame, mullion);
      // Cracked glass shows bright fracture lines rather than dark ones.
      m.colorNode = mix(base, vec3(0.85, 0.9, 0.95), cracks.mul(0.8));
      m.roughnessNode = mix(float(0.06), float(0.5), max(mullion, spandrel));
      m.metalnessNode = mix(float(0.75), float(0.3), mullion);
      break;
    }
    case 'frameGlass': {
      m.colorNode = color(0x3a3f45);
      m.roughnessNode = float(0.5);
      m.metalnessNode = float(0.6);
      break;
    }
    case 'roof': {
      m.colorNode = darkCrack(t.mul(color(0x8e8f8f)));
      m.roughnessNode = float(0.7);
      m.metalnessNode = float(0.25);
      break;
    }
    case 'asphalt': {
      m.colorNode = t.mul(color(0x3d3f42));
      m.roughnessNode = float(0.95);
      break;
    }
  }
  return m;
}

/** A unit box with a rectangular hole: what a breached panel becomes (DESIGN.md §7.2). */
export function createFrameGeometry(bar = 0.2, sill = 0.28, head = 0.2): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const add = (w: number, h: number, x: number, y: number) => {
    const g = new THREE.BoxGeometry(w, h, 1);
    g.translate(x, y, 0);
    parts.push(g);
  };
  add(1, sill, 0, -0.5 + sill / 2); // bottom
  add(1, head, 0, 0.5 - head / 2); // top
  const mid = 1 - sill - head;
  const midY = -0.5 + sill + mid / 2;
  add(bar, mid, -0.5 + bar / 2, midY); // left
  add(bar, mid, 0.5 - bar / 2, midY); // right
  return mergeBoxes(parts);
}

/** Merges non-indexed-compatible box geometries (same attributes) into one. */
export function mergeBoxes(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let vtx = 0;
  let idx = 0;
  for (const p of parts) {
    vtx += p.getAttribute('position').count;
    idx += p.getIndex()!.count;
  }
  const pos = new Float32Array(vtx * 3);
  const nrm = new Float32Array(vtx * 3);
  const uvs = new Float32Array(vtx * 2);
  const index = new Uint32Array(idx);
  let vo = 0;
  let io = 0;
  for (const p of parts) {
    const pa = p.getAttribute('position').array as Float32Array;
    const na = p.getAttribute('normal').array as Float32Array;
    const ua = p.getAttribute('uv').array as Float32Array;
    const ia = p.getIndex()!.array;
    pos.set(pa, vo * 3);
    nrm.set(na, vo * 3);
    uvs.set(ua, vo * 2);
    for (let i = 0; i < ia.length; i++) index[io + i] = ia[i]! + vo;
    vo += p.getAttribute('position').count;
    io += ia.length;
    p.dispose();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  g.setIndex(new THREE.BufferAttribute(index, 1));
  return g;
}

/**
 * Geometry for one instanced batch: shares the base mesh's buffers and adds its own instanced
 * aTint / aState attributes (read by the materials above).
 */
export function batchGeometry(base: THREE.BufferGeometry, capacity: number) {
  const g = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'uv']) g.setAttribute(name, base.getAttribute(name));
  g.setIndex(base.getIndex());
  const tintAttr = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3).fill(1), 3);
  const stateAttr = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
  tintAttr.setUsage(THREE.DynamicDrawUsage);
  stateAttr.setUsage(THREE.DynamicDrawUsage);
  g.setAttribute('aTint', tintAttr);
  g.setAttribute('aState', stateAttr);
  return { geometry: g, tint: tintAttr, state: stateAttr };
}
