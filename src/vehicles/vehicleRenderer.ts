import * as THREE from 'three/webgpu';
import type { VehicleAssets } from './vehicleAssets';
import { createVehicleMaterial, VEHICLE_ATTRS, VEHICLE_FLOATS } from './vehicleMaterial';

interface Batch {
  mesh: THREE.Mesh;
  geo: THREE.InstancedBufferGeometry;
  buf: THREE.InstancedInterleavedBuffer;
  data: Float32Array;
  capacity: number;
  count: number;
}

/** A crumpled vehicle: its own mesh with a deformable copy of the type's vertices. */
export interface WreckMesh {
  batch: Batch;
  type: number;
  positions: Float32Array;
  /** Untouched copy, for computing dents. */
  rest: Float32Array;
  inUse: boolean;
}

/**
 * Vehicle rendering: one instanced draw per type for intact vehicles, one for the traffic
 * lights, and a fixed pool of wreck meshes for crumpled ones (each a 1-instance batch with its
 * own vertex copy). All share one material, so no new shader code is built mid-play.
 */
export class VehicleRenderer {
  readonly group = new THREE.Group();
  private types: Batch[] = [];
  readonly lights: Batch;
  readonly wrecks: WreckMesh[] = [];
  private material: THREE.Material;

  constructor(
    scene: THREE.Scene,
    readonly assets: VehicleAssets,
    capacityPerType: number,
    lightCount: number,
    wreckMeshes: number,
  ) {
    this.material = createVehicleMaterial(assets.roles);
    assets.geo.forEach((g, t) =>
      this.types.push(this.batch(g, capacityPerType, `veh-${assets.types[t]!.name}`, true)),
    );
    this.lights = this.batch(
      assets.trafficLight.geo,
      Math.max(1, lightCount),
      'traffic-lights',
      false,
    );
    // Wreck pool: geometry cloned per type on demand (same attribute layout = same shader).
    for (let i = 0; i < wreckMeshes; i++) {
      const b = this.batch(assets.geo[0]!, 1, `wreck-${i}`, true, true);
      b.mesh.visible = false;
      this.wrecks.push({
        batch: b,
        type: -1,
        positions: new Float32Array(0),
        rest: new Float32Array(0),
        inUse: false,
      });
    }
    this.group.name = 'vehicles';
    scene.add(this.group);
  }

  private batch(
    src: THREE.BufferGeometry,
    capacity: number,
    name: string,
    shadows: boolean,
    own = false,
  ): Batch {
    const geo = new THREE.InstancedBufferGeometry();
    for (const n of ['position', 'normal', 'color', '_role', '_wheel']) {
      const a = src.getAttribute(n) as THREE.BufferAttribute;
      geo.setAttribute(n, own ? a.clone() : a);
    }
    geo.setIndex(src.getIndex());
    const data = new Float32Array(Math.max(1, capacity) * VEHICLE_FLOATS);
    const buf = new THREE.InstancedInterleavedBuffer(data, VEHICLE_FLOATS);
    buf.setUsage(THREE.DynamicDrawUsage);
    VEHICLE_ATTRS.forEach((n, i) =>
      geo.setAttribute(n, new THREE.InterleavedBufferAttribute(buf, 4, i * 4)),
    );
    geo.instanceCount = 1;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.name = name;
    mesh.frustumCulled = false;
    mesh.castShadow = shadows;
    mesh.receiveShadow = true;
    this.group.add(mesh);
    return { mesh, geo, buf, data, capacity: Math.max(1, capacity), count: 0 };
  }

  begin() {
    for (const b of this.types) b.count = 0;
    this.lights.count = 0;
  }

  /** Adds an intact vehicle of a type; src holds VEHICLE_FLOATS floats at offset. */
  push(type: number, src: Float32Array, offset: number) {
    const b = this.types[type]!;
    if (b.count >= b.capacity) return;
    write(b, src, offset);
  }

  pushLight(src: Float32Array, offset: number) {
    if (this.lights.count < this.lights.capacity) write(this.lights, src, offset);
  }

  end() {
    for (const b of [...this.types, this.lights]) flush(b);
  }

  /** Takes a wreck mesh for a vehicle of `type` (null if the pool is used up). */
  acquireWreck(type: number): WreckMesh | null {
    const w = this.wrecks.find((x) => !x.inUse);
    if (!w) return null;
    w.inUse = true;
    if (w.type !== type) {
      const src = this.assets.geo[type]!;
      const geo = w.batch.geo;
      for (const n of ['position', 'normal', 'color', '_role', '_wheel']) {
        const a = (src.getAttribute(n) as THREE.BufferAttribute).clone();
        geo.setAttribute(n, a);
      }
      geo.setIndex(src.getIndex());
      w.type = type;
      w.positions = (geo.getAttribute('position') as THREE.BufferAttribute).array as Float32Array;
      w.rest = Float32Array.from(w.positions);
    } else {
      w.positions.set(w.rest);
      (w.batch.geo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    }
    w.batch.mesh.visible = true;
    return w;
  }

  /** Writes a wreck's instance data (its transform and look) for this frame. */
  drawWreck(w: WreckMesh, src: Float32Array, offset: number) {
    w.batch.count = 0;
    write(w.batch, src, offset);
    flush(w.batch);
  }

  /** Marks a wreck's dented vertices for upload. */
  dentsChanged(w: WreckMesh) {
    const pos = w.batch.geo.getAttribute('position') as THREE.BufferAttribute;
    pos.needsUpdate = true;
    w.batch.geo.computeVertexNormals();
  }

  get meshes() {
    return [
      ...this.types.map((b) => b.mesh),
      this.lights.mesh,
      ...this.wrecks.map((w) => w.batch.mesh),
    ];
  }
}

function write(b: Batch, src: Float32Array, offset: number) {
  const o = b.count * VEHICLE_FLOATS;
  for (let i = 0; i < VEHICLE_FLOATS; i++) b.data[o + i] = src[offset + i]!;
  b.count++;
}

/** Uploads; an empty batch keeps one collapsed instance so its shader stays built. */
function flush(b: Batch) {
  if (b.count === 0) {
    b.data.fill(0, 0, VEHICLE_FLOATS);
    b.data[7] = 1;
    b.data[0] = 0;
    b.data[1] = -1000;
    b.data[2] = 0;
  }
  const n = Math.max(1, b.count);
  b.geo.instanceCount = n;
  b.buf.clearUpdateRanges();
  b.buf.addUpdateRange(0, n * VEHICLE_FLOATS);
  b.buf.needsUpdate = true;
}
