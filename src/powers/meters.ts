/** Power meters (DESIGN.md §6.2, §6.3, §10.1). Pure logic, unit-tested. */

/**
 * Overheat meter (heat vision): `level` 0 = cool, 1 = overheated. Firing fills it; when it fills
 * he is locked out for `lockout` seconds, then it drains. Returns whether the power fires this step.
 */
export class OverheatMeter {
  level = 0;
  lockTimer = 0;

  get locked() {
    return this.lockTimer > 0;
  }

  update(wantFire: boolean, dt: number, maxFireTime: number, lockout: number, coolRate: number) {
    if (this.lockTimer > 0) {
      this.lockTimer = Math.max(0, this.lockTimer - dt);
      if (this.lockTimer === 0) this.level = Math.min(this.level, 0.999);
      return false;
    }
    if (wantFire) {
      this.level = Math.min(1, this.level + dt / Math.max(1e-3, maxFireTime));
      if (this.level >= 1) {
        this.lockTimer = lockout;
        // A zero lockout still has to drain a little before firing again.
        if (lockout <= 0) this.level = 0.98;
        return lockout <= 0;
      }
      return true;
    }
    this.level = Math.max(0, this.level - dt * coolRate);
    return false;
  }
}

/**
 * Breath meter (freeze breath): `level` 1 = full, 0 = empty. Breathing drains it; once empty it
 * has to refill to `restartAt` before he can breathe again.
 */
export class BreathMeter {
  level = 1;
  exhausted = false;

  update(wantFire: boolean, dt: number, maxTime: number, refill: number, restartAt: number) {
    if (this.exhausted && this.level >= restartAt) this.exhausted = false;
    if (wantFire && !this.exhausted && this.level > 0) {
      this.level = Math.max(0, this.level - dt / Math.max(1e-3, maxTime));
      if (this.level <= 0) this.exhausted = true;
      return true;
    }
    this.level = Math.min(1, this.level + dt * refill);
    return false;
  }
}
