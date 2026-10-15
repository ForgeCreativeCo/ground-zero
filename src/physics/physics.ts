import RAPIER from '@dimforge/rapier3d-compat';
import { config } from '../config';

export type Rapier = typeof RAPIER;

/** Rapier world wrapper. Steps at the fixed sim rate; owns static colliders for the world. */
export class Physics {
  readonly world: RAPIER.World;
  readonly R: Rapier = RAPIER;
  private events = new RAPIER.EventQueue(true);
  /** Called for every contact-force event after a step (debris impacts). */
  onContactForce: ((h1: number, h2: number, force: number) => void) | null = null;

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
      this.onContactForce?.(e.collider1(), e.collider2(), e.totalForceMagnitude());
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
