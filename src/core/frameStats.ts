/** Ring buffer of frame times (ms) with avg / percentile queries. Allocation-free after construction. */
export class FrameStats {
  readonly samples: Float32Array;
  private scratch: Float32Array;
  private head = 0;
  count = 0;

  constructor(capacity: number) {
    this.samples = new Float32Array(capacity);
    this.scratch = new Float32Array(capacity);
  }

  get capacity() {
    return this.samples.length;
  }

  push(ms: number) {
    this.samples[this.head] = ms;
    this.head = (this.head + 1) % this.samples.length;
    if (this.count < this.samples.length) this.count++;
  }

  /** i = 0 is the oldest retained sample. */
  at(i: number): number {
    const start = (this.head - this.count + this.samples.length) % this.samples.length;
    return this.samples[(start + i) % this.samples.length] ?? 0;
  }

  latest(): number {
    return this.count === 0 ? 0 : this.at(this.count - 1);
  }

  average(): number {
    if (this.count === 0) return 0;
    let sum = 0;
    for (let i = 0; i < this.count; i++) sum += this.at(i);
    return sum / this.count;
  }

  max(): number {
    let m = 0;
    for (let i = 0; i < this.count; i++) m = Math.max(m, this.at(i));
    return m;
  }

  /** Nearest-rank percentile, p in [0, 100]. */
  percentile(p: number): number {
    if (this.count === 0) return 0;
    const view = this.scratch.subarray(0, this.count);
    for (let i = 0; i < this.count; i++) view[i] = this.at(i);
    view.sort();
    const rank = Math.min(this.count - 1, Math.max(0, Math.ceil((p / 100) * this.count) - 1));
    return view[rank] ?? 0;
  }

  clear() {
    this.head = 0;
    this.count = 0;
  }
}
