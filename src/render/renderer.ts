import * as THREE from 'three/webgpu';
import { pass } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { config } from '../config';
import type { ToneMappingName } from '../config/render';

const TONE_MAPPINGS: Record<ToneMappingName, THREE.ToneMapping> = {
  AgX: THREE.AgXToneMapping,
  ACES: THREE.ACESFilmicToneMapping,
  Neutral: THREE.NeutralToneMapping,
};

/** WebGPU renderer (WebGL2 fallback) + TSL post chain: scene pass -> bloom -> tone map. */
export class GameRenderer {
  readonly renderer: THREE.WebGPURenderer;
  readonly camera: THREE.PerspectiveCamera;
  private pipeline!: THREE.RenderPipeline;
  private bloomNode: ReturnType<typeof bloom> | null = null;
  private lastW = 0;
  private lastH = 0;
  private lastPixelRatio = 0;

  constructor(
    readonly canvasParent: HTMLElement,
    readonly scene: THREE.Scene,
  ) {
    const c = config.render;
    this.renderer = new THREE.WebGPURenderer({ antialias: false, forceWebGL: c.forceWebGL });
    this.renderer.shadowMap.enabled = c.shadows.enabled;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.camera = new THREE.PerspectiveCamera(c.camera.fovDeg, 1, c.camera.near, c.camera.far);
    canvasParent.appendChild(this.renderer.domElement);
    this.renderer.domElement.tabIndex = 0;
    this.renderer.domElement.id = 'game-canvas';
  }

  get canvas() {
    return this.renderer.domElement;
  }

  get backendName(): 'WebGPU' | 'WebGL2' {
    const backend = this.renderer.backend as { isWebGPUBackend?: boolean };
    return backend.isWebGPUBackend ? 'WebGPU' : 'WebGL2';
  }

  async init() {
    await this.renderer.init();
    const c = config.render;
    this.pipeline = new THREE.RenderPipeline(this.renderer);
    const scenePass = pass(this.scene, this.camera, { samples: c.msaaSamples });
    const color = scenePass.getTextureNode('output');
    if (c.bloom.enabled) {
      this.bloomNode = bloom(color, c.bloom.strength, c.bloom.radius, c.bloom.threshold);
      this.pipeline.outputNode = color.add(this.bloomNode);
    } else {
      this.pipeline.outputNode = color;
    }
    this.syncSize();
  }

  /** Applies live config (tone mapping, bloom, FOV, resolution). Cheap; call every frame. */
  update() {
    const c = config.render;
    const tm = TONE_MAPPINGS[c.toneMapping] ?? THREE.AgXToneMapping;
    if (this.renderer.toneMapping !== tm) this.renderer.toneMapping = tm;
    this.renderer.toneMappingExposure = c.exposure;
    if (this.bloomNode) {
      this.bloomNode.strength.value = c.bloom.strength;
      this.bloomNode.radius.value = c.bloom.radius;
      this.bloomNode.threshold.value = c.bloom.threshold;
    }
    const cam = this.camera;
    if (cam.near !== c.camera.near || cam.far !== c.camera.far) {
      cam.near = c.camera.near;
      cam.far = c.camera.far;
      cam.updateProjectionMatrix();
    }
    this.syncSize();
  }

  setFov(fovDeg: number) {
    if (Math.abs(this.camera.fov - fovDeg) > 1e-4) {
      this.camera.fov = fovDeg;
      this.camera.updateProjectionMatrix();
    }
  }

  private syncSize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const pr =
      Math.min(window.devicePixelRatio, config.render.maxPixelRatio) *
      config.render.resolutionScale;
    if (w === this.lastW && h === this.lastH && pr === this.lastPixelRatio) return;
    this.lastW = w;
    this.lastH = h;
    this.lastPixelRatio = pr;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, true);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  render() {
    this.pipeline.render();
  }

  setAnimationLoop(fn: ((time: number) => void) | null) {
    return this.renderer.setAnimationLoop(fn);
  }
}
