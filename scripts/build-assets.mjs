/**
 * Asset pipeline (DESIGN.md §9.2), run with `npm run assets`.
 *
 * Inputs (assets-src/, not shipped, CC0 Quaternius packs):
 *   quaternius-characters/  Universal Base Characters (glTF, rigged, no animations)
 *   quaternius-cars/        Realistic Car Pack (OBJ + MTL)
 *   quaternius-transport/   Public Transport Pack (OBJ + MTL)
 *
 * Outputs (public/assets/):
 *   characters/characters.glb   body + hair meshes per LOD, with skin attributes and a _PART id
 *   characters/atlas_color.webp one texture atlas for both bodies, both hair sheets and the eyes
 *   characters/atlas_normal.webp normals (rgb) + roughness (a), same layout
 *   characters/characters.json  skeleton (joint names, parents, bind positions), atlas rects, hair styles
 *   vehicles/vehicles.glb       one mesh per vehicle type (+ street props) with _ROLE and _WHEEL
 *   vehicles/vehicles.json      dimensions and wheel positions per type
 *
 * Animations are procedural and baked on the GPU at startup (src/npc/poses.ts), so the pipeline
 * only needs the bind skeleton.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Document, NodeIO } from '@gltf-transform/core';
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(root, 'assets-src');
const OUT = join(root, 'public', 'assets');
const CHAR_SRC = join(SRC, 'quaternius-characters', 'Universal Base Characters[Standard]');
const CARS_SRC = join(SRC, 'quaternius-cars', 'Realistic Car Pack - Nov 2018', 'OBJ');
const BUS_SRC = join(SRC, 'quaternius-transport', 'Public Transport Pack - Feb 2017', 'OBJ');

/** LOD triangle ratios (DESIGN.md §9.2: LOD0 full, LOD1 ~40%, LOD2 ~12%). */
const LOD_RATIOS = [1, 0.4, 0.12];

// ---------------------------------------------------------------------------------------------
// Characters
// ---------------------------------------------------------------------------------------------

/** Atlas layout (pixels). Bodies and hair sheets at 1024, eyes at 256. */
const ATLAS = { w: 2048, h: 2304 };
const RECTS = {
  male: [0, 0, 1024, 1024],
  female: [1024, 0, 1024, 1024],
  hair1: [0, 1024, 1024, 1024],
  hair2: [1024, 1024, 1024, 1024],
  eye: [0, 2048, 256, 256],
};
/** _PART ids, in the order the shader's rect table uses. */
const PART = { male: 0, female: 1, hair1: 2, hair2: 3, eye: 4 };
const PART_OF_MATERIAL = {
  MI_Superhero_Male: PART.male,
  MI_Superhero_Female: PART.female,
  MI_Hair_1: PART.hair1,
  MI_Hair_2: PART.hair2,
  MI_Eyes: PART.eye,
};

/** Which hair styles go on which body (from where each style's mesh sits on the head). */
const HAIR = {
  male: ['Hair_Buzzed', 'Hair_SimpleParted', 'Hair_Beard'],
  female: ['Hair_Long', 'Hair_Buns', 'Hair_BuzzedFemale'],
};

const io = new NodeIO();

/** Reads a .gltf without its textures (some referenced images are missing; we atlas our own). */
async function readGltf(file) {
  const json = JSON.parse(readFileSync(file, 'utf8'));
  delete json.images;
  delete json.textures;
  delete json.samplers;
  for (const m of json.materials ?? []) {
    delete m.normalTexture;
    delete m.occlusionTexture;
    delete m.emissiveTexture;
    if (m.pbrMetallicRoughness) {
      delete m.pbrMetallicRoughness.baseColorTexture;
      delete m.pbrMetallicRoughness.metallicRoughnessTexture;
    }
  }
  const resources = {};
  for (const b of json.buffers ?? [])
    resources[b.uri] = new Uint8Array(readFileSync(join(dirname(file), b.uri)));
  return io.readJSON({ json, resources });
}

