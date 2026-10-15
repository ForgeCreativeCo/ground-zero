import * as THREE from 'three/webgpu';
import {
  abs,
  color,
  float,
  fract,
  fwidth,
  max,
  min,
  mix,
  positionWorld,
  select,
  smoothstep,
  texture,
  uniform,
  vec2,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import type RAPIER from '@dimforge/rapier3d-compat';
import { config } from '../config';
import type { Physics } from '../physics/physics';
import type { CityLayout } from './cityLayout';

/** Anti-aliased grid line mask (1 on lines) for coordinates already divided by spacing. */
function gridLines(p: Node<'vec2'>, width: number) {
  const g = abs(fract(p.sub(0.5)).sub(0.5)).div(fwidth(p).max(1e-4));
  const d = min(g.x, g.y);
  return float(1).sub(min(d.div(width), float(1)));
}

/**
 * Ground plane: asphalt streets and sidewalk-lined blocks inside the city, open ground outside,
 * with a faint 10 m / 100 m grid so speed and scale read clearly. Scale pillars are an M0 helper.
 */
export class Ground {
  readonly group = new THREE.Group();
  private uColor = uniform(color(config.world.groundColor));
  private uSpacing = uniform(config.world.gridSpacing);
  private uStrength = uniform(config.world.gridStrength);
  private material: THREE.MeshStandardNodeMaterial;
  private pillars = new THREE.Group();
  /** Pillar bodies, disabled with the pillars so hidden pillars never act as invisible walls. */
  private pillarBodies: RAPIER.RigidBody[] = [];
  /** Crater holes: the ground is cut out where this mask is set and a bowl mesh fills the hole. */
  private craterMask: THREE.DataTexture;
  private maskData: Uint8Array;
  private maskSize = 1024;
  private maskHalf: number;
  private bowlMat: THREE.MeshStandardNodeMaterial;
  private bowls = new THREE.Group();
  craterCount = 0;

  constructor(scene: THREE.Scene, physics: Physics, layout: CityLayout) {
    const size = config.world.groundSize;
    const geo = new THREE.PlaneGeometry(size, size);
    geo.rotateX(-Math.PI / 2);
    this.material = new THREE.MeshStandardNodeMaterial({ roughness: config.world.groundRoughness });
    const p = positionWorld.xz.div(this.uSpacing);
    const fine = gridLines(p, 1.0);
    const coarse = gridLines(p.div(10), 1.5);
    const lines = max(fine.mul(0.5), coarse);
    // Fade grid with distance so it doesn't moire at the horizon.
    const fade = float(1).sub(smoothstep(300, 1500, positionWorld.xz.length()));
    // Streets: block centres sit at (k - (n-1)/2) * pitch, so shift into a [0,1) cell per block.
    const c = config.city;
    const pitch = layout.pitch;
    const fx = fract(positionWorld.x.div(pitch).add((c.blocksX - 1) / 2 + 0.5))
      .sub(0.5)
      .abs();
    const fz = fract(positionWorld.z.div(pitch).add((c.blocksZ - 1) / 2 + 0.5))
      .sub(0.5)
      .abs();
    const halfBlock = c.blockSize / 2 / pitch;
    const inBlock = fx.lessThan(halfBlock).and(fz.lessThan(halfBlock));
    const inCity = abs(positionWorld.x)
      .lessThan(layout.halfExtentX)
      .and(abs(positionWorld.z).lessThan(layout.halfExtentZ));
    const base = select(
      inCity,
      select(inBlock, color(c.sidewalkColor), color(c.asphaltColor)),
      this.uColor,
    );
    this.material.colorNode = mix(base, base.mul(0.55), lines.mul(this.uStrength).mul(fade));

    // Crater mask (covers the city plus a margin): discard ground fragments inside craters.
    this.maskHalf = Math.max(layout.halfExtentX, layout.halfExtentZ) + 150;
    this.maskData = new Uint8Array(this.maskSize * this.maskSize);
    this.craterMask = new THREE.DataTexture(
      this.maskData,
      this.maskSize,
      this.maskSize,
      THREE.RedFormat,
    );
    this.craterMask.magFilter = THREE.LinearFilter;
    this.craterMask.needsUpdate = true;
    const muv = positionWorld.xz.add(vec2(this.maskHalf, this.maskHalf)).div(this.maskHalf * 2);
    const hole = texture(this.craterMask, muv).r;
    this.material.maskNode = hole.lessThan(0.5);
    this.bowlMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.97 });
    // Scorched, broken dirt and asphalt: darker towards the bottom of the bowl.
    this.bowlMat.colorNode = mix(
      color(0x2c2925),
      color(0x4a4640),
      smoothstep(-1.5, 0.2, positionWorld.y),
    );
    this.group.add(this.bowls);
    const ground = new THREE.Mesh(geo, this.material);
    ground.receiveShadow = true;
    ground.name = 'ground';
    this.group.add(ground);
    // Thick slabs so fast bodies can't tunnel through, tiled because Rapier's character
    // controller loses precision against a single multi-kilometre cuboid (he sank through it).
    const tile = 500;
    const tiles = Math.ceil(size / tile);
    for (let i = 0; i < tiles; i++) {
      for (let j = 0; j < tiles; j++) {
        const x = -size / 2 + tile * (i + 0.5);
        const z = -size / 2 + tile * (j + 0.5);
        physics.addStaticCuboid(x, -5, z, tile / 2, 5, tile / 2);
      }
    }

    this.buildPillars(physics);
    this.group.add(this.pillars);
    scene.add(this.group);
  }

  private buildPillars(physics: Physics) {
    const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.85, metalness: 0 });
    // Dark band every 10 m of height so altitude is readable from the air.
    const band = smoothstep(0.92, 0.95, fract(positionWorld.y.div(10)));
    mat.colorNode = mix(color(0xc9c4ba), color(0x8a2a1e), band);
    const heights = config.world.scalePillarHeights;
    const radius = 2;
    heights.forEach((h, i) => {
      const geo = new THREE.CylinderGeometry(radius, radius, h, 32, 1);
      const mesh = new THREE.Mesh(geo, mat);
      const angle = (i / heights.length) * Math.PI * 2;
      const x = Math.sin(angle) * 60;
      const z = -Math.cos(angle) * 60 - 40;
      mesh.position.set(x, h / 2, z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.pillars.add(mesh);
      this.pillarBodies.push(physics.addStaticCylinder(x, h / 2, z, h / 2, radius));
    });
  }

  /**
   * Punches a crater into the ground (DESIGN.md §6.4): a hole in the ground plane and a bowl mesh
   * with a raised, broken rim. Visual only; the physics ground stays flat (logged decision).
   */
  addCrater(x: number, z: number, radius: number, depth: number) {
    // Mask: hole slightly smaller than the rim so the rim always covers the edge.
    const n = this.maskSize;
    const texel = (this.maskHalf * 2) / n;
    const r = radius * 0.92;
    const ci = (x + this.maskHalf) / texel;
    const cj = (z + this.maskHalf) / texel;
    const rr = r / texel;
    for (let j = Math.max(0, Math.floor(cj - rr)); j <= Math.min(n - 1, Math.ceil(cj + rr)); j++) {
      for (
        let i = Math.max(0, Math.floor(ci - rr));
        i <= Math.min(n - 1, Math.ceil(ci + rr));
        i++
      ) {
        if ((i + 0.5 - ci) ** 2 + (j + 0.5 - cj) ** 2 <= rr * rr) this.maskData[j * n + i] = 255;
      }
    }
    this.craterMask.needsUpdate = true;
    // Bowl: a lathe profile from the centre (deepest) out past the hole to a raised rim.
    const pts: THREE.Vector2[] = [];
    const steps = 14;
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      const rad = radius * 1.2 * t;
      const y =
        t < 0.8
          ? -depth * Math.cos((t / 0.8) * (Math.PI / 2))
          : 0.25 * Math.sin(((t - 0.8) / 0.2) * Math.PI);
      pts.push(new THREE.Vector2(Math.max(0.001, rad), t < 0.8 ? y + 0.02 * (1 - t) : y + 0.03));
    }
    const geo = new THREE.LatheGeometry(pts, 40);
    // Lathe winds so its normals face outward/down for a bowl; flip to face up.
    geo.scale(1, 1, -1);
    geo.computeVertexNormals();
    const bowl = new THREE.Mesh(geo, this.bowlMat);
    bowl.position.set(x, 0.01, z);
    bowl.rotation.y = (x * 7.13 + z * 3.7) % (Math.PI * 2);
    bowl.receiveShadow = true;
    this.bowls.add(bowl);
    this.craterCount++;
  }

  update() {
    const w = config.world;
    this.uColor.value.set(w.groundColor);
    this.uSpacing.value = w.gridSpacing;
    this.uStrength.value = w.gridStrength;
    this.material.roughness = w.groundRoughness;
    if (this.pillars.visible !== w.showScalePillars) {
      this.pillars.visible = w.showScalePillars;
      for (const b of this.pillarBodies) b.setEnabled(w.showScalePillars);
    }
  }
}
