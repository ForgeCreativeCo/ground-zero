import * as THREE from 'three/webgpu';
import type { CharacterAssets } from './characterAssets';
import { createCrowdMaterials, FLOATS_PER_INSTANCE, INSTANCE_ATTRS } from './crowdMaterial';

/** One instanced batch: a body or hair mesh at one LOD. */
interface Batch {
  mesh: THREE.Mesh;
  geo: THREE.InstancedBufferGeometry;
  buf: THREE.InstancedInterleavedBuffer;
  data: Float32Array;
  capacity: number;
  count: number;
  tier: number;
}

/**
 * Crowd rendering (DESIGN.md §9.3): one draw per body (or hair style) per LOD tier, skinned on
 * the GPU from the baked animation texture. Meshes are created once up front (three.js builds
 * shader code per mesh) and refilled every frame with the visible characters of each tier.
 */
export class CrowdRenderer {
  readonly group = new THREE.Group();
  /** [body][lod] */
  private bodies: Batch[][] = [];
  /** [body][style][lod] */
  private hairs: Batch[][][] = [];
  private all: Batch[] = [];
  /** Characters drawn per tier last frame. */
  readonly tierCounts = [0, 0, 0];

  constructor(
    scene: THREE.Scene,
    readonly assets: CharacterAssets,
    /** Max characters per tier. */
    capacity: number[],
  ) {
    const mats = createCrowdMaterials(assets);
    assets.bodyGeo.forEach((lods, b) => {
      this.bodies.push(
        lods.map((g, k) => this.batch(g, mats.body, capacity[k]!, k, `crowd-body${b}-${k}`)),
      );
      this.hairs.push(
        assets.hairGeo[b]!.map((styleLods, s) =>
          styleLods.map((g, k) =>
            this.batch(g, mats.hair, capacity[k]!, k, `crowd-hair${b}.${s}-${k}`),
          ),
        ),
      );
    });
    this.group.name = 'crowd';
    scene.add(this.group);
  }

  private batch(
    src: THREE.BufferGeometry,
    mat: THREE.Material,
    capacity: number,
    tier: number,
    name: string,
  ): Batch {
    const geo = new THREE.InstancedBufferGeometry();
    for (const n of ['position', 'normal', 'uv', 'skinIndex', 'skinWeight', '_part'])
      geo.setAttribute(n, src.getAttribute(n));
    geo.setIndex(src.getIndex());
    const data = new Float32Array(Math.max(1, capacity) * FLOATS_PER_INSTANCE);
    const buf = new THREE.InstancedInterleavedBuffer(data, FLOATS_PER_INSTANCE);
    buf.setUsage(THREE.DynamicDrawUsage);
    INSTANCE_ATTRS.forEach((n, i) =>
      geo.setAttribute(n, new THREE.InterleavedBufferAttribute(buf, 4, i * 4)),
    );
    geo.instanceCount = 1;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = name;
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    this.group.add(mesh);
    const b: Batch = { mesh, geo, buf, data, capacity: Math.max(1, capacity), count: 0, tier };
    this.all.push(b);
    return b;
  }

  begin() {
    for (const b of this.all) b.count = 0;
    this.tierCounts[0] = this.tierCounts[1] = this.tierCounts[2] = 0;
  }

  /** Has the tier room for one more character of this body? */
  room(tier: number, body: number) {
    const b = this.bodies[body]![tier]!;
    return b.count < b.capacity;
  }

  /**
   * Adds a character. `src` holds FLOATS_PER_INSTANCE floats at `offset` (see crowdMaterial.ts);
   * hair styles are indices into the body's style list (-1 = none).
   */
  push(
    tier: number,
    body: number,
    hairA: number,
    hairB: number,
    src: Float32Array,
    offset: number,
  ) {
    const b = this.bodies[body]![tier]!;
    if (b.count >= b.capacity) return false;
    copy(b, src, offset);
    for (const h of [hairA, hairB]) {
      if (h < 0) continue;
      const hb = this.hairs[body]![h]?.[tier];
      if (hb && hb.count < hb.capacity) copy(hb, src, offset);
    }
    this.tierCounts[tier]!++;
    return true;
  }

  /** Uploads this frame's instances; empty batches keep one invisible instance (shaders stay built). */
  end(shadowTier: number) {
    for (const b of this.all) {
      if (b.count === 0) {
        b.data.fill(0, 0, FLOATS_PER_INSTANCE);
        b.data[7] = 1; // identity quaternion; scale 0 collapses it
      }
      const n = Math.max(1, b.count);
      b.geo.instanceCount = n;
      b.buf.clearUpdateRanges();
      b.buf.addUpdateRange(0, n * FLOATS_PER_INSTANCE);
      b.buf.needsUpdate = true;
      b.mesh.castShadow = b.tier <= shadowTier;
    }
  }

  get meshes() {
    return this.all.map((b) => b.mesh);
  }
}

function copy(b: Batch, src: Float32Array, offset: number) {
  const o = b.count * FLOATS_PER_INSTANCE;
  for (let i = 0; i < FLOATS_PER_INSTANCE; i++) b.data[o + i] = src[offset + i]!;
  b.count++;
}