function readPrimitives(doc, canonical) {
  const out = [];
  const skin = doc.getRoot().listSkins()[0];
  const jointNames = skin ? skin.listJoints().map((j) => j.getName()) : null;
  const remap = jointNames ? jointNames.map((n) => canonical.indexOf(n)) : null;
  if (remap && remap.some((i) => i < 0)) throw new Error('joint not in canonical skeleton');
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const matName = prim.getMaterial()?.getName() ?? '';
      const part = PART_OF_MATERIAL[matName];
      if (part === undefined) throw new Error(`unknown material ${matName}`);
      const pos = prim.getAttribute('POSITION').getArray();
      const nrm = prim.getAttribute('NORMAL').getArray();
      const uv = prim.getAttribute('TEXCOORD_0').getArray();
      const j = prim.getAttribute('JOINTS_0')?.getArray();
      const w = prim.getAttribute('WEIGHTS_0')?.getArray();
      const idx = prim.getIndices().getArray();
      const n = pos.length / 3;
      const joints = new Uint16Array(n * 4);
      const weights = new Float32Array(n * 4);
      for (let i = 0; i < n * 4; i++) {
        joints[i] = j ? remap[j[i]] : 0;
        weights[i] = w ? w[i] : 0;
      }
      // Normalise weights (some exporters leave them summing to slightly off 1).
      for (let i = 0; i < n; i++) {
        let s = 0;
        for (let k = 0; k < 4; k++) s += weights[i * 4 + k];
        if (s < 1e-6) {
          weights[i * 4] = 1;
          joints[i * 4] = canonical.indexOf('Head');
          s = 1;
        }
        for (let k = 0; k < 4; k++) weights[i * 4 + k] /= s;
      }
      out.push({
        name: mesh.getName(),
        part,
        pos: Float32Array.from(pos),
        nrm: Float32Array.from(nrm),
        uv: Float32Array.from(uv),
        joints,
        weights,
        idx: Uint32Array.from(idx),
      });
    }
  }
  return out;
}

function merge(prims) {
  let nv = 0;
  let ni = 0;
  for (const p of prims) {
    nv += p.pos.length / 3;
    ni += p.idx.length;
  }
  const m = {
    pos: new Float32Array(nv * 3),
    nrm: new Float32Array(nv * 3),
    uv: new Float32Array(nv * 2),
    joints: new Uint16Array(nv * 4),
    weights: new Float32Array(nv * 4),
    part: new Float32Array(nv),
    idx: new Uint32Array(ni),
  };
  let v = 0;
  let i = 0;
  for (const p of prims) {
    const n = p.pos.length / 3;
    m.pos.set(p.pos, v * 3);
    m.nrm.set(p.nrm, v * 3);
    m.uv.set(p.uv, v * 2);
    m.joints.set(p.joints, v * 4);
    m.weights.set(p.weights, v * 4);
    m.part.fill(p.part, v, v + n);
    for (let k = 0; k < p.idx.length; k++) m.idx[i + k] = p.idx[k] + v;
    v += n;
    i += p.idx.length;
  }
  return m;
}

