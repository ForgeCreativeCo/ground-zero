import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { bakeAnimations, type AnimBake } from './animBake';
import type { SkeletonDef } from './poses';

/** characters.json, written by scripts/build-assets.mjs. */
interface CharacterMeta {
  atlas: { width: number; height: number; rects: number[][] };
  lods: number[];
  bodies: Record<
    'male' | 'female',
    SkeletonDef & { height: number; hair: string[]; tris: number[] }
  >;
}

export const BODIES = ['male', 'female'] as const;
export type BodyName = (typeof BODIES)[number];

export interface CharacterAssets {
  meta: CharacterMeta;
  skeletons: SkeletonDef[];
  /** [body][lod] */
  bodyGeo: THREE.BufferGeometry[][];
  /** [body][style][lod] */
  hairGeo: THREE.BufferGeometry[][][];
  hairStyles: string[][];
  colorTex: THREE.Texture;
  normalTex: THREE.Texture;
  bake: AnimBake;
  bakeTex: THREE.DataTexture;
}

const base = () => `${import.meta.env.BASE_URL}assets/characters/`;

/** Loads the processed character meshes and atlases, and bakes every animation clip. */
export async function loadCharacterAssets(): Promise<CharacterAssets> {
  const [meta, gltf, colorTex, normalTex] = await Promise.all([
    fetch(`${base()}characters.json`).then((r) => r.json() as Promise<CharacterMeta>),
    new GLTFLoader().loadAsync(`${base()}characters.glb`),
    new THREE.TextureLoader().loadAsync(`${base()}atlas_color.webp`),
    new THREE.TextureLoader().loadAsync(`${base()}atlas_normal.webp`),
  ]);
  for (const t of [colorTex, normalTex]) {
    // glTF UV convention: v = 0 is the top row of the image.
    t.flipY = false;
    t.anisotropy = 4;
    t.needsUpdate = true;
  }
  colorTex.colorSpace = THREE.SRGBColorSpace;
  normalTex.colorSpace = THREE.NoColorSpace;

  const meshes = new Map<string, THREE.BufferGeometry>();
  gltf.scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) meshes.set(m.name, m.geometry);
  });
  const get = (name: string) => {
    const g = meshes.get(name);
    if (!g) throw new Error(`characters.glb: missing mesh ${name}`);
    return g;
  };
  const lods = meta.lods.length;
  const skeletons: SkeletonDef[] = [];
  const bodyGeo: THREE.BufferGeometry[][] = [];
  const hairGeo: THREE.BufferGeometry[][][] = [];
  const hairStyles: string[][] = [];
  for (const body of BODIES) {
    const b = meta.bodies[body];
    skeletons.push({ joints: b.joints, parents: b.parents, bind: b.bind });
    const lodList: THREE.BufferGeometry[] = [];
    for (let k = 0; k < lods; k++) lodList.push(get(`${body}_body_${k}`));
    bodyGeo.push(lodList);
    hairStyles.push(b.hair);
    hairGeo.push(
      b.hair.map((style) => {
        const list: THREE.BufferGeometry[] = [];
        for (let k = 0; k < lods; k++) list.push(get(`${body}_${style}_${k}`));
        return list;
      }),
    );
  }

  const bake = bakeAnimations(skeletons);
  // Half floats are filterable everywhere (WebGPU and WebGL2), so frames interpolate in hardware.
  const half = new Uint16Array(bake.data.length);
  for (let i = 0; i < half.length; i++) half[i] = THREE.DataUtils.toHalfFloat(bake.data[i]!);
  const bakeTex = new THREE.DataTexture(
    half,
    bake.width,
    bake.height,
    THREE.RGBAFormat,
    THREE.HalfFloatType,
  );
  bakeTex.minFilter = THREE.LinearFilter;
  bakeTex.magFilter = THREE.LinearFilter;
  bakeTex.generateMipmaps = false;
  bakeTex.needsUpdate = true;

  return {
    meta,
    skeletons,
    bodyGeo,
    hairGeo,
    hairStyles,
    colorTex,
    normalTex,
    bake,
    bakeTex,
  };
}
