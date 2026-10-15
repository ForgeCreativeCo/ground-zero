import type { PerfSnapshot } from '../ui/perfHud';

export interface PerfResult {
  frames: number;
  avgMs: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  peakActiveBodies: number;
  peakDrawCalls: number;
  peakTriangles: number;
  /** Average CPU time per frame (sim + render submission). */
  avgCpuMs: number;
  /** Seconds into the run of the worst frame. */
  maxAtSec: number;
}

/** Records every frame time between start() and stop() for the perf runner. */
export class PerfRecorder {
  private samples = new Float32Array(0);
  private n = 0;
  private recording = false;
  private peakBodies = 0;
  private peakDraws = 0;
  private peakTris = 0;
  private cpuSum = 0;
  private cpuN = 0;

  start(maxFrames = 20000) {
    if (this.samples.length < maxFrames) this.samples = new Float32Array(maxFrames);
    this.n = 0;
    this.peakBodies = this.peakDraws = this.peakTris = 0;
    this.cpuSum = this.cpuN = 0;
    this.recording = true;
  }

  pushCpu(ms: number) {
    if (!this.recording) return;
    this.cpuSum += ms;
    this.cpuN++;
  }

  push(ms: number) {
    if (!this.recording || this.n >= this.samples.length) return;
    this.samples[this.n++] = ms;
  }

  observe(s: PerfSnapshot) {
    if (!this.recording) return;
    this.peakBodies = Math.max(this.peakBodies, s.activeBodies);
    this.peakDraws = Math.max(this.peakDraws, s.drawCalls);
    this.peakTris = Math.max(this.peakTris, s.triangles);
  }

  stop(): PerfResult {
    this.recording = false;
    let maxI = 0;
    let t = 0;
    let maxAt = 0;
    for (let i = 0; i < this.n; i++) {
      t += this.samples[i]!;
      if (this.samples[i]! > this.samples[maxI]!) {
        maxI = i;
        maxAt = t / 1000;
      }
    }
    const view = this.samples.slice(0, this.n).sort();
    const pct = (p: number) =>
      this.n === 0
        ? 0
        : (view[Math.min(this.n - 1, Math.max(0, Math.ceil((p / 100) * this.n) - 1))] ?? 0);
    let sum = 0;
    for (let i = 0; i < this.n; i++) sum += view[i]!;
    return {
      frames: this.n,
      avgMs: this.n ? sum / this.n : 0,
      p95Ms: pct(95),
      p99Ms: pct(99),
      maxMs: this.n ? view[this.n - 1]! : 0,
      peakActiveBodies: this.peakBodies,
      peakDrawCalls: this.peakDraws,
      peakTriangles: this.peakTris,
      avgCpuMs: this.cpuN ? this.cpuSum / this.cpuN : 0,
      maxAtSec: maxAt,
    };
  }
}