/** Simplifies to a triangle ratio and compacts the vertex arrays. */
function simplify(m, ratio) {
  if (ratio >= 1) return m;
  const nv = m.pos.length / 3;
  // Normals and UVs count toward the error so seams and silhouettes hold.
  const attrs = new Float32Array(nv * 5);
  for (let v = 0; v < nv; v++) {
    attrs[v * 5] = m.nrm[v * 3];
    attrs[v * 5 + 1] = m.nrm[v * 3 + 1];
    attrs[v * 5 + 2] = m.nrm[v * 3 + 2];
    attrs[v * 5 + 3] = m.uv[v * 2];
    attrs[v * 5 + 4] = m.uv[v * 2 + 1];
  }
  const target = Math.floor((m.idx.length * ratio) / 3) * 3;
  const [idx] = MeshoptSimplifier.simplifyWithAttributes(
    m.idx,
    m.pos,
    3,
    attrs,
    5,
    [0.4, 0.4, 0.4, 0.8, 0.8],
    null,
    target,
    0.05,
    ['Prune'],
  );
  // Compact.
  const map = new Int32Array(nv).fill(-1);
  let n = 0;
  for (const k of idx) if (map[k] < 0) map[k] = n++;
  const out = {
    pos: new Float32Array(n * 3),
    nrm: new Float32Array(n * 3),
    uv: new Float32Array(n * 2),
    joints: new Uint16Array(n * 4),
    weights: new Float32Array(n * 4),
    part: new Float32Array(n),
    idx: new Uint32Array(idx.length),
  };
  for (let v = 0; v < nv; v++) {
    const t = map[v];
    if (t < 0) continue;
    for (let k = 0; k < 3; k++) {
      out.pos[t * 3 + k] = m.pos[v * 3 + k];
      out.nrm[t * 3 + k] = m.nrm[v * 3 + k];
    }
    out.uv[t * 2] = m.uv[v * 2];
    out.uv[t * 2 + 1] = m.uv[v * 2 + 1];
    for (let k = 0; k < 4; k++) {
      out.joints[t * 4 + k] = m.joints[v * 4 + k];
      out.weights[t * 4 + k] = m.weights[v * 4 + k];
    }
    out.part[t] = m.part[v];
  }
  for (let k = 0; k < idx.length; k++) out.idx[k] = map[idx[k]];
  return out;
}

function addMesh(doc, buffer, name, m) {
  const acc = (type, arr) => doc.createAccessor().setType(type).setArray(arr).setBuffer(buffer);
  const prim = doc
    .createPrimitive()
    .setAttribute('POSITION', acc('VEC3', m.pos))
    .setAttribute('NORMAL', acc('VEC3', m.nrm))
    .setAttribute('TEXCOORD_0', acc('VEC2', m.uv))
    .setAttribute('JOINTS_0', acc('VEC4', m.joints))
    .setAttribute('WEIGHTS_0', acc('VEC4', m.weights))
    .setAttribute('_PART', acc('SCALAR', m.part))
    .setIndices(acc('SCALAR', m.idx));
  const mesh = doc.createMesh(name).addPrimitive(prim);
  doc.getRoot().listScenes()[0].addChild(doc.createNode(name).setMesh(mesh));
  return m.idx.length / 3;
}

/** Bind skeleton: world-space joint positions from the node hierarchy, checked against the IBMs. */
function bindSkeleton(doc) {
  const skin = doc.getRoot().listSkins()[0];
  const joints = skin.listJoints();
  const names = joints.map((j) => j.getName());
  const parents = joints.map((j) => {
    const p = j.getParentNode();
    return p ? names.indexOf(p.getName()) : -1;
  });
  const ibm = skin.getInverseBindMatrices().getArray();
  const bind = [];
  let maxErr = 0;
  joints.forEach((j, k) => {
    const w = j.getWorldMatrix(); // column-major 4x4
    bind.push([w[12], w[13], w[14]]);
    // world * IBM should be identity when mesh space == world space.
    const m = ibm.subarray(k * 16, k * 16 + 16);
    for (let r = 0; r < 4; r++)
      for (let c = 0; c < 4; c++) {
        let s = 0;
        for (let q = 0; q < 4; q++) s += w[q * 4 + r] * m[c * 4 + q];
        maxErr = Math.max(maxErr, Math.abs(s - (r === c ? 1 : 0)));
      }
  });
  return { names, parents, bind, maxErr };
}

