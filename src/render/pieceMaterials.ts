import * as THREE from 'three/webgpu';
import {
  abs,
  attribute,
  color,
  float,
  Fn,
  fract,
  If,
  max,
  mix,
  mx_noise_float,
  normalWorld,
  positionWorld,
  select,
  smoothstep,
  step,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { cameraPosition, floor, normalGeometry, normalize, positionGeometry, pow } from 'three/tsl';
import type { Node } from 'three/webgpu';
import { config } from '../config';
import { roomRadiance } from './interiorMapping';

/**
 * Materials for building pieces and debris (DESIGN.md §7.4, §12). Every mesh using them carries
 * two instanced attributes on its geometry:
 * - aTint  (vec3): per-instance colour multiplier (building variety);
 * - aState (vec4): x = crack amount 0..1, y = windows blown out, z = soot/scorch,
 *   w = frost (0..1) or heat glow (negative, -1 = white hot).
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
  | 'asphalt'
  | 'wood'
  | 'fabric'
  | 'metal'
  | 'drywall'
  | 'plant';

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
  'wood',
  'fabric',
  'metal',
  'drywall',
  'plant',
];

const tint = () => attribute<'vec3'>('aTint', 'vec3');
const state = () => attribute<'vec4'>('aState', 'vec4');
/** aRoom: x = facade side (integer part) + room seed (fraction), y = power, z = fire, w = burnt. */
const room = () => attribute<'vec4'>('aRoom', 'vec4');

/**
 * The room behind a panel's window (interior mapping), as emissive light. Only on the panel's
 * outward face; the inner face of a wall stays dark.
 */
function panelRoom(nW: Node<'vec3'>) {
  const r = room();
  const side = floor(r.x);
  const outward = select(
    side.lessThan(0.5),
    vec3(0, 0, -1),
    select(
      side.lessThan(1.5),
      vec3(1, 0, 0),
      select(side.lessThan(2.5), vec3(0, 0, 1), vec3(-1, 0, 0)),
    ),
  );
  const alongZ = abs(normalGeometry.x).greaterThan(0.5);
  const u = select(alongZ, positionGeometry.z, positionGeometry.x).add(0.5);
  const v = positionGeometry.y.add(0.5);
  const tangent = select(abs(nW.x).greaterThan(0.5), vec3(0, 0, 1), vec3(1, 0, 0));
  const facing = step(0.5, nW.dot(outward));
  const { radiance } = roomRadiance({
    u,
    v,
    tangent,
    outward,
    width: config.construction.bayWidth,
    height: config.construction.floorHeight,
    seed: fract(r.x),
    power: r.y,
    fire: r.z,
    burnt: r.w,
  });
  return radiance.mul(facing);
}

/** Glass reflects more at grazing angles, hiding the room behind it. */
function glassSeeThrough(nW: Node<'vec3'>) {
  const view = normalize(positionWorld.sub(cameraPosition));
  return float(1).sub(pow(float(1).sub(abs(view.dot(nW))), 3).mul(0.85));
}

/**
 * Cracks on the face plane: thin isolines of Perlin noise, wider and denser as damage rises.
 * No branch: only damaged buildings draw real pieces (the rest are proxies), so this is cheap.
 */
function crackMask(damage: Node<'float'>, nW: Node<'vec3'>) {
  const n = abs(nW);
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

/** Brightness of hot pieces (follows config.heatVision.brightness; set each frame). */
export const glowBrightness = uniform(config.heatVision.brightness * 0.45);

let shared: THREE.MeshStandardNodeMaterial | null = null;

/**
 * The one material every building piece, falling section, debris chunk and rubble instance uses.
 * The look comes from the per-instance aVisual attribute (an index into PIECE_VISUALS), chosen with
 * branches that are uniform per instance. One material means one set of shader pipelines to
 * compile instead of one per look (each costs ~150 ms on integrated GPUs).
 */
export function pieceMaterial(_kind?: PieceVisual): THREE.MeshStandardNodeMaterial {
  if (!shared) shared = createUberMaterial();
  return shared;
}

export const VI = (v: PieceVisual) => PIECE_VISUALS.indexOf(v);
const visualAttr = () => attribute<'float'>('aVisual', 'float');
/** visual == v (instance-uniform, so the branch is coherent). */
const is = (vis: Node<'float'>, v: PieceVisual) => abs(vis.sub(VI(v))).lessThan(0.5);
const isAny = (vis: Node<'float'>, ...vs: PieceVisual[]) => {
  let c = is(vis, vs[0]!);
  for (let k = 1; k < vs.length; k++) c = c.or(is(vis, vs[k]!));
  return c;
};

/** Curtain-wall mullion mask from the face UVs. */
function mullionMask() {
  const u = uv();
  return max(
    float(1)
      .sub(smoothstep(0.015, 0.03, u.x))
      .add(smoothstep(0.97, 0.985, u.x)),
    float(1)
      .sub(smoothstep(0.02, 0.04, u.y))
      .add(smoothstep(0.96, 0.98, u.y)),
  );
}

function createUberMaterial(): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.85, metalness: 0.02 });

  const shade = Fn(() => {
    // Evaluate the world normal up front. three.js emits a shared node where it is first built, and
    // if that is inside a branch (the crack branch below) the lighting later reads an unset normal
    // and every undamaged surface renders black.
    const nW = normalWorld.toVar();
    const vis = visualAttr();
    const s = state();
    const t = tint();
    const broken = s.y;
    const col = vec3(0.7, 0.7, 0.7).toVar();
    const rough = float(0.85).toVar();
    const glassy = float(0).toVar();

    If(is(vis, 'structure'), () => {
      col.assign(t.mul(color(0xb3aea4)));
      rough.assign(0.88);
    })
      .ElseIf(isAny(vis, 'concrete', 'frameConcrete'), () => {
        const base = t.mul(color(0xa9a59d));
        col.assign(base);
        If(is(vis, 'concrete'), () => {
          const win = windowMask();
          const glass = mix(color(0x2a333c), color(0x050607), broken);
          col.assign(mix(base, glass, win));
          rough.assign(mix(float(0.85), mix(float(0.12), float(0.95), broken), win));
        });
      })
      .ElseIf(isAny(vis, 'brick', 'frameBrick'), () => {
        // Running-bond brick: courses every 0.075 m, offset each course, mortar lines.
        const y = positionWorld.y.div(0.075);
        const course = y.floor();
        const along = select(abs(nW.x).greaterThan(0.5), positionWorld.z, positionWorld.x);
        const bx = fract(along.div(0.22).add(course.mul(0.5)));
        const mortar = max(
          float(1).sub(smoothstep(0.0, 0.08, fract(y))),
          float(1).sub(smoothstep(0.0, 0.05, bx)),
        );
        const base = mix(t.mul(color(0x9b4f3a)), color(0xb9b1a4), mortar.mul(0.7));
        col.assign(base);
        rough.assign(0.92);
        If(is(vis, 'brick'), () => {
          const win = windowMask();
          const glass = mix(color(0x2a333c), color(0x050607), broken);
          col.assign(mix(base, glass, win));
          rough.assign(mix(float(0.92), mix(float(0.15), float(0.95), broken), win));
        });
      })
      .ElseIf(is(vis, 'glass'), () => {
        // Curtain wall: reflective tinted glass with mullions at the bay edges and a spandrel band.
        const mullion = mullionMask();
        const spandrel = step(uv().y, 0.22);
        const glass = t.mul(color(0x5d7d96));
        col.assign(mix(mix(glass, glass.mul(0.55), spandrel), color(0x3a3f45), mullion));
        rough.assign(mix(float(0.06), float(0.5), max(mullion, spandrel)));
        glassy.assign(1);
      })
      .ElseIf(is(vis, 'frameGlass'), () => {
        col.assign(color(0x3a3f45));
        rough.assign(0.5);
      })
      .ElseIf(is(vis, 'roof'), () => {
        col.assign(t.mul(color(0x8e8f8f)));
        rough.assign(0.7);
      })
      .ElseIf(is(vis, 'asphalt'), () => {
        col.assign(t.mul(color(0x3d3f42)));
        rough.assign(0.95);
      })
      .ElseIf(is(vis, 'wood'), () => {
        col.assign(t.mul(color(0x8a6a4a)));
        rough.assign(0.75);
      })
      .ElseIf(is(vis, 'fabric'), () => {
        col.assign(t.mul(color(0x7a6a64)));
        rough.assign(0.98);
      })
      .ElseIf(is(vis, 'metal'), () => {
        col.assign(t.mul(color(0x9a9ea4)));
        rough.assign(0.45);
      })
      .ElseIf(is(vis, 'drywall'), () => {
        col.assign(t.mul(color(0xdedad2)));
        rough.assign(0.95);
      })
      .Else(() => {
        col.assign(t.mul(color(0x456a32)));
        rough.assign(0.9);
      });

    // Cracks only where there is damage (most pieces are intact). Glass cracks show bright.
    If(s.x.greaterThan(0.01), () => {
      const c = crackMask(s.x, nW);
      const bright = mix(col, vec3(0.85, 0.9, 0.95), c.mul(0.8));
      const dark = mix(col, col.mul(0.18), c);
      col.assign(mix(dark, bright, glassy));
    });
    // Soot and charring (fire, heat).
    col.assign(mix(col, color(0x0c0b0a), smoothstep(0, 1, s.z).mul(0.9)));
    // Frost (freeze breath): rime in blotches over everything, glassy where it's thick.
    const frost = max(s.w, 0);
    const rime = smoothstep(-0.3, 0.5, mx_noise_float(positionWorld.mul(2.3)));
    const crystals = smoothstep(0.1, 0.45, mx_noise_float(positionWorld.mul(13)));
    const frostK = frost.mul(rime.mul(0.35).add(crystals.mul(0.3)).add(0.35));
    col.assign(mix(col, color(0xd8e8f4), frostK.mul(0.85)));
    rough.assign(mix(rough, float(0.3), frostK));
    return vec4(col, rough);
  });

  const metalness = Fn(() => {
    const vis = visualAttr();
    const s = state();
    const out = float(0.02).toVar();
    If(isAny(vis, 'concrete', 'brick'), () => {
      out.assign(mix(float(0.02), mix(float(0.55), float(0), s.y), windowMask()));
    })
      .ElseIf(is(vis, 'glass'), () => {
        out.assign(mix(float(0.75), float(0.3), mullionMask()));
      })
      .ElseIf(is(vis, 'frameGlass').or(is(vis, 'metal')), () => {
        out.assign(0.6);
      })
      .ElseIf(is(vis, 'roof'), () => {
        out.assign(0.25);
      });
    return out;
  });

  const emissive = Fn(() => {
    const nW = normalWorld.toVar(); // see shade()
    const vis = visualAttr();
    const s = state();
    const out = vec3(0, 0, 0).toVar();
    {
      // One room per panel, masked by its window shape (punched window or curtain-wall vision glass).
      If(isAny(vis, 'concrete', 'brick', 'glass'), () => {
        const glassMask = float(1)
          .sub(max(mullionMask(), step(uv().y, 0.22)))
          .mul(glassSeeThrough(nW))
          .mul(0.9);
        const punched = windowMask().mul(mix(glassSeeThrough(nW), float(1), s.y));
        out.assign(panelRoom(nW).mul(select(is(vis, 'glass'), glassMask, punched)));
      });
      // Soot darkens the rooms too.
      out.assign(out.mul(float(1).sub(smoothstep(0, 1, s.z).mul(0.8))));
    }
    // Heat glow (heat vision, fire): dull red, orange, then white hot (aState.w < 0).
    const glow = max(s.w.negate(), 0);
    const hot = mix(
      mix(vec3(0.55, 0.03, 0.0), vec3(1.0, 0.32, 0.04), smoothstep(0.0, 0.5, glow)),
      vec3(1.0, 0.88, 0.62),
      smoothstep(0.5, 1.0, glow),
    );
    out.addAssign(hot.mul(glow.mul(glow).mul(glowBrightness)));
    return out;
  });

  const sh = shade();
  m.colorNode = sh.xyz;
  m.roughnessNode = sh.w;
  m.metalnessNode = metalness();
  m.emissiveNode = emissive();
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
export function batchGeometry(base: THREE.BufferGeometry, capacity: number, visual: PieceVisual) {
  const g = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'uv']) g.setAttribute(name, base.getAttribute(name));
  g.setIndex(base.getIndex());
  const tintAttr = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3).fill(1), 3);
  const stateAttr = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
  tintAttr.setUsage(THREE.DynamicDrawUsage);
  stateAttr.setUsage(THREE.DynamicDrawUsage);
  g.setAttribute('aTint', tintAttr);
  g.setAttribute('aState', stateAttr);
  const roomAttr = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
  for (let i = 0; i < capacity; i++) roomAttr.setXYZW(i, 0.5, 1, 0, 0);
  roomAttr.setUsage(THREE.DynamicDrawUsage);
  g.setAttribute('aRoom', roomAttr);
  const visAttr = new THREE.InstancedBufferAttribute(
    new Float32Array(capacity).fill(VI(visual)),
    1,
  );
  visAttr.setUsage(THREE.DynamicDrawUsage);
  g.setAttribute('aVisual', visAttr);
  return { geometry: g, tint: tintAttr, state: stateAttr, room: roomAttr, visual: visAttr };
}
