import { describe, expect, it } from 'vitest';
import { ActionState, applyDeadzone, parseChord, resolveAction } from '../../src/core/bindings';
import { bindings } from '../../src/config/controls';

const rawOf = (held: Record<string, number>) => (id: string) => held[id] ?? 0;

describe('binding resolution', () => {
  it('parses chords', () => {
    expect(parseChord('Pad:LB+Pad:RB')).toEqual(['Pad:LB', 'Pad:RB']);
    expect(parseChord('KeyR')).toEqual(['KeyR']);
  });

  it('any alternative triggers an action', () => {
    expect(resolveAction(bindings.descend, rawOf({ KeyC: 1 }))).toBe(1);
    expect(resolveAction(bindings.descend, rawOf({ ControlLeft: 1 }))).toBe(1);
    expect(resolveAction(bindings.descend, rawOf({}))).toBe(0);
  });

  it('chords need every input held', () => {
    expect(resolveAction(bindings.nova, rawOf({ 'Pad:LB': 1 }))).toBe(0);
    expect(resolveAction(bindings.nova, rawOf({ 'Pad:LB': 1, 'Pad:RB': 1 }))).toBe(1);
    expect(resolveAction(bindings.nova, rawOf({ KeyR: 1 }))).toBe(1);
  });

  it('keeps analog trigger values', () => {
    expect(resolveAction(bindings.heatVision, rawOf({ 'Pad:RT': 0.6 }))).toBeCloseTo(0.6);
  });

  it('every spec action from DESIGN.md §4 has a binding', () => {
    for (const a of [
      'moveForward',
      'jump',
      'descend',
      'boost',
      'punch',
      'heatVision',
      'freezeBreath',
      'grab',
      'slam',
      'nova',
      'slowMotion',
      'photoMode',
      'spawnMenu',
      'debugPanel',
    ] as const) {
      expect(bindings[a].length).toBeGreaterThan(0);
    }
  });
});

describe('ActionState', () => {
  it('reports edges and latches them until consumed', () => {
    const s = new ActionState();
    s.update(1, 0, 280);
    expect(s.pressed && s.down && s.pressedLatch).toBe(true);
    s.update(1, 16, 280);
    expect(s.pressed).toBe(false);
    expect(s.pressedLatch).toBe(true); // no fixed step consumed it yet
    s.consumeLatches();
    expect(s.pressedLatch).toBe(false);
    s.update(0, 32, 280);
    expect(s.released && s.releasedLatch).toBe(true);
  });

  it('detects double-taps within the window only', () => {
    const s = new ActionState();
    s.update(1, 0, 280);
    s.update(0, 50, 280);
    s.update(1, 200, 280);
    expect(s.doubleTapped).toBe(true);
    s.update(0, 250, 280);
    s.update(1, 300, 280); // third tap: not another double-tap
    expect(s.doubleTapped).toBe(false);
    s.update(0, 350, 280);
    s.update(1, 900, 280);
    expect(s.doubleTapped).toBe(false);
  });
});

describe('applyDeadzone', () => {
  it('zeroes small input and rescales the rest', () => {
    const out = { x: 0, y: 0 };
    expect(applyDeadzone(0.1, 0, 0.15, out)).toEqual({ x: 0, y: 0 });
    applyDeadzone(1, 0, 0.15, out);
    expect(out.x).toBeCloseTo(1);
    applyDeadzone(0.575, 0, 0.15, out);
    expect(out.x).toBeCloseTo(0.5);
  });
});