async function atlasImage(layers, channels) {
  const comps = [];
  for (const [file, rect, alphaFile, alphaFill] of layers) {
    let img = sharp(file).resize(rect[2], rect[3]).removeAlpha();
    let rgb = await img.raw().toBuffer();
    let a;
    if (alphaFile === 'self') {
      a = await sharp(file)
        .resize(rect[2], rect[3])
        .ensureAlpha()
        .extractChannel(3)
        .raw()
        .toBuffer();
    } else if (alphaFile) {
      a = await sharp(alphaFile).resize(rect[2], rect[3]).extractChannel(0).raw().toBuffer();
    } else {
      a = Buffer.alloc(rect[2] * rect[3], alphaFill ?? 255);
    }
    const rgba = Buffer.alloc(rect[2] * rect[3] * 4);
    for (let i = 0; i < rect[2] * rect[3]; i++) {
      rgba[i * 4] = rgb[i * 3];
      rgba[i * 4 + 1] = rgb[i * 3 + 1];
      rgba[i * 4 + 2] = rgb[i * 3 + 2];
      rgba[i * 4 + 3] = a[i];
    }
    comps.push({
      input: rgba,
      raw: { width: rect[2], height: rect[3], channels: 4 },
      left: rect[0],
      top: rect[1],
    });
  }
  return sharp({
    create: {
      width: ATLAS.w,
      height: ATLAS.h,
      channels,
      background: { r: 128, g: 128, b: 255, alpha: 1 },
    },
  }).composite(comps);
}

async function buildCharacters() {
  const outDir = join(OUT, 'characters');
  mkdirSync(outDir, { recursive: true });
  const base = join(CHAR_SRC, 'Base Characters', 'Godot - UE');
  const hairDir = join(CHAR_SRC, 'Hairstyles', 'Rigged to Head Bone', 'glTF (Godot -Unreal)');
  const doc = new Document();
  const buffer = doc.createBuffer();
  doc.createScene('characters');
  const meta = {
    atlas: {
      width: ATLAS.w,
      height: ATLAS.h,
      rects: [RECTS.male, RECTS.female, RECTS.hair1, RECTS.hair2, RECTS.eye],
    },
    lods: LOD_RATIOS,
    bodies: {},
  };
  for (const body of ['male', 'female']) {
    const file =
      body === 'male' ? 'Superhero_Male_FullBody.gltf' : 'Superhero_Female_FullBody.gltf';
    const src = await readGltf(join(base, file));
    const skel = bindSkeleton(src);
    console.log(
      `[chars] ${body}: ${skel.names.length} joints, bind check err ${skel.maxErr.toExponential(1)}`,
    );
    if (skel.maxErr > 1e-3)
      throw new Error('mesh space is not world space; pipeline needs the mesh node transform');
    const prims = readPrimitives(src, skel.names);
    const merged = merge(prims);
    let min = Infinity;
    let max = -Infinity;
    for (let i = 1; i < merged.pos.length; i += 3) {
      min = Math.min(min, merged.pos[i]);
      max = Math.max(max, merged.pos[i]);
    }
    const tris = [];
    LOD_RATIOS.forEach((r, k) =>
      tris.push(addMesh(doc, buffer, `${body}_body_${k}`, simplify(merged, r))),
    );
    const hair = [];
    for (const style of HAIR[body]) {
      const hdoc = await readGltf(join(hairDir, `${style}.gltf`));
      const hm = merge(readPrimitives(hdoc, skel.names));
      LOD_RATIOS.forEach((r, k) =>
        addMesh(doc, buffer, `${body}_${style}_${k}`, simplify(hm, Math.max(r, 0.25))),
      );
      hair.push(style);
    }
    meta.bodies[body] = {
      joints: skel.names,
      parents: skel.parents,
      bind: skel.bind.map((p) => p.map((x) => +x.toFixed(5))),
      height: +(max - min).toFixed(3),
      hair,
      tris,
    };
    console.log(
      `[chars] ${body}: height ${(max - min).toFixed(2)} m, tris per LOD ${tris.join(' / ')}`,
    );
  }
  await io.write(join(outDir, 'characters.glb'), doc);
  writeFileSync(join(outDir, 'characters.json'), JSON.stringify(meta));

  const tex = join(CHAR_SRC, 'Base Characters', 'Textures');
  const color = await atlasImage(
    [
      [join(tex, 'T_Superhero_Male_Ligh.png'), RECTS.male],
      [join(tex, 'T_Superhero_Female_Light_BaseColor.png'), RECTS.female],
      [join(tex, 'T_Hair_1_BaseColor.png'), RECTS.hair1, 'self'],
      [join(tex, 'T_Hair_2_BaseColor.png'), RECTS.hair2, 'self'],
      [join(tex, 'T_Eye_Brown.png'), RECTS.eye],
    ],
    4,
  );
  await color.webp({ quality: 90, alphaQuality: 100 }).toFile(join(outDir, 'atlas_color.webp'));
  // Normals (rgb) + roughness (a).
  const normal = await atlasImage(
    [
      [
        join(tex, 'T_Superhero_Male_Normal.png'),
        RECTS.male,
        join(tex, 'T_Superhero_Male_Roughness.png'),
      ],
      [
        join(tex, 'T_Superhero_Female_Normal.png'),
        RECTS.female,
        join(tex, 'T_Superhero_Female_Roughness.png'),
      ],
      [join(tex, 'T_Hair_1_Normal.png'), RECTS.hair1, null, 150],
      [join(tex, 'T_Hair_2_Normal.png'), RECTS.hair2, null, 150],
      [join(tex, 'T_Eye_Normal.png'), RECTS.eye, null, 60],
    ],
    4,
  );
  await normal.webp({ quality: 92, alphaQuality: 100 }).toFile(join(outDir, 'atlas_normal.webp'));
  console.log('[chars] wrote characters.glb, atlases, characters.json');
}

