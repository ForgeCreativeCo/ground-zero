import { Rng } from '../core/rng';
import { UNIT, type UnitType } from './units';

/** Prop looks (each one instanced mesh). */
export type PropVisual = 'wood' | 'fabric' | 'metal' | 'drywall' | 'plant' | 'light' | 'screen';

export interface Prop {
  visual: PropVisual;
  x: number;
  y: number;
  z: number;
  hx: number;
  hy: number;
  hz: number;
  yaw: number;
  /** Colour tint (r, g, b multipliers). */
  r: number;
  g: number;
  b: number;
  /** Hit points and how much it burns (0 = not flammable). */
  hp: number;
  fuel: number;
}

/** A unit's floor-plan box: x0..x1, z0..z1 at floor height y0 with ceiling y1. */
export interface UnitBox {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  y0: number;
  y1: number;
}

const HP: Record<PropVisual, number> = {
  wood: 25,
  fabric: 15,
  metal: 45,
  drywall: 20,
  plant: 5,
  light: 4,
  screen: 6,
};
const FUEL: Record<PropVisual, number> = {
  wood: 1,
  fabric: 1.2,
  metal: 0,
  drywall: 0.4,
  plant: 0.6,
  light: 0,
  screen: 0.2,
};

/**
 * Furnishes one unit (DESIGN.md §7.5): offices get desks, cubicle walls, chairs, monitors,
 * filing cabinets, ceiling light panels, water coolers, plants and meeting tables; apartments a
 * couch, TV, bed, kitchen counter, fridge, dining table, shelves and rugs; shops shelving,
 * counters and displays; parking decks cars. Deterministic from the unit's seed. Pure.
 */
