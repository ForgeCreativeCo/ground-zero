import * as THREE from 'three/webgpu';
import {
  abs,
  float,
  length,
  mix,
  mx_noise_float,
  normalView,
  smoothstep,
  time,
  uniform,
  uv,
  vec2,
  vec3,
} from 'three/tsl';
import { config } from '../config';

const _up = new THREE.Vector3(0, 1, 0);
const _d = new THREE.Vector3();
const _q = new THREE.Quaternion();

/**
 * Heat-vision beams (DESIGN.md §6.2): twin beams from the eyes to the impact, a white-hot core
 * with orange edges (HDR, so it blooms), a rippling heat glow along it and a flaring hot spot at
 * the impact. All meshes exist from the start and are shown only while firing, so nothing compiles
 * mid-play. True screen-space heat shimmer waits for the M10 post pass (see docs/DECISIONS.md).
 */
export class HeatBeams {
  private cores: THREE.Mesh[] = [];
  private glows: THREE.Mesh[] = [];
  private all: THREE.Mesh[] = [];
  private flare: THREE.Mesh;
  private uBright = uniform(config.heatVision.brightness);
  private flicker = 0;

  constructor(scene: THREE.Scene) {
    const geo = new THREE.CylinderGeometry(1, 1, 1, 12, 1, true);
    geo.translate(0, 0.5, 0);
    // Cylinders seen side-on: the middle faces the camera, the edges are grazing.
    const facing = abs(normalView.z);
    const coreMat = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    coreMat.colorNode = mix(vec3(1, 0.42, 0.08), vec3(1, 0.96, 0.88), smoothstep(0.35, 0.9, facing))
      .mul(this.uBright)
      .mul(0.5);
    coreMat.opacityNode = facing.pow(1.5);
    const glowMat = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    // Rippling heat along the beam.
    const ripple = mx_noise_float(vec2(uv().y.mul(40).sub(time.mul(30)), uv().x.mul(6)))
      .mul(0.35)
      .add(0.65);
    glowMat.colorNode = vec3(1, 0.32, 0.06).mul(this.uBright).mul(0.16).mul(ripple);
    glowMat.opacityNode = facing.pow(2).mul(0.75);
    for (let i = 0; i < 2; i++) {
      const c = new THREE.Mesh(geo, coreMat);
      const g = new THREE.Mesh(geo, glowMat);
      for (const m of [c, g]) {
        m.visible = false;
        m.frustumCulled = false;
        m.renderOrder = 12;
        scene.add(m);
      }
      this.cores.push(c);
      this.glows.push(g);
      this.all.push(c, g);
    }

    // Impact flare: a camera-facing radial hot spot.
    const flareMat = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    const r = length(uv().sub(0.5)).mul(2);
    const spot = float(1)
      .sub(smoothstep(0, 1, r))
      .pow(2.2);
    flareMat.colorNode = mix(vec3(1, 0.35, 0.05), vec3(1, 0.95, 0.85), spot)
      .mul(this.uBright)
      .mul(0.35);
    flareMat.opacityNode = spot;
    this.flare = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), flareMat);
    this.flare.visible = false;
    this.flare.frustumCulled = false;
    this.flare.renderOrder = 13;
    scene.add(this.flare);
  }

  /**
   * Shows the beams from the two eyes to `hit` (or hides them when `on` is false). `k` is 0..1
   * (ramping on/off), `heat` scales the flare for hotter targets.
   */
  update(
    on: boolean,
    eyeL: THREE.Vector3,
    eyeR: THREE.Vector3,
    hit: THREE.Vector3,
    camera: THREE.Camera,
    k: number,
    dt: number,
  ) {
    const h = config.heatVision;
    this.uBright.value = h.brightness;
    const show = on && k > 0.01;
    for (const m of this.all) m.visible = show;
    this.flare.visible = show;
    if (!show) return;
    this.flicker += dt;
    const fl = 0.85 + 0.1 * Math.sin(this.flicker * 53) + 0.05 * Math.sin(this.flicker * 131);
    for (let i = 0; i < 2; i++) {
      const eye = i === 0 ? eyeL : eyeR;
      _d.copy(hit).sub(eye);
      const len = _d.length();
      if (len < 1e-3) continue;
      _q.setFromUnitVectors(_up, _d.divideScalar(len));
      for (const [m, r] of [
        [this.cores[i]!, h.coreRadius],
        [this.glows[i]!, h.glowRadius],
      ] as const) {
        m.position.copy(eye);
        m.quaternion.copy(_q);
        m.scale.set(r * k * fl, len, r * k * fl);
      }
    }
    const size = (0.9 + 0.4 * fl) * k;
    this.flare.position.copy(hit);
    this.flare.quaternion.copy(camera.quaternion);
    this.flare.scale.setScalar(size);
  }
}
