/**
 * Piece data for the whole city, structure-of-arrays (DESIGN.md §7.1). A city holds tens of
 * thousands of pieces, so everything is typed arrays indexed by piece id. Pure data, no three.js.
 */

export const KIND = { column: 0, slab: 1, panel: 2, roof: 3 } as const;
export type Kind = (typeof KIND)[keyof typeof KIND];

/** Damage states (DESIGN.md §7.2). */
export const STATE = {
  intact: 0,
  cracked: 1,
  crackedHeavy: 2,
  breached: 3,
  destroyed: 4,
} as const;
export type PieceState = (typeof STATE)[keyof typeof STATE];

/** Material ids, in the order of config.materials. */
export const MATERIAL_NAMES = [
  'reinforcedConcrete',
  'concretePanel',
  'brick',
  'glass',
  'steel',
  'roofEquipment',
] as const;
export type MaterialId = number;
export const MAT = Object.fromEntries(MATERIAL_NAMES.map((n, i) => [n, i])) as Record<
  (typeof MATERIAL_NAMES)[number],
  number
>;

/** Flag bits. */
export const FLAG = {
  /** Visible / has a collider (exterior pieces start revealed; interior when exposed). */
  revealed: 1,
  /** Concrete/brick panel whose windows have been blown out. */
  windowsBroken: 2,
  /** Part of a falling cluster (no longer part of the static building). */
  inCluster: 4,
  /** Parking-structure parapet (open facade). */
  parapet: 8,
} as const;

export class PieceStore {
  readonly count: number;
  readonly kind: Uint8Array;
  readonly mat: Uint8Array;
  readonly state: Uint8Array;
  readonly flags: Uint8Array;
  readonly building: Uint32Array;
  readonly cx: Float32Array;
  readonly cy: Float32Array;
  readonly cz: Float32Array;
  readonly hx: Float32Array;
  readonly hy: Float32Array;
  readonly hz: Float32Array;
  readonly hp: Float32Array;
  readonly maxHp: Float32Array;
  readonly mass: Float32Array;
  /** °C above ambient (heat vision, M4) and frozen timer (freeze breath, M4). */
  readonly temperature: Float32Array;
  readonly frozen: Float32Array;

  constructor(count: number) {
    this.count = count;
    this.kind = new Uint8Array(count);
    this.mat = new Uint8Array(count);
    this.state = new Uint8Array(count);
    this.flags = new Uint8Array(count);
    this.building = new Uint32Array(count);
    this.cx = new Float32Array(count);
    this.cy = new Float32Array(count);
    this.cz = new Float32Array(count);
    this.hx = new Float32Array(count);
    this.hy = new Float32Array(count);
    this.hz = new Float32Array(count);
    this.hp = new Float32Array(count);
    this.maxHp = new Float32Array(count);
    this.mass = new Float32Array(count);
    this.temperature = new Float32Array(count);
    this.frozen = new Float32Array(count);
  }

  /** Alive and still part of its building. */
  isStatic(id: number) {
    return this.state[id] !== STATE.destroyed && (this.flags[id]! & FLAG.inCluster) === 0;
  }

  volume(id: number) {
    return 8 * this.hx[id]! * this.hy[id]! * this.hz[id]!;
  }

  /** Squared distance from a point to the piece's box (0 inside). */
  distSq(id: number, x: number, y: number, z: number) {
    const dx = Math.max(0, Math.abs(x - this.cx[id]!) - this.hx[id]!);
    const dy = Math.max(0, Math.abs(y - this.cy[id]!) - this.hy[id]!);
    const dz = Math.max(0, Math.abs(z - this.cz[id]!) - this.hz[id]!);
    return dx * dx + dy * dy + dz * dz;
  }
}

/** HP fraction → visual/behavioural state (breach only applies to panels). */
export function stateForHp(
  frac: number,
  kind: number,
  t: { crackedAt: number; crackedHeavyAt: number; breachedAt: number },
): PieceState {
  if (frac <= 0) return STATE.destroyed;
  if (kind === KIND.panel && frac <= t.breachedAt) return STATE.breached;
  if (frac <= t.crackedHeavyAt) return STATE.crackedHeavy;
  if (frac <= t.crackedAt) return STATE.cracked;
  return STATE.intact;
}
