import type * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

export interface VehicleTypeInfo {
  name: string;
  /** Width (x), height (y), length (z) in metres; front faces +z, ground at y = 0. */
  size: [number, number, number];
  wheels: { x: number; y: number; z: number; r: number }[];
  tris: number;
}

/** vehicles.json, written by scripts/build-assets.mjs. */
interface VehicleMeta {
  roles: Record<string, number>;
  types: VehicleTypeInfo[];
  props: { trafficLight: VehicleTypeInfo };
}

export interface VehicleAssets {
  types: VehicleTypeInfo[];
  geo: THREE.BufferGeometry[];
  roles: Record<string, number>;
  trafficLight: { info: VehicleTypeInfo; geo: THREE.BufferGeometry };
}

/** Loads the processed vehicle meshes (one per type) and the traffic light. */
export async function loadVehicleAssets(): Promise<VehicleAssets> {
  const base = `${import.meta.env.BASE_URL}assets/vehicles/`;
  const [meta, gltf] = await Promise.all([
    fetch(`${base}vehicles.json`).then((r) => r.json() as Promise<VehicleMeta>),
    new GLTFLoader().loadAsync(`${base}vehicles.glb`),
  ]);
  const meshes = new Map<string, THREE.BufferGeometry>();
  gltf.scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) meshes.set(m.name, m.geometry);
  });
  const get = (n: string) => {
    const g = meshes.get(n);
    if (!g) throw new Error(`vehicles.glb: missing ${n}`);
    return g;
  };
  return {
    types: meta.types,
    geo: meta.types.map((t) => get(t.name)),
    roles: meta.roles,
    trafficLight: { info: meta.props.trafficLight, geo: get('trafficLight') },
  };
}
