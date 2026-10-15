import { describe, expect, it, vi } from 'vitest';
import { FixedStepLoop } from '../../src/core/loop';
import { EventBus } from '../../src/core/events';
import { Pool } from '../../src/core/pool';
import { Rng } from '../../src/core/rng';
import { FrameStats } from '../../src/core/frameStats';

const opts = { timeScale: 1, maxFrameDt: 0.25, maxSteps: 5, paused: false };

describe('FixedStepLoop', () => {
  it('runs whole steps and returns the leftover as alpha', () => {
    const loop = new FixedStepLoop(1 / 60);
    const step = vi.fn();
    const alpha = loop.advance(2.5 / 60, opts, step);
    expect(step).toHaveBeenCalledTimes(2);
    expect(alpha).toBeCloseTo(0.5, 5);
  });

  it('accumulates small frames across calls', () => {
    const loop = new FixedStepLoop(1 / 60);
    const step = vi.fn();
    loop.advance(0.4 / 60, opts, step);
    loop.advance(0.4 / 60, opts, step);
    expect(step).not.toHaveBeenCalled();
    loop.advance(0.4 / 60, opts, step);
    expect(step).toHaveBeenCalledTimes(1);
  });

  it('caps steps per frame and drops excess time (no spiral of death)', () => {
    const loop = new FixedStepLoop(1 / 60);
    const step = vi.fn();
    loop.advance(0.2, opts, step);
    expect(step).toHaveBeenCalledTimes(5);
    expect(loop.droppedTime).toBe(true);
    step.mockClear();
    loop.advance(0, opts, step);
    expect(step).toHaveBeenCalledTimes(0);
  });

  it('clamps huge deltas (tab switch)', () => {
    const loop = new FixedStepLoop(1 / 60);
    const step = vi.fn();
    loop.advance(10, { ...opts, maxSteps: 1000 }, step);
    expect(step).toHaveBeenCalledTimes(15); // 0.25 s
  });

  it('scales time and pauses', () => {
    const loop = new FixedStepLoop(1 / 60);
    const step = vi.fn();
    loop.advance(4 / 60, { ...opts, timeScale: 0.25 }, step);
    expect(step).toHaveBeenCalledTimes(1);
    step.mockClear();
    loop.advance(4 / 60, { ...opts, paused: true }, step);
    expect(step).not.toHaveBeenCalled();
  });
});

describe('EventBus', () => {
  it('delivers typed payloads and unsubscribes', () => {
    const bus = new EventBus<{ hit: { n: number } }>();
    const h = vi.fn();
    const off = bus.on('hit', h);
    bus.emit('hit', { n: 3 });
    off();
    bus.emit('hit', { n: 4 });
    expect(h).toHaveBeenCalledExactlyOnceWith({ n: 3 });
  });

  it('once fires a single time', () => {
    const bus = new EventBus<{ a: number }>();
    const h = vi.fn();
    bus.once('a', h);
    bus.emit('a', 1);
    bus.emit('a', 2);
    expect(h).toHaveBeenCalledExactlyOnceWith(1);
  });
});

describe('Pool', () => {
  it('reuses released items and respects capacity', () => {
    let created = 0;
    const pool = new Pool(
      () => ({ id: created++, used: false }),
      (o) => (o.used = false),
      2,
    );
    const a = pool.acquire()!;
    const b = pool.acquire()!;
    expect(pool.acquire()).toBeNull();
    a.used = true;
    pool.release(a);
    const c = pool.acquire()!;
    expect(c).toBe(a);
    expect(c.used).toBe(false);
    expect(b.id).toBe(1);
    expect(created).toBe(2);
  });
});

describe('Rng', () => {
  it('is deterministic per seed', () => {
    const a = new Rng(1234);
    const b = new Rng(1234);
    const c = new Rng(1235);
    const sa = Array.from({ length: 8 }, () => a.next());
    expect(Array.from({ length: 8 }, () => b.next())).toEqual(sa);
    expect(Array.from({ length: 8 }, () => c.next())).not.toEqual(sa);
  });

  it('stays in range', () => {
    const r = new Rng(7);
    for (let i = 0; i < 1000; i++) {
      const v = r.int(3, 6);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThanOrEqual(6);
      const f = r.next();
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(1);
    }
  });

  it('forks independent but reproducible streams', () => {
    expect(new Rng(1).fork(5).next()).toBe(new Rng(1).fork(5).next());
    expect(new Rng(1).fork(5).next()).not.toBe(new Rng(1).fork(6).next());
  });
});

describe('FrameStats', () => {
  it('computes average, max and percentiles over the ring', () => {
    const s = new FrameStats(4);
    [10, 20, 30, 40, 50].forEach((v) => s.push(v)); // 10 falls out
    expect(s.count).toBe(4);
    expect(s.at(0)).toBe(20);
    expect(s.latest()).toBe(50);
    expect(s.average()).toBe(35);
    expect(s.max()).toBe(50);
    expect(s.percentile(50)).toBe(30);
    expect(s.percentile(95)).toBe(50);
  });
});
