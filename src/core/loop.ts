/**
 * Fixed-timestep accumulator (DESIGN.md §13): simulation steps at a fixed rate,
 * rendering interpolates between the last two states with `alpha`.
 */
export class FixedStepLoop {
  private accumulator = 0;
  /** Simulation seconds elapsed (scaled). */
  simTime = 0;
  /** Steps run during the last advance(). */
  lastSteps = 0;
  /** True when the last advance() hit maxSteps and dropped time. */
  droppedTime = false;

  constructor(public stepDt: number) {}

  /**
   * Advances by a real frame delta. Calls `step(dt)` zero or more times.
   * @returns interpolation alpha in [0, 1).
   */
  advance(
    realDt: number,
    opts: { timeScale: number; maxFrameDt: number; maxSteps: number; paused: boolean },
    step: (dt: number) => void,
  ): number {
    const dt = this.stepDt;
    if (!opts.paused) {
      this.accumulator += Math.min(Math.max(realDt, 0), opts.maxFrameDt) * opts.timeScale;
    }
    let steps = 0;
    while (this.accumulator >= dt && steps < opts.maxSteps) {
      step(dt);
      this.accumulator -= dt;
      this.simTime += dt;
      steps++;
    }
    this.droppedTime = this.accumulator >= dt;
    if (this.droppedTime) this.accumulator %= dt;
    this.lastSteps = steps;
    return this.accumulator / dt;
  }
}