// ---------------------------------------------------------------------------------------------
// Vehicles
// ---------------------------------------------------------------------------------------------

/** Vertex roles (read by src/vehicles/vehicleMaterial.ts). */
const ROLE = {
  paint: 0,
  glass: 1,
  rubber: 2,
  trim: 3,
  headlight: 4,
  taillight: 5,
  fixed: 6,
  beaconBlue: 7,
  beaconWhite: 8,
  paintDark: 9,
  lampRed: 10,
  lampYellow: 11,
  lampGreen: 12,
};

const C = {
  black: [0.02, 0.02, 0.022],
  rubber: [0.035, 0.035, 0.035],
  grey: [0.16, 0.16, 0.17],
  trim: [0.1, 0.1, 0.11],
  glass: [0.03, 0.035, 0.04],
  head: [1, 0.95, 0.85],
  tail: [0.7, 0.05, 0.04],
  white: [0.8, 0.8, 0.8],
  yellow: [0.85, 0.6, 0.05],
  red: [0.6, 0.04, 0.03],
  pole: [0.2, 0.21, 0.2],
};

/**
 * Per type: source, real-world length (m) it is scaled to, which way its front faces in the
 * source file, and material name -> [role, colour]. `paint` vertices take the per-car colour.
 */
const VEHICLES = [
  {
    name: 'sedan',
    file: join(CARS_SRC, 'NormalCar1'),
    length: 4.6,
    front: '+z',
    mats: { Blue: 'paint' },
  },
  {
    name: 'hatch',
    file: join(CARS_SRC, 'NormalCar2'),
    length: 4.3,
    front: '+z',
    mats: { LightBlue: 'paint', 'Material.007': 'paintDark' },
  },
  {
    name: 'suv',
    file: join(CARS_SRC, 'SUV'),
    length: 4.8,
    width: 2.15,
    front: '+z',
    mats: { White: 'paint' },
  },
  {
    name: 'sports',
    file: join(CARS_SRC, 'SportsCar'),
    length: 4.5,
    front: '+z',
    mats: { Orange: 'paint', DarkOrange: 'paintDark' },
  },
  {
    name: 'coupe',
    file: join(CARS_SRC, 'SportsCar2'),
    length: 4.5,
    front: '+z',
    mats: { White: 'paint' },
  },
  {
    name: 'taxi',
    file: join(CARS_SRC, 'Taxi'),
    length: 4.7,
    front: '+z',
    mats: { Yellow: ['fixed', C.yellow] },
  },
  {
    name: 'police',
    file: join(CARS_SRC, 'Cop'),
    length: 4.9,
    front: '+z',
    mats: { White: ['fixed', C.white], BlueLights: 'beaconBlue', WhiteLights: 'beaconWhite' },
  },
  {
    name: 'bus',
    file: join(BUS_SRC, 'Bus'),
    height: 3.2,
    width: 2.55,
    front: '-x',
    mats: {
      Bottom: 'paint',
      Top: ['fixed', C.white],
      Material: 'rubber',
      Details: ['fixed', C.black],
      Bumper: 'trim',
      Lights: 'headlight',
    },
  },
  {
    name: 'schoolbus',
    file: join(BUS_SRC, 'SchoolBus'),
    height: 3.1,
    width: 2.5,
    front: '-x',
    mats: {
      Yellow: ['fixed', C.yellow],
      Wheel: 'rubber',
      Details: ['fixed', C.black],
      Bumper: ['fixed', C.black],
      Lights: 'headlight',
    },
  },
  {
    name: 'ambulance',
    file: join(BUS_SRC, 'Ambulance'),
    length: 6.4,
    width: 2.4,
    front: '+z',
    mats: {
      White: ['fixed', C.white],
      Red: ['fixed', C.red],
      Material: 'rubber',
      Grey: 'trim',
      Bumper: 'trim',
      Lights: 'headlight',
    },
  },
];

