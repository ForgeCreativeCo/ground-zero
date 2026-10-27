import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { config } from '../config';
import { Rng } from '../core/rng';
import type { Spot } from '../npc/civilians';
import type { CityLayout } from './cityLayout';

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);
const _up = new THREE.Vector3(0, 1, 0);

/** Box at (x, y, z) with size (w, h, d), vertex-coloured. */
function box(w: number, h: number, d: number, x: number, y: number, z: number, rgb: number[]) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  const n = g.getAttribute('position').count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) c.set(rgb, i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return g;
}

/**
 * Street furniture (DESIGN.md §9.4 ambient life): benches along the kerbs and bus shelters, as
 * two instanced meshes made once at startup. Also returns the spots people sit and stand at:
 * bench seats, bus stops and shop fronts. Front of each prop faces +z (toward the street).
 */
export class StreetProps {
  readonly spots: Spot[] = [];
  readonly group = new THREE.Group();

  constructor(scene: THREE.Scene, layout: CityLayout, seed: number) {
    const rng = new Rng(seed ^ 0x5eed5);
    const wood = [0.32, 0.2, 0.1];
    const iron = [0.05, 0.05, 0.055];
    const bench = mergeGeometries([
      box(1.8, 0.06, 0.42, 0, 0.45, 0, wood),
      box(1.8, 0.4, 0.05, 0, 0.72, -0.2, wood),
      box(0.06, 0.45, 0.42, -0.8, 0.225, 0, iron),
      box(0.06, 0.45, 0.42, 0.8, 0.225, 0, iron),
    ])!;
    const frame = [0.12, 0.13, 0.14];
    const glass = [0.08, 0.11, 0.13];
    const shelter = mergeGeometries([
      box(3.6, 0.1, 1.6, 0, 2.55, 0, frame),
      box(3.6, 2.2, 0.04, 0, 1.3, -0.75, glass),
      box(0.08, 2.5, 0.08, -1.75, 1.25, -0.75, frame),
      box(0.08, 2.5, 0.08, 1.75, 1.25, -0.75, frame),
      box(0.08, 2.5, 0.08, -1.75, 1.25, 0.75, frame),
      box(0.08, 2.5, 0.08, 1.75, 1.25, 0.75, frame),
      box(3, 0.06, 0.4, 0, 0.45, -0.5, wood),
    ])!;
    const benches: THREE.Matrix4[] = [];
    const shelters: THREE.Matrix4[] = [];
    const half0 = config.city.blockSize / 2;
    for (const b of layout.blocks) {
      // Each side of the block: benches at the kerb facing the street, maybe a bus stop.
      for (let side = 0; side < 4; side++) {
        // Outward normal of this side and the axis along it.
        const nx = side === 1 ? 1 : side === 3 ? -1 : 0;
        const nz = side === 2 ? 1 : side === 0 ? -1 : 0;
        const yaw = Math.atan2(nx, nz);
        const place = (along: number, inset: number) => {
          const ax = nz !== 0 ? along : 0;
          const az = nx !== 0 ? along : 0;
          return [b.x + nx * (half0 - inset) + ax, b.z + nz * (half0 - inset) + az] as const;
        };
        if (rng.next() < 0.35) {
          const along = rng.range(-half0 * 0.5, half0 * 0.5);
          const [x, z] = place(along, 1);
          _m.compose(_p.set(x, 0, z), _q.setFromAxisAngle(_up, yaw), _s);
          shelters.push(_m.clone());
          for (const k of [-0.9, 0.2]) {
            // Seat inside the shelter (0.5 m back from its centre), people facing the street.
            const sx = x - nx * 0.5 + (nz !== 0 ? k : 0);
            const sz = z - nz * 0.5 + (nx !== 0 ? k : 0);
            this.spots.push({ x: sx, z: sz, yaw, sit: true });
          }
          this.spots.push({ x: x + nx * 1.2, z: z + nz * 1.2, yaw: yaw + Math.PI / 2, sit: false });
        }
        for (let k = 0; k < 2; k++) {
          if (rng.next() < 0.45) continue;
          const along = rng.range(-half0 * 0.8, half0 * 0.8);
          const [x, z] = place(along, 0.6);
          _m.compose(_p.set(x, 0, z), _q.setFromAxisAngle(_up, yaw), _s);
          benches.push(_m.clone());
          this.spots.push({ x: x - nx * 0.02, z: z - nz * 0.02, yaw, sit: true });
        }
        // Shop fronts: people standing by the buildings.
        for (let k = 0; k < 2; k++) {
          const along = rng.range(-half0 * 0.85, half0 * 0.85);
          const [x, z] = place(along, 3.4);
          this.spots.push({ x, z, yaw: yaw + rng.range(-1, 1), sit: false });
        }
      }
    }
    const mat = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.6 });
    for (const [geo, list] of [
      [bench, benches],
      [shelter, shelters],
    ] as const) {
      const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, list.length));
      list.forEach((m, i) => mesh.setMatrixAt(i, m));
      mesh.count = list.length;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      // Spread across the city: one draw, never culled (so its shader is built at startup).
      mesh.frustumCulled = false;
      this.group.add(mesh);
    }
    this.group.name = 'street-props';
    scene.add(this.group);
  }
}
