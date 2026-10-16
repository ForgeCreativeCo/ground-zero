/**
 * Central typed event bus (DESIGN.md §14.2). Audio, FX, HUD and the response system
 * subscribe here instead of being called directly. Add new events to `GameEvents`.
 */
export interface GameEvents {
  'config:changed': { path: string };
  'city:reset': { seed: number };
  'physics:bodiesSpawned': { count: number };
  'input:device': { device: 'keyboard' | 'gamepad' };
  'player:state': { from: PlayerState; to: PlayerState };
  /** Crossed the sonic threshold. Later: windows shatter / people knocked down within radius. */
  'player:sonicBoom': { x: number; y: number; z: number; vx: number; vy: number; vz: number };
  /** Touched down. `hard` = crouched cratering landing; `dive` = ended a dive (dive slam). */
  'player:landing': {
    x: number;
    y: number;
    z: number;
    impactSpeed: number;
    hard: boolean;
    dive: boolean;
  };
  /** Slammed into a wall/building below sonic speed. Normal points away from the surface. */
  'player:impact': {
    x: number;
    y: number;
    z: number;
    nx: number;
    ny: number;
    nz: number;
    speed: number;
  };
  'player:unstuck': { x: number; y: number; z: number };
  'camera:shake': { trauma: number };
  /** Punch landed (target: 'piece' | 'debris' | 'none'). */
  'player:punch': {
    x: number;
    y: number;
    z: number;
    strength: number;
    target: string;
    uppercut: boolean;
  };
  'player:grab': { mass: number };
  'player:throw': { mass: number; speed: number };
  'player:slam': { x: number; y: number; z: number; radius: number; dive: boolean };
  /** A building piece changed damage state (not destroyed). */
  'piece:damaged': { id: number; x: number; y: number; z: number; state: number; material: number };
  'piece:destroyed': {
    id: number;
    x: number;
    y: number;
    z: number;
    material: number;
    mass: number;
  };
  'glass:shatter': { x: number; y: number; z: number; count: number };
  /** A story started failing: creaking now, collapse after `duration` seconds. */
  'building:stress': { building: number; x: number; y: number; z: number; duration: number };
  'building:collapse': { building: number; x: number; z: number; story: number };
  'cluster:spawn': { building: number; pieces: number; mass: number };
  'cluster:crush': { x: number; y: number; z: number; mass: number };
  /** Property damage bill total changed. */
  'damage:bill': { total: number };
  /** Heat vision filled its overheat meter (forced cooldown). */
  'power:overheat': Record<string, never>;
  /** Energy ball thrown, and where it burst (radius m, charge 0..1). */
  'power:energyThrow': { charge: number };
  'power:energyBlast': { x: number; y: number; z: number; radius: number; charge: number };
  /** Heat vision burned through a piece (`cut` = sliced by a sweep rather than melted). */
  'heat:burnThrough': { x: number; y: number; z: number; cut: boolean };
  /** Sonic fly-through (DESIGN.md §7.7): entering a building, leaving it, crashing to a stop inside. */
  'player:tunnelEnter': { building: number; x: number; y: number; z: number; speed: number };
  'player:tunnelExit': {
    building: number;
    x: number;
    y: number;
    z: number;
    vx: number;
    vy: number;
    vz: number;
  };
  'player:tunnelCrash': { building: number; x: number; y: number; z: number };
}

export type PlayerState = 'grounded' | 'airborne' | 'flying';

type Handler<T> = (payload: T) => void;

export class EventBus<E extends object> {
  private handlers = new Map<keyof E, Set<Handler<never>>>();

  on<K extends keyof E>(type: K, handler: Handler<E[K]>): () => void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add(handler as Handler<never>);
    return () => this.off(type, handler);
  }

  once<K extends keyof E>(type: K, handler: Handler<E[K]>): () => void {
    const off = this.on(type, (p) => {
      off();
      handler(p);
    });
    return off;
  }

  off<K extends keyof E>(type: K, handler: Handler<E[K]>) {
    this.handlers.get(type)?.delete(handler as Handler<never>);
  }

  emit<K extends keyof E>(type: K, payload: E[K]) {
    const set = this.handlers.get(type);
    if (!set) return;
    for (const h of set) (h as Handler<E[K]>)(payload);
  }

  clear() {
    this.handlers.clear();
  }
}

export const events = new EventBus<GameEvents>();