/** Shared defaults for the car pack's material names. */
const DEFAULT_MATS = {
  Black: 'rubber',
  Grey: 'trim',
  Windows: 'glass',
  Headlights: 'headlight',
  TailLights: 'taillight',
};

const ROLE_COLOR = {
  paint: [1, 1, 1],
  paintDark: [0.55, 0.55, 0.55],
  glass: C.glass,
  rubber: C.rubber,
  trim: C.trim,
  headlight: C.head,
  taillight: C.tail,
  beaconBlue: [0.05, 0.15, 1],
  beaconWhite: [1, 1, 1],
  lampRed: [1, 0.08, 0.04],
  lampYellow: [1, 0.6, 0.05],
  lampGreen: [0.1, 1, 0.3],
};

/** Minimal OBJ reader: positions, normals, faces (fan-triangulated), object and material per face. */
function readObj(file) {
  const v = [];
  const vn = [];
  const faces = [];
  let mat = '';
  let obj = '';
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const p = line.trim().split(/\s+/);
    if (p[0] === 'v') v.push(p.slice(1, 4).map(Number));
    else if (p[0] === 'vn') vn.push(p.slice(1, 4).map(Number));
    else if (p[0] === 'usemtl') mat = p[1];
    else if (p[0] === 'o' || p[0] === 'g') obj = p[1] ?? '';
    else if (p[0] === 'f') {
      const corners = p.slice(1).map((c) => {
        const [a, , n] = c.split('/');
        return [parseInt(a, 10) - 1, n ? parseInt(n, 10) - 1 : -1];
      });
      for (let k = 1; k + 1 < corners.length; k++)
        faces.push({ c: [corners[0], corners[k], corners[k + 1]], mat, obj });
    }
  }
  return { v, vn, faces };
}

/** Rotation that turns the file's front direction into +z. */
function frontRot(front) {
  switch (front) {
    case '+z':
      return (x, y, z) => [x, y, z];
    case '-z':
      return (x, y, z) => [-x, y, -z];
    case '+x':
      return (x, y, z) => [-z, y, x];
    case '-x':
      return (x, y, z) => [z, y, -x];
    default:
      throw new Error(front);
  }
}

