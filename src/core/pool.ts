/** Fixed-capacity object pool (particles, debris, decals, characters). No allocation after warm-up. */
export class Pool<T> {
  private free: T[] = [];
  private live = new Set<T>();

  constructor(
    private create: () => T,
    private reset: (item: T) => void,
    public readonly capacity: number,
    prewarm = 0,
  ) {
    for (let i = 0; i < Math.min(prewarm, capacity); i++) this.free.push(create());
  }

  get liveCount() {
    return this.live.size;
  }

  /** Returns an item, or null when the pool is at capacity (caller decides: skip, or recycle oldest). */
  acquire(): T | null {
    if (this.live.size >= this.capacity) return null;
    const item = this.free.pop() ?? this.create();
    this.live.add(item);
    return item;
  }

  release(item: T) {
    if (!this.live.delete(item)) return;
    this.reset(item);
    this.free.push(item);
  }

  forEachLive(fn: (item: T) => void) {
    for (const item of this.live) fn(item);
  }
}
