import * as THREE from 'three/webgpu';
import { SkyMesh } from 'three/addons/objects/SkyMesh.js';
import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js';
import { config } from '../config';

const _dir = new THREE.Vector3();
/** Objects on this layer are rendered only by shadow cameras. */
export const SHADOW_ONLY_LAYER = 1;

/** Physical sky, sun with cascaded shadows, hemisphere fill, sky-based IBL and fog. */
export class Environment {
  readonly sky = new SkyMesh();
  readonly sun = new THREE.DirectionalLight();
  readonly hemi = new THREE.HemisphereLight();
  readonly sunDirection = new THREE.Vector3();
  /** Point the sun shadow is centred on (the camera). */
  readonly focus = new THREE.Vector3();
  private csm: CSMShadowNode | null = null;
  private envSky = new SkyMesh();
  private envScene = new THREE.Scene();
  private skies = [this.sky, this.envSky];
  private pmrem: THREE.PMREMGenerator;
  private envTarget: THREE.RenderTarget | null = null;
  private envDirty = true;
  private envTimer = 0;
  /** Sky inputs at the last env-map build (no per-frame string keys). */
  private lastSkyKey = new Float64Array(6).fill(NaN);
  private fog = new THREE.FogExp2(0xffffff, 0);

  constructor(
    private readonly scene: THREE.Scene,
    renderer: THREE.WebGPURenderer,
  ) {
    const s = config.render.shadows;
    this.sky.scale.setScalar(10000);
    this.sky.frustumCulled = false;
    scene.add(this.sky);

    this.sun.castShadow = s.enabled;
    this.sun.shadow.mapSize.set(s.mapSize, s.mapSize);
    this.sun.shadow.bias = s.bias;
    this.sun.shadow.normalBias = s.normalBias;
    const cam = this.sun.shadow.camera;
    // Layer 1 = shadow-only casters (merged building boxes): drawn into shadow maps, never seen.
    cam.layers.enable(SHADOW_ONLY_LAYER);
    cam.near = 1;
    cam.far = config.sun.distance + s.lightMargin + s.maxFar;
    cam.left = cam.bottom = -s.extent;
    cam.right = cam.top = s.extent;
    cam.updateProjectionMatrix();
    scene.add(this.sun, this.sun.target);
    if (s.enabled && s.cascaded) {
      this.csm = new CSMShadowNode(this.sun, {
        cascades: s.cascades,
        maxFar: s.maxFar,
        mode: 'practical',
        lightMargin: s.lightMargin,
      });
      this.csm.fade = s.fade;
      this.sun.shadow.shadowNode = this.csm;
    }
    scene.add(this.hemi);

    this.envSky.scale.setScalar(100);
    this.envScene.add(this.envSky);
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.update(0);
  }

  update(dt: number) {
    const { sun, sky } = config;
    const phi = THREE.MathUtils.degToRad(90 - sun.elevationDeg);
    const theta = THREE.MathUtils.degToRad(sun.azimuthDeg);
    this.sunDirection.setFromSphericalCoords(1, phi, theta);

    for (const m of this.skies) {
      m.sunPosition.value.copy(this.sunDirection);
      m.turbidity.value = sky.turbidity;
      m.rayleigh.value = sky.rayleigh;
      m.mieCoefficient.value = sky.mieCoefficient;
      m.mieDirectionalG.value = sky.mieDirectionalG;
    }
    this.sky.cloudCoverage.value = sky.cloudCoverage;
    this.sky.cloudDensity.value = sky.cloudDensity;
    this.envSky.cloudCoverage.value = 0;

    // Sun fades out as it reaches the horizon.
    const horizonFade = THREE.MathUtils.smoothstep(sun.elevationDeg, -2, 6);
    // Below the horizon the same light becomes a dim, cool moon high on the other side.
    if (horizonFade > 0.001) {
      this.sun.intensity = sun.intensity * horizonFade;
      this.sun.color.set(sun.color);
      _dir.copy(this.sunDirection).multiplyScalar(sun.distance);
    } else {
      const m = config.moon;
      this.sun.intensity = m.intensity * THREE.MathUtils.smoothstep(-sun.elevationDeg, 0, 8);
      this.sun.color.set(m.color);
      _dir
        .setFromSphericalCoords(
          1,
          THREE.MathUtils.degToRad(90 - m.elevationDeg),
          THREE.MathUtils.degToRad(sun.azimuthDeg + 180),
        )
        .multiplyScalar(sun.distance);
    }
    // The sun (and its single shadow map) follows the focus point, snapped to whole metres
    // so the shadow map does not shimmer as the camera moves.
    this.sun.target.position.set(Math.round(this.focus.x), 0, Math.round(this.focus.z));
    this.sun.position.copy(this.sun.target.position).add(_dir);
    this.sun.shadow.bias = config.render.shadows.bias;
    this.sun.shadow.normalBias = config.render.shadows.normalBias;
    if (this.csm) {
      for (const l of this.csm.lights) {
        if (!l.shadow) continue;
        l.shadow.bias = config.render.shadows.bias;
        l.shadow.normalBias = config.render.shadows.normalBias;
      }
    }

    // Night: ambient light, fog and image lighting fall away as the sun goes down.
    const day = THREE.MathUtils.smoothstep(sun.elevationDeg, -10, 8);
    const ambientK = config.moon.ambient + (1 - config.moon.ambient) * day;
    this.hemi.intensity = sky.hemiIntensity * ambientK;
    this.hemi.color.set(sky.hemiSkyColor);
    this.hemi.groundColor.set(sky.hemiGroundColor);

    if (sky.fogEnabled) {
      this.fog.color.set(sky.fogColor).multiplyScalar(0.06 + 0.94 * day);
      this.fog.density = sky.fogDensity;
      this.scene.fog = this.fog;
    } else {
      this.scene.fog = null;
    }

    this.scene.environmentIntensity = sky.envIntensity * ambientK;
    const k = this.lastSkyKey;
    if (
      k[0] !== sun.elevationDeg ||
      k[1] !== sun.azimuthDeg ||
      k[2] !== sky.turbidity ||
      k[3] !== sky.rayleigh ||
      k[4] !== sky.mieCoefficient ||
      k[5] !== sky.mieDirectionalG
    ) {
      k[0] = sun.elevationDeg;
      k[1] = sun.azimuthDeg;
      k[2] = sky.turbidity;
      k[3] = sky.rayleigh;
      k[4] = sky.mieCoefficient;
      k[5] = sky.mieDirectionalG;
      this.envDirty = true;
    }
    this.envTimer -= dt;
    if (this.envDirty && this.envTimer <= 0) this.regenerateEnvironment();
  }

  private regenerateEnvironment() {
    this.envDirty = false;
    this.envTimer = config.sky.envRefreshInterval;
    const target = this.pmrem.fromScene(this.envScene, 0, 0.1, 1000);
    this.envTarget?.dispose();
    this.envTarget = target;
    this.scene.environment = target.texture;
  }
}
