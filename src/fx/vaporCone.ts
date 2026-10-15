import * as THREE from 'three/webgpu';
import { abs, color, float, normalView, positionLocal, smoothstep, uniform } from 'three/tsl';
import { config } from '../config';

const _y = new THREE.Vector3(0, 1, 0);
const _d = new THREE.Vector3();

/**
 * Vapor cone (DESIGN.md §5.3): a translucent shock-collar around the hero that forms as he nears
 * the sonic threshold, flashes on crossing it and thins out above it.
 */
export class VaporCone {
  readonly mesh: THREE.Mesh;
  private opacity = uniform(0);
  private flash = 0;

  constructor(scene: THREE.Scene) {
    // Open cone, apex at +Y; the hero flies apex-first.
    const h = 3.2;
    const geo = new THREE.ConeGeometry(1.6, h, 48, 6, true);
    const mat = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    // Brighter at the silhouette, fading toward the apex and the trailing rim.
    const rim = float(1).sub(abs(normalView.z)).pow(1.5);
    const along = positionLocal.y.div(h).add(0.5); // 0 rim → 1 apex
    const band = smoothstep(0.0, 0.35, along).mul(float(1).sub(smoothstep(0.55, 0.95, along)));
    mat.colorNode = color(0xf4f8ff);
    mat.opacityNode = rim.mul(0.7).add(0.3).mul(band).mul(this.opacity);
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.visible = false;
    this.mesh.frustumCulled = false; // one small mesh; also lets the startup prewarm draw it
    this.mesh.renderOrder = 12;
    scene.add(this.mesh);
  }

  boom() {
    this.flash = config.fx.vaporCone.flashTime;
  }

  /** `center` = hero body centre; `vel` = velocity. */
  update(center: THREE.Vector3, vel: THREE.Vector3, dt: number) {
    const c = config.fx.vaporCone;
    const speed = vel.length();
    const thr = config.player.sonicThreshold;
    let k = 0;
    if (c.enabled && speed > thr * c.start) {
      k =
        speed < thr
          ? (speed - thr * c.start) / (thr * (1 - c.start))
          : Math.max(0, 1 - (speed - thr) / (thr * (c.end - 1)));
    }
    this.flash = Math.max(0, this.flash - dt);
    const f = c.flashTime > 0 ? this.flash / c.flashTime : 0;
    const o = Math.min(1, k * 0.8 + f) * c.maxOpacity;
    this.opacity.value = o;
    this.mesh.visible = o > 0.003;
    if (!this.mesh.visible) return;
    _d.copy(vel).normalize();
    this.mesh.quaternion.setFromUnitVectors(_y, _d);
    // Sit around the shoulders: apex just ahead of his head.
    this.mesh.position.copy(center).addScaledVector(_d, -0.2);
    const s = 1 + f * 0.6;
    this.mesh.scale.set(s, 1 + f * 0.3, s);
  }
}