function buildVehicle(doc, buffer, spec) {
  const obj = readObj(`${spec.file}.obj`);
  const rot = frontRot(spec.front);
  const pts = obj.v.map((p) => rot(p[0], p[1], p[2]));
  const nrms0 = obj.vn.map((p) => rot(p[0], p[1], p[2]));
  let mn = [Infinity, Infinity, Infinity];
  let mx = [-Infinity, -Infinity, -Infinity];
  for (const p of pts)
    for (let k = 0; k < 3; k++) {
      mn[k] = Math.min(mn[k], p[k]);
      mx[k] = Math.max(mx[k], p[k]);
    }
  const scale = spec.length ? spec.length / (mx[2] - mn[2]) : spec.height / (mx[1] - mn[1]);
  const cx = (mn[0] + mx[0]) / 2;
  const cz = (mn[2] + mx[2]) / 2;
  // Optional width (x) target: the transport pack is toy-proportioned (too wide for its length).
  const sx = spec.width ? spec.width / (mx[0] - mn[0]) : scale;
  const tr = (p) => [(p[0] - cx) * sx, (p[1] - mn[1]) * scale, (p[2] - cz) * scale];
  const P = pts.map(tr);
  // Non-uniform scale: normals scale by the inverse.
  const nrms = nrms0.map((q) => {
    const v = [q[0] / sx, q[1] / scale, q[2] / scale];
    const l = Math.hypot(...v) || 1;
    return v.map((x) => x / l);
  });

  // Wheels: every vertex of a wheel object, split by side (x sign) and axle (z sign).
  const wheelKey = (f, p) => {
    if (!/wheel/i.test(f.obj)) return -1;
    return (p[0] < 0 ? 0 : 1) + (p[2] < 0 ? 0 : 2);
  };
  const wb = [0, 1, 2, 3].map(() => ({
    mn: [Infinity, Infinity, Infinity],
    mx: [-Infinity, -Infinity, -Infinity],
    n: 0,
  }));
  for (const f of obj.faces)
    for (const [vi] of f.c) {
      const k = wheelKey(f, P[vi]);
      if (k < 0) continue;
      const b = wb[k];
      b.n++;
      for (let a = 0; a < 3; a++) {
        b.mn[a] = Math.min(b.mn[a], P[vi][a]);
        b.mx[a] = Math.max(b.mx[a], P[vi][a]);
      }
    }
  const wheels = wb
    .filter((b) => b.n > 0)
    .map((b) => {
      const c = [0, 1, 2].map((a) => (b.mn[a] + b.mx[a]) / 2);
      return { x: c[0], y: c[1], z: c[2], r: (b.mx[1] - b.mn[1]) / 2 };
    });
  const wheelOf = (f, p) => {
    const k = wheelKey(f, p);
    if (k < 0) return null;
    const b = wb[k];
    return [0, 1, 2].map((a) => (b.mn[a] + b.mx[a]) / 2);
  };

  const n = obj.faces.length * 3;
  const pos = new Float32Array(n * 3);
  const nrm = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  const role = new Float32Array(n);
  const wheel = new Float32Array(n * 4);
  const unknown = new Set();
  let i = 0;
  for (const f of obj.faces) {
    const m = spec.mats[f.mat] ?? DEFAULT_MATS[f.mat];
    let r;
    let c;
    if (Array.isArray(m)) [r, c] = [m[0], m[1]];
    else if (m) [r, c] = [m, ROLE_COLOR[m]];
    else {
      unknown.add(f.mat);
      [r, c] = ['trim', C.grey];
    }
    // Flat normal fallback.
    const a = P[f.c[0][0]];
    const b = P[f.c[1][0]];
    const d = P[f.c[2][0]];
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const e2 = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
    const fn = [
      e1[1] * e2[2] - e1[2] * e2[1],
      e1[2] * e2[0] - e1[0] * e2[2],
      e1[0] * e2[1] - e1[1] * e2[0],
    ];
    const fl = Math.hypot(...fn) || 1;
    for (const [vi, ni] of f.c) {
      const p = P[vi];
      pos.set(p, i * 3);
      nrm.set(ni >= 0 ? nrms[ni] : fn.map((x) => x / fl), i * 3);
      col.set(c, i * 3);
      role[i] = ROLE[r];
      const w = wheelOf(f, p);
      if (w) wheel.set([w[0], w[1], w[2], 1], i * 4);
      i++;
    }
  }
  if (unknown.size)
    console.warn(`[veh] ${spec.name}: unmapped materials ${[...unknown].join(', ')}`);
  // Weld identical corners into an indexed mesh.
  const keyOf = new Map();
  const remap = new Uint32Array(n);
  let u = 0;
  for (let k = 0; k < n; k++) {
    const key = [
      ...pos.subarray(k * 3, k * 3 + 3),
      ...nrm.subarray(k * 3, k * 3 + 3),
      ...col.subarray(k * 3, k * 3 + 3),
      role[k],
      wheel[k * 4 + 3],
    ]
      .map((x) => x.toFixed(4))
      .join(',');
    let t = keyOf.get(key);
    if (t === undefined) {
      t = u++;
      keyOf.set(key, t);
      pos.copyWithin(t * 3, k * 3, k * 3 + 3);
      nrm.copyWithin(t * 3, k * 3, k * 3 + 3);
      col.copyWithin(t * 3, k * 3, k * 3 + 3);
      role[t] = role[k];
      wheel.copyWithin(t * 4, k * 4, k * 4 + 4);
    }
    remap[k] = t;
  }
  const acc = (type, arr) => doc.createAccessor().setType(type).setArray(arr).setBuffer(buffer);
  const prim = doc
    .createPrimitive()
    .setAttribute('POSITION', acc('VEC3', pos.slice(0, u * 3)))
    .setAttribute('NORMAL', acc('VEC3', nrm.slice(0, u * 3)))
    .setAttribute('COLOR_0', acc('VEC3', col.slice(0, u * 3)))
    .setAttribute('_ROLE', acc('SCALAR', role.slice(0, u)))
    .setAttribute('_WHEEL', acc('VEC4', wheel.slice(0, u * 4)))
    .setIndices(acc('SCALAR', u < 65536 ? Uint16Array.from(remap) : remap));
  const mesh = doc.createMesh(spec.name).addPrimitive(prim);
  doc.getRoot().listScenes()[0].addChild(doc.createNode(spec.name).setMesh(mesh));
  const size = [(mx[0] - mn[0]) * sx, (mx[1] - mn[1]) * scale, (mx[2] - mn[2]) * scale];
  console.log(
    `[veh] ${spec.name}: ${n / 3} tris, ${size.map((s) => s.toFixed(2)).join(' x ')} m, ${wheels.length} wheels`,
  );
  return { name: spec.name, size, wheels, tris: n / 3 };
}