export function furnish(type: UnitType, box: UnitBox, seed: number): Prop[] {
  const rng = new Rng(Math.floor(seed * 0xffffffff) ^ 0x5eed);
  const out: Prop[] = [];
  const W = box.x1 - box.x0;
  const D = box.z1 - box.z0;
  const H = box.y1 - box.y0;
  const y0 = box.y0;
  // Local helper: place an axis-aligned box by its base centre (bx, bz on the floor at height by).
  const put = (
    visual: PropVisual,
    bx: number,
    by: number,
    bz: number,
    w: number,
    h: number,
    d: number,
    yaw = 0,
    tint: [number, number, number] = [1, 1, 1],
  ) => {
    out.push({
      visual,
      x: bx,
      y: y0 + by + h / 2,
      z: bz,
      hx: w / 2,
      hy: h / 2,
      hz: d / 2,
      yaw,
      r: tint[0],
      g: tint[1],
      b: tint[2],
      hp: HP[visual],
      fuel: FUEL[visual],
    });
  };
  const margin = 0.6;
  const inX = (t: number) => box.x0 + margin + t * (W - 2 * margin);
  const inZ = (t: number) => box.z0 + margin + t * (D - 2 * margin);
  const wood = (): [number, number, number] => {
    const k = rng.range(0.75, 1.15);
    return [k, k * 0.92, k * 0.82];
  };

  // Ceiling lights in a grid (every unit type but parking gets panels; parking gets strips).
  const lightsX = Math.max(1, Math.round(W / 3.5));
  const lightsZ = Math.max(1, Math.round(D / 3.5));
  for (let a = 0; a < lightsX; a++)
    for (let c = 0; c < lightsZ; c++)
      put(
        'light',
        box.x0 + ((a + 0.5) * W) / lightsX,
        H - 0.05,
        box.z0 + ((c + 0.5) * D) / lightsZ,
        1.2,
        0.04,
        0.6,
      );

  if (type === UNIT.office) {
    // Rows of desks with cubicle partitions, monitors and chairs.
    const cols = Math.max(1, Math.floor((W - 2 * margin) / 2.4));
    const rows = Math.max(1, Math.floor((D - 2 * margin) / 2.6));
    for (let a = 0; a < cols; a++) {
      for (let c = 0; c < rows; c++) {
        if (rng.next() < 0.12) continue; // the odd empty spot
        const x = box.x0 + margin + (a + 0.5) * ((W - 2 * margin) / cols);
        const z = box.z0 + margin + (c + 0.5) * ((D - 2 * margin) / rows);
        const tint = wood();
        put('wood', x, 0.72, z, 1.5, 0.04, 0.75, 0, tint); // desktop
        put('wood', x - 0.71, 0, z, 0.04, 0.72, 0.7, 0, tint); // side panels
        put('wood', x + 0.71, 0, z, 0.04, 0.72, 0.7, 0, tint);
        put('drywall', x, 0, z - 0.42, 1.6, 1.25, 0.05, 0, [0.85, 0.9, 0.95]); // partition
        put('screen', x + rng.range(-0.3, 0.3), 0.76, z - 0.18, 0.55, 0.36, 0.04);
        const chairYaw = rng.range(-0.6, 0.6);
        put(
          'fabric',
          x + rng.range(-0.2, 0.2),
          0.42,
          z + 0.55,
          0.5,
          0.08,
          0.5,
          chairYaw,
          [0.4, 0.42, 0.48],
        );
        put('fabric', x, 0.5, z + 0.78, 0.48, 0.55, 0.06, chairYaw, [0.4, 0.42, 0.48]);
      }
    }
    // Filing cabinets along one wall, a water cooler, plants, maybe a meeting table.
    for (let k = 0; k < rng.int(1, 3); k++)
      put('metal', inX(rng.next()), 0, box.z0 + 0.4, 0.5, 1.3, 0.6, 0, [0.75, 0.77, 0.8]);
    put('metal', box.x1 - 0.5, 0, inZ(rng.next()), 0.32, 1.1, 0.32, 0, [0.9, 0.93, 1]);
    for (let k = 0; k < 2; k++) put('plant', inX(rng.next()), 0, inZ(rng.next()), 0.6, 1.2, 0.6);
    if (rng.next() < 0.35) put('wood', inX(0.5), 0.72, inZ(0.5), 2.6, 0.05, 1.2, 0, wood());
  } else if (type === UNIT.apartment) {
    // Living area: couch facing a TV, a rug.
    const cx = inX(rng.range(0.2, 0.45));
    const cz = inZ(rng.range(0.55, 0.8));
    const fab: [number, number, number] = [
      rng.range(0.4, 1.1),
      rng.range(0.35, 0.9),
      rng.range(0.35, 0.9),
    ];
    put('fabric', cx, 0, cz, 2.1, 0.45, 0.9, 0, fab);
    put('fabric', cx, 0.45, cz + 0.36, 2.1, 0.45, 0.2, 0, fab);
    put('fabric', cx - 1.0, 0.45, cz, 0.2, 0.25, 0.9, 0, fab);
    put('fabric', cx + 1.0, 0.45, cz, 0.2, 0.25, 0.9, 0, fab);
    put('fabric', cx, 0, cz - 1.4, 2.6, 0.02, 1.8, 0, [
      rng.range(0.4, 1),
      rng.range(0.3, 0.8),
      rng.range(0.3, 0.7),
    ]);
    put('wood', cx, 0, cz - 2.8, 1.5, 0.5, 0.4, 0, wood());
    put('screen', cx, 0.5, cz - 2.8, 1.25, 0.72, 0.05);
    // Bedroom corner: bed with headboard.
    const bx = inX(rng.range(0.7, 0.85));
    const bz = inZ(rng.range(0.15, 0.3));
    put('wood', bx, 0, bz, 1.7, 0.35, 2.1, 0, wood());
    put('fabric', bx, 0.35, bz + 0.05, 1.6, 0.22, 1.95, 0, [0.95, 0.95, 0.92]);
    put('wood', bx, 0, bz - 1.05, 1.7, 1.0, 0.1, 0, wood());
    // Kitchen: counter run and fridge along a wall; dining table and chairs.
    const kz = box.z1 - 0.45;
    put('wood', inX(0.45), 0, kz, 2.6, 0.9, 0.6, 0, [0.95, 0.95, 0.95]);
    put('metal', inX(0.45) + 1.75, 0, kz - 0.05, 0.8, 1.85, 0.7, 0, [0.92, 0.93, 0.95]);
    const tx = inX(rng.range(0.55, 0.7));
    const tz = inZ(rng.range(0.45, 0.6));
    const t = wood();
    put('wood', tx, 0.72, tz, 1.4, 0.05, 0.9, 0, t);
    for (const [dx, dz] of [
      [-0.45, -0.65],
      [0.45, -0.65],
      [-0.45, 0.65],
      [0.45, 0.65],
    ] as const) {
      put('wood', tx + dx, 0.44, tz + dz, 0.45, 0.06, 0.45, 0, t);
    }
    put('wood', box.x0 + 0.3, 0, inZ(rng.next()), 0.35, 1.8, 1.0, 0, wood()); // shelves
    if (rng.next() < 0.6) put('plant', inX(rng.next()), 0, inZ(rng.next()), 0.5, 1.0, 0.5);
  } else if (type === UNIT.retail) {
    const rows = Math.max(1, Math.floor((D - 3) / 2.6));
    for (let c = 0; c < rows; c++) {
      const z = box.z0 + 2 + c * 2.6;
      put('metal', inX(0.5), 0, z, Math.max(1.5, W - 4), 1.7, 0.6, 0, [0.85, 0.85, 0.88]);
    }
    put('wood', box.x0 + 2, 0, box.z1 - 1.2, 2.5, 1.0, 0.7, 0, wood()); // counter
    put('screen', box.x0 + 2, 1.0, box.z1 - 1.2, 0.4, 0.3, 0.3);
    for (let k = 0; k < 2; k++)
      put('wood', inX(rng.next()), 0, inZ(rng.next()), 1.4, 0.8, 1.0, 0, wood());
  } else {
    // Parking: a few parked cars (simple body + cabin until the vehicle models of M5).
    const n = rng.int(1, Math.max(1, Math.floor(W / 2.8)));
    for (let k = 0; k < n; k++) {
      const x = box.x0 + 1.6 + k * 2.8;
      const z = inZ(rng.range(0.2, 0.8));
      const c: [number, number, number] = [rng.range(0.2, 1), rng.range(0.2, 1), rng.range(0.2, 1)];
      put('metal', x, 0.2, z, 1.85, 0.75, 4.4, 0, c);
      put('metal', x, 0.95, z + 0.2, 1.7, 0.55, 2.2, 0, c);
    }
  }
  return out;
}
