import { events } from '../core/events';

/**
 * Minimal HUD (DESIGN.md §10.1): reticle and the running property-damage bill. The speed
 * indicator is ui/speedometer.ts; heat level, power meters and casualties arrive with their systems.
 */
export class Hud {
  private root: HTMLDivElement;
  private bill: HTMLSpanElement;
  private reticle: HTMLDivElement;
  private shown = 0;
  private target = 0;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.id = 'hud';
    this.root.innerHTML =
      '<div class="hud-bill"><span class="hud-bill-label">DAMAGE</span><span class="hud-bill-value">$0</span></div>';
    this.reticle = document.createElement('div');
    this.reticle.id = 'reticle';
    parent.append(this.root, this.reticle);
    this.bill = this.root.querySelector('.hud-bill-value')!;
    events.on('damage:bill', ({ total }) => (this.target = total));
  }

  /** Per frame: the bill ticks up toward the real total. */
  update(dt: number, targetInReach: boolean) {
    if (this.shown !== this.target) {
      const diff = this.target - this.shown;
      this.shown += Math.abs(diff) < 10 ? diff : diff * Math.min(1, dt * 6);
      this.bill.textContent = formatDollars(this.shown);
    }
    this.reticle.classList.toggle('reach', targetInReach);
  }
}

export function formatDollars(v: number) {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  return `$${Math.round(v).toLocaleString('en-US')}`;
}