function buildVehicles() {
  const outDir = join(OUT, 'vehicles');
  mkdirSync(outDir, { recursive: true });
  const doc = new Document();
  const buffer = doc.createBuffer();
  doc.createScene('vehicles');
  const types = VEHICLES.map((s) => buildVehicle(doc, buffer, s));
  // Street prop: traffic light, 4.6 m tall, lamps facing +z.
  const light = buildVehicle(doc, buffer, {
    name: 'trafficLight',
    file: join(BUS_SRC, 'TrafficLight'),
    height: 4.6,
    front: '-x',
    mats: {
      TrafficLight: ['fixed', C.pole],
      Red: 'lampRed',
      Yellow: 'lampYellow',
      Green: 'lampGreen',
    },
  });
  return io.write(join(outDir, 'vehicles.glb'), doc).then(() => {
    writeFileSync(
      join(outDir, 'vehicles.json'),
      JSON.stringify({ roles: ROLE, types, props: { trafficLight: light } }),
    );
    console.log('[veh] wrote vehicles.glb, vehicles.json');
  });
}

// ---------------------------------------------------------------------------------------------

for (const p of [CHAR_SRC, CARS_SRC, BUS_SRC]) {
  if (!existsSync(p)) {
    console.error(
      `missing ${p}: unzip the Quaternius packs into assets-src/ (see docs/DECISIONS.md, M5)`,
    );
    process.exit(1);
  }
}
await MeshoptSimplifier.ready;
await buildCharacters();
await buildVehicles();
