/** Pure binding resolution: raw input ids -> action state. No DOM, unit-tested. */

/** Xbox "standard" Gamepad API button order. */
export const PAD_BUTTONS = [
  'A',
  'B',
  'X',
  'Y',
  'LB',
  'RB',
  'LT',
  'RT',
  'View',
  'Menu',
  'LS',
  'RS',
  'DUp',
  'DDown',
  'DLeft',
  'DRight',
] as const;

const chordCache = new Map<string, string[]>();

/** "Pad:LB+Pad:RB" -> ["Pad:LB", "Pad:RB"]. Cached, so steady-state use doesn't allocate. */
export function parseChord(binding: string): string[] {
  let parts = chordCache.get(binding);
  if (!parts) {
    parts = binding
      .split('+')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    chordCache.set(binding, parts);
  }
  return parts;
}

/** Analog-aware lookup: returns 0..1 for a raw input id. */
export type RawValue = (id: string) => number;

/** Value of one action: the max over its alternative bindings; a chord's value is its weakest input. */
export function resolveAction(alternatives: readonly string[], raw: RawValue): number {
  let best = 0;
  for (const alt of alternatives) {
    const chord = parseChord(alt);
    if (chord.length === 0) continue;
    let v = 1;
    for (const id of chord) {
      v = Math.min(v, raw(id));
      if (v === 0) break;
    }
    if (v > best) best = v;
  }
  return best;
}

/** Radial deadzone with rescale so output still spans 0..1. Writes into `out`. */
export function applyDeadzone(
  x: number,
  y: number,
  deadzone: number,
  out: { x: number; y: number },
) {
  const len = Math.hypot(x, y);
  if (len <= deadzone || len === 0) {
    out.x = 0;
    out.y = 0;
    return out;
  }
  const scaled = Math.min(1, (len - deadzone) / (1 - deadzone));
  out.x = (x / len) * scaled;
  out.y = (y / len) * scaled;
  return out;
}

/** Edge + double-tap tracking for one action. Latches persist until a fixed step consumes them. */
export class ActionState {
  value = 0;
  down = false;
  /** Rising edge this render frame. */
  pressed = false;
  released = false;
  doubleTapped = false;
  /** Latched edges for fixed-step code (cleared by consumeLatches). */
  pressedLatch = false;
  releasedLatch = false;
  doubleTapLatch = false;
  private lastPressMs = -Infinity;

  update(value: number, nowMs: number, doubleTapMs: number, threshold = 0.5) {
    const wasDown = this.down;
    this.value = value;
    this.down = value >= threshold;
    this.pressed = this.down && !wasDown;
    this.released = !this.down && wasDown;
    this.doubleTapped = false;
    if (this.pressed) {
      this.doubleTapped = nowMs - this.lastPressMs <= doubleTapMs;
      // A double-tap consumes the tap, so a triple-tap isn't two double-taps.
      this.lastPressMs = this.doubleTapped ? -Infinity : nowMs;
      this.pressedLatch = true;
      if (this.doubleTapped) this.doubleTapLatch = true;
    }
    if (this.released) this.releasedLatch = true;
  }

  consumeLatches() {
    this.pressedLatch = false;
    this.releasedLatch = false;
    this.doubleTapLatch = false;
  }

  reset() {
    this.value = 0;
    this.down = this.pressed = this.released = this.doubleTapped = false;
    this.consumeLatches();
    this.lastPressMs = -Infinity;
  }
}
