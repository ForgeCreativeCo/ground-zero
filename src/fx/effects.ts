import * as THREE from 'three/webgpu';
import { config } from '../config';
import { events } from '../core/events';
import { Craters } from './craters';
import { Dust } from './dust';
import { Shockwaves } from './shockwaves';
import { SpeedLines } from './speedLines';
import { VaporCone } from './vaporCone';

const _pos = new THREE.Vector3();
const _n = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

/** Wires gameplay events to visual effects. Systems emit events; this is the only listener. */
export class Effects {
  readonly dust: Dust;
  /** Big, slow, long-lived cloud for collapses. */
  readonly collapseDust: Dust;
  readonly craters: Craters;
  readonly shockwaves: Shockwaves;
  readonly vapor: VaporCone;
  readonly speedLines: SpeedLines;

  constructor(scene: THREE.Scene, camera: THREE.Camera) {
    this.dust = new Dust(scene);
    const cd = config.fx.collapseDust;
    this.collapseDust = new Dust(scene, {
      capacity: () => cd.capacity,
      color: () => config.fx.collapseDust.color,
      lifetime: () => config.fx.collapseDust.lifetime,
      drag: () => config.fx.collapseDust.drag,
      opacity: cd.opacity,
    });
    this.craters = new Craters(scene);
    this.shockwaves = new Shockwaves(scene);
    this.vapor = new VaporCone(scene);
    this.speedLines = new SpeedLines(camera);

    events.on('player:sonicBoom', (e) => {
      const s = config.fx.sonicBoom;
      _pos.set(e.x, e.y, e.z);
      _n.set(e.vx, e.vy, e.vz);
      // A collar that forms around him (rides along briefly), and a wider ring left in the air.
      this.shockwaves.spawn(
        _pos,
        _n,
        s.collarRadius,
        s.collarTime,
        s.collarStrength,
        _n,
        s.collarFollow,
      );
      this.shockwaves.spawn(_pos, _n, s.ringRadius, s.ringTime, 0.9);
      this.vapor.boom();
      // Close to the ground the pressure wave kicks up a dust ring below him.
      if (e.y < s.groundDustAltitude) {
        const k = 1 - e.y / s.groundDustAltitude;
        _pos.set(e.x, 0.1, e.z);
        this.shockwaves.spawn(_pos, _up, s.ringRadius * 0.6, s.ringTime * 1.2, 0.6 * k);
        this.dust.ring(e.x, 0, e.z, 6, Math.round(80 * k), 22 * k + 6);
      }
    });

    events.on('player:landing', (e) => {
      if (!e.hard) return;
      const l = config.fx.landing;
      const over = Math.max(0, e.impactSpeed - config.player.hardLandingSpeed);
      const k = e.dive ? 1.5 : 1;
      const radius = Math.min(l.craterMax, (l.craterBase + over * l.craterPerSpeed) * k);
      this.craters.add(e.x, e.y, e.z, radius);
      _pos.set(e.x, e.y + 0.15, e.z);
      this.shockwaves.spawn(
        _pos,
        _up,
        e.impactSpeed * l.shockwaveRadiusPerSpeed * k,
        l.shockwaveTime,
        0.8,
      );
      const n = Math.min(l.dustMax, Math.round(e.impactSpeed * l.dustPerSpeed * k));
      this.dust.ring(e.x, e.y, e.z, radius, n, 4 + e.impactSpeed * 0.18);
    });

    events.on('player:impact', (e) => {
      // Wall slam: a puff of dust off the surface (facade cracks/holes come with M2).
      for (let i = 0; i < 18; i++) {
        this.dust.spawn(
          e.x,
          e.y,
          e.z,
          e.nx * 6 + (i % 5) - 2,
          e.ny * 6 + (i % 3),
          e.nz * 6 + (i % 7) - 3,
          1.2,
          2,
        );
      }
    });
  }

  /** `center` = hero body centre, `vel` = hero velocity. */
  update(center: THREE.Vector3, vel: THREE.Vector3, camera: THREE.Camera, dt: number) {
    this.vapor.update(center, vel, dt);
    this.speedLines.update(vel.length(), dt);
    this.shockwaves.update(dt);
    this.dust.update(dt, camera);
    this.collapseDust.update(dt, camera);
  }

  /**
   * Makes every effect mesh drawable (or restores it) so the renderer can compile their shaders
   * at startup instead of hitching the first time a boom or landing happens.
   */
  setPrewarm(on: boolean) {
    this.vapor.mesh.visible = on;
    this.speedLines.mesh.visible = on;
    this.shockwaves.setAllVisible(on);
    this.dust.mesh.count = on ? 1 : this.dust.count;
    this.collapseDust.mesh.count = on ? 1 : this.collapseDust.count;
    this.craters.mesh.count = on ? Math.max(1, this.craters.count) : this.craters.count;
  }

  get particleCount() {
    return this.dust.count + this.collapseDust.count;
  }

  get decalCount() {
    return this.craters.count;
  }
}
