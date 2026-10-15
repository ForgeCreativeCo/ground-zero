import * as THREE from 'three/webgpu';

/** Layer used only while warming up: the player's camera never renders it. */
export const WARM_LAYER = 2;

const _zero = new THREE.Matrix4().makeScale(0, 0, 0);

interface Saved {
  mesh: THREE.Mesh;
  count: number;
  mask: number;
  visible: boolean;
  culled: boolean;
  parent: THREE.Object3D | null;
}

/**
 * Background shader warm-up. three.js generates shader code per instanced mesh (its cache key
 * includes the mesh's uuid), so warming has to use the real meshes: each unused one gets a
 * single invisible instance and moves to a layer only the warm-up camera sees, is compiled
 * asynchronously (WebGPU's async pipeline creation runs off the main thread), then is put back.
 * Plain meshes share code by structure, so for them a clone with the same material and geometry
 * is enough. The game plays normally meanwhile; nothing stalls the first time it shows up later.
 */
export class ShaderWarmup {
  private saved: Saved[] = [];
  private clones = new THREE.Group();

  constructor(
    private readonly scene: THREE.Scene,
    /** Meshes that aren't in the scene right now (e.g. pooled) but will be later. */
    extra: THREE.Object3D[],
  ) {
    const holder = new THREE.Group();
    holder.name = 'warm-holder';
    const seenPlain = new Set<string>();
    const visit = (o: THREE.Object3D) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !mesh.geometry || !mesh.material) return;
      const inst = (o as THREE.InstancedMesh).isInstancedMesh === true;
      if (inst) {
        const im = o as THREE.InstancedMesh;
        if (im.count > 0 && im.visible) return; // already drawing, so already built
        this.saved.push({
          mesh: im,
          count: im.count,
          mask: im.layers.mask,
          visible: im.visible,
          culled: im.frustumCulled,
          parent: im.parent,
        });
        return;
      }
      if (mesh.visible && mesh.layers.mask & 1) return;
      const material = mesh.material as THREE.Material;
      const key = `${material.uuid}|${Object.keys(mesh.geometry.attributes).sort().join(',')}|${mesh.castShadow}`;
      if (seenPlain.has(key)) return;
      seenPlain.add(key);
      const clone = new THREE.Mesh(mesh.geometry, material);
      clone.scale.setScalar(0);
      clone.layers.set(WARM_LAYER);
      clone.frustumCulled = false;
      clone.castShadow = mesh.castShadow;
      clone.receiveShadow = mesh.receiveShadow;
      this.clones.add(clone);
    };
    scene.traverse(visit);
    for (const e of extra) e.traverse(visit);
    for (const s of this.saved) {
      const im = s.mesh as THREE.InstancedMesh;
      if (!im.parent) holder.add(im);
      im.setMatrixAt(0, _zero);
      im.instanceMatrix.needsUpdate = true;
      im.count = 1;
      im.visible = true;
      im.frustumCulled = false;
      im.layers.set(WARM_LAYER);
    }
    this.clones.add(holder);
  }

  get size() {
    return this.saved.length + this.clones.children.length - 1;
  }

  /** Compiles everything; `compile` builds pipelines for objects the camera can see. */
  async run(
    camera: THREE.Camera,
    compile: (root: THREE.Object3D, camera: THREE.Camera) => Promise<void>,
  ) {
    // The camera must also see layer 0, or the scene's lights are left out of the compiled
    // pipelines and they wouldn't match the real ones.
    const cam = camera.clone();
    cam.layers.set(0);
    cam.layers.enable(WARM_LAYER);
    this.scene.add(this.clones);
    try {
      await compile(this.scene, cam);
    } finally {
      this.scene.remove(this.clones);
      for (const s of this.saved) {
        const im = s.mesh as THREE.InstancedMesh;
        im.layers.mask = s.mask;
        im.visible = s.visible;
        im.frustumCulled = s.culled;
        // Only undo our placeholder instance; if the game started using the mesh meanwhile,
        // its own count stands.
        if (im.count === 1 && s.count === 0) im.count = 0;
        if (s.parent !== im.parent) {
          im.removeFromParent();
          if (s.parent) s.parent.add(im);
        }
      }
    }
  }
}
