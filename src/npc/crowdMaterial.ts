import * as THREE from 'three/webgpu';
import {
  abs,
  attribute,
  float,
  Fn,
  fract,
  luminance,
  max,
  mix,
  mx_noise_float,
  normalLocal,
  normalMap,
  normalView,
  normalize,
  positionGeometry,
  select,
  smoothstep,
  texture,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import type { CharacterAssets } from './characterAssets';

/**
 * Crowd material (DESIGN.md §9.2-9.3). Every character (all bodies, LODs and hair styles) draws
 * with this material from per-instance attributes on an InstancedBufferGeometry:
 * - iPos  (vec4): world feet position, height scale
 * - iRot  (vec4): world rotation quaternion
 * - iAnim (vec4): texture row of clip A, row of clip B, blend A->B, width scale
 * - iSkin (vec4): skin tint rgb, sleeve length (0 none, 1 short, 2 long)
 * - iShirt(vec4): shirt rgb, trouser length (0 shorts, 1 long)
 * - iPants(vec4): trousers rgb, shoe style (0 black, 1 brown, 2 white trainers, 3 grey)
 * - iHair (vec4): hair rgb, condition (+ charred 0..1, - frozen 0..1)
 *
 * Skinning reads 3x4 bone matrices from the baked animation texture (npc/animBake.ts) and blends
 * two clips. Clothing is painted from the bind-pose position, because the base bodies are in
 * underwear: waist, neckline, sleeves and trouser legs are cut at skeleton landmarks.
 */
export const INSTANCE_ATTRS = [
  'iPos',
  'iRot',
  'iAnim',
  'iSkin',
  'iShirt',
  'iPants',
  'iHair',
] as const;
export const FLOATS_PER_INSTANCE = INSTANCE_ATTRS.length * 4;

const a4 = (name: string) => attribute<'vec4'>(name, 'vec4');

/** Rotates v by unit quaternion q. */
function qrot(q: Node<'vec4'>, v: Node<'vec3'>) {
  const t = q.xyz.cross(v).mul(2);
  return v.add(t.mul(q.w)).add(q.xyz.cross(t));
}

function landmarks(a: CharacterAssets) {
  const male = a.meta.bodies.male;
  const female = a.meta.bodies.female;
  const j = (b: typeof male, name: string) => b.bind[b.joints.indexOf(name)]!;
  // Female bind positions are mapped onto male proportions, so one set of cut lines fits both.
  const fx = j(male, 'hand_l')[0]! / j(female, 'hand_l')[0]!;
  const fy = male.height / female.height;
  return {
    fx,
    fy,
    waist: j(male, 'pelvis')[1]! + 0.06,
    neck: j(male, 'neck_01')[1]! - 0.04,
    torso: j(male, 'upperarm_l')[0]! - 0.03,
    sleeveNone: j(male, 'upperarm_l')[0]! - 0.01,
    sleeveShort: (j(male, 'upperarm_l')[0]! + j(male, 'lowerarm_l')[0]!) / 2,
    sleeveLong: j(male, 'hand_l')[0]! - 0.035,
    shortsEnd: j(male, 'calf_l')[1]! + 0.1,
    longEnd: j(male, 'foot_l')[1]! + 0.03,
    shoeTop: j(male, 'foot_l')[1]! + 0.045,
  };
}

export function createCrowdMaterials(a: CharacterAssets) {
  const W = a.bake.width;
  const H = a.bake.height;
  const bake = a.bakeTex;
  const row = (r: Node<'float'>, col: Node<'float'>) =>
    texture(bake, vec2(col.add(0.5).div(W), r.add(0.5).div(H))).level(float(0));

  const position = Fn(() => {
    const pos = a4('iPos');
    const rot = a4('iRot');
    const anim = a4('iAnim');
    const ji = attribute<'uvec4'>('skinIndex', 'uvec4');
    const jw = attribute<'vec4'>('skinWeight', 'vec4');
    const m0 = vec4(0, 0, 0, 0).toVar();
    const m1 = vec4(0, 0, 0, 0).toVar();
    const m2 = vec4(0, 0, 0, 0).toVar();
    for (const c of ['x', 'y', 'z', 'w'] as const) {
      const col = float(ji[c]).mul(3);
      const w = jw[c];
      m0.addAssign(mix(row(anim.x, col), row(anim.y, col), anim.z).mul(w));
      m1.addAssign(mix(row(anim.x, col.add(1)), row(anim.y, col.add(1)), anim.z).mul(w));
      m2.addAssign(mix(row(anim.x, col.add(2)), row(anim.y, col.add(2)), anim.z).mul(w));
    }
    const p = positionGeometry;
    const n = normalLocal;
    const posed = vec3(m0.xyz.dot(p).add(m0.w), m1.xyz.dot(p).add(m1.w), m2.xyz.dot(p).add(m2.w));
    const nPosed = vec3(m0.xyz.dot(n), m1.xyz.dot(n), m2.xyz.dot(n));
    const s = pos.w;
    const scaled = vec3(posed.x.mul(s).mul(anim.w), posed.y.mul(s), posed.z.mul(s).mul(anim.w));
    normalLocal.assign(normalize(qrot(rot, nPosed)));
    return qrot(rot, scaled).add(pos.xyz);
  })();

  const L = landmarks(a);
  const R = a.meta.atlas;
  const rect = (i: number) => {
    const r = R.rects[i]!;
    return vec4(r[0]! / R.width, r[1]! / R.height, r[2]! / R.width, r[3]! / R.height);
  };
  const part = attribute<'float'>('_part', 'float');
  const isBody = part.lessThan(1.5);
  const isHair = part.greaterThan(1.5).and(part.lessThan(3.5));
  const isEye = part.greaterThan(3.5);
  const r = select(
    part.lessThan(0.5),
    rect(0),
    select(
      part.lessThan(1.5),
      rect(1),
      select(part.lessThan(2.5), rect(2), select(part.lessThan(3.5), rect(3), rect(4))),
    ),
  );
  const uvp = select(isEye, fract(uv()), uv());
  const atlasUv = r.xy.add(uvp.mul(r.zw));
  const tex = texture(a.colorTex, atlasUv);
  const ntex = texture(a.normalTex, atlasUv);

  const skin = a4('iSkin');
  const shirt = a4('iShirt');
  const pants = a4('iPants');
  const hair = a4('iHair');

  // Clothing masks from the bind pose (female mapped onto male proportions).
  const isFemale = part.greaterThan(0.5).and(part.lessThan(1.5));
  const bp = select(isFemale, positionGeometry.mul(vec3(L.fx, L.fy, 1)), positionGeometry);
  const ax = abs(bp.x);
  const y = bp.y;
  const e = 0.008;
  const sleeveEnd = select(
    skin.w.lessThan(0.5),
    float(L.sleeveNone),
    select(skin.w.lessThan(1.5), float(L.sleeveShort), float(L.sleeveLong)),
  );
  const neckLine = select(ax.lessThan(0.1), float(L.neck), float(L.neck + 0.12));
  const shirtM = smoothstep(L.waist - e, L.waist + e, y)
    .mul(float(1).sub(smoothstep(neckLine.sub(e), neckLine.add(e), y)))
    .mul(float(1).sub(smoothstep(sleeveEnd.sub(e), sleeveEnd.add(e), ax)));
  const pantsEnd = select(shirt.w.lessThan(0.5), float(L.shortsEnd), float(L.longEnd));
  const pantsM = float(1)
    .sub(smoothstep(L.waist - e, L.waist + e, y))
    .mul(smoothstep(pantsEnd.sub(e), pantsEnd.add(e), y));
  const shoeM = float(1).sub(smoothstep(L.shoeTop - e, L.shoeTop + e, y));
  const cloth = select(isBody, max(max(shirtM, pantsM), shoeM), float(0));
  // Fabric: soft folds from noise on the bind pose (no texture under it: the underwear would show).
  const folds = mx_noise_float(bp.mul(vec3(9, 22, 9)))
    .mul(0.08)
    .add(0.96);
  const shoe = select(
    pants.w.lessThan(0.5),
    vec3(0.012, 0.012, 0.013),
    select(
      pants.w.lessThan(1.5),
      vec3(0.06, 0.03, 0.015),
      select(pants.w.lessThan(2.5), vec3(0.7, 0.7, 0.68), vec3(0.12, 0.13, 0.15)),
    ),
  );
  let body: Node<'vec3'> = tex.rgb.mul(skin.rgb);
  body = mix(body, pants.rgb.mul(folds), pantsM);
  body = mix(body, shirt.rgb.mul(folds), shirtM);
  body = mix(body, shoe, shoeM);
  const hairCol = hair.rgb.mul(luminance(tex.rgb).mul(2.4)).min(vec3(1, 1, 1));
  let col: Node<'vec3'> = select(isBody, body, select(isHair, hairCol, tex.rgb));
  // Condition: charred (heat vision) or frozen (freeze breath).
  const charred = max(hair.w, 0);
  const frozen = max(hair.w.negate(), 0);
  col = mix(col, vec3(0.025, 0.02, 0.018), charred);
  col = mix(col, vec3(0.72, 0.86, 1), frozen.mul(0.85));
  const alpha = select(isHair, tex.a, float(1));

  const rough = select(
    isBody,
    mix(ntex.a, float(0.86), cloth),
    select(isHair, float(0.6), float(0.2)),
  );
  const mapped = normalMap(ntex.rgb) as unknown as Node<'vec3'>;
  const nrm = normalize(mix(mapped, normalView, cloth.max(select(isEye, float(1), float(0)))));

  const make = (side: THREE.Side) => {
    const m = new THREE.MeshStandardNodeMaterial({ side });
    m.positionNode = position;
    m.colorNode = vec4(col, alpha);
    m.roughnessNode = mix(rough, float(0.12), frozen);
    m.metalnessNode = float(0);
    m.normalNode = nrm;
    m.alphaTest = 0.5;
    return m;
  };
  return { body: make(THREE.FrontSide), hair: make(THREE.DoubleSide) };
}
