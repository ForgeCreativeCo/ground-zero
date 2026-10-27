import RAPIER from '@dimforge/rapier3d-compat';
import { config } from '../config';

export type Rapier = typeof RAPIER;

/**
 * Collision groups (membership << 16 | filter). Vehicles sit in their own group so the hero's
 * character controller, ground probes and camera ignore them (he smashes or shoves cars by
 * script instead of being stopped by them); debris and everything else still hit them.
 */
export const VEHICLE_GROUPS = (0x0002 << 16) | 0xffff;
/** Query groups for the hero and camera: everything except vehicles. */
export const PLAYER_QUERY_GROUPS = (0x0001 << 16) | 0xfffd;

/** Rapier world wrapper. Steps at the fixed sim rate; owns static colliders for the world. */
export class Physics {
  readonly world: RAPIER.World;
  readonly R: Rapier = RAPIER;
  private events = new RAPIER.EventQueue(true);
  /** Called for every contact-force event after a step (debris impacts). */
  onContactForce: ((h1: number, h2: number, force: number) => void) | null = null;
  /** More contact-force listeners (vehicles). */
  readonly contactListeners: ((h1: number, h2: number, force: number) => void)[] = [];

  private constructor(stepDt: number) {
    this.world = new RAPIER.World({ x: 0, y: config.world.gravity, z: 0 });
    this.world.timestep = stepDt;
  }

  static async create(stepDt: number): Promise<Physics> {
    await RAPIER.init();
    return new Physics(stepDt);
  }

  step() {
    const g = this.world.gravity;
    if (g.y !== config.world.gravity) this.world.gravity = { x: 0, y: config.world.gravity, z: 0 };
    this.world.step(this.events);
    this.events.drainContactForceEvents((e) => {
      const h1 = e.collider1();
      const h2 = e.collider2();
      const f = e.totalForceMagnitude();
      this.onContactForce?.(h1, h2, f);
      for (const l of this.contactListeners) l(h1, h2, f);
    });
  }

  addStaticCuboid(x: number, y: number, z: number, hx: number, hy: number, hz: number) {
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, y, z));
    this.world.createCollider(RAPIER.ColliderDesc.cuboid(hx, hy, hz), body);
    return body;
  }

  addStaticCylinder(x: number, y: number, z: number, halfHeight: number, radius: number) {
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, y, z));
    this.world.createCollider(RAPIER.ColliderDesc.cylinder(halfHeight, radius), body);
    return body;
  }

  /** Dynamic bodies that are awake (counts toward budgets.activeRigidBodies). */
  countActiveDynamic(): number {
    let n = 0;
    this.world.bodies.forEach((b) => {
      if (b.isDynamic() && !b.isSleeping()) n++;
    });
    return n;
  }

  countDynamic(): number {
    let n = 0;
    this.world.bodies.forEach((b) => {
      if (b.isDynamic()) n++;
    });
    return n;
  }
}
