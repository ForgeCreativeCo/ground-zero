import { events } from '../core/events';

/**
 * Minimal HUD (DESIGN.md §10.1): reticle and the running property-damage bill. The speed
 * indicator is ui/speedometer.ts. Power meters (heat-vision overheat, freeze breath) sit above the
 * speed bar and fade out while idle; the energy-ball charge bar shows only while charging. Heat level and casualties arrive with their systems.
 */
export class Hud {
  private root: HTMLDivElement;
  private bill: HTMLSpanElement;
  private reticle: HTMLDivElement;
  private shown = 0;
  private target = 0;
  private meterRoot: HTMLDivElement;
  private heatEl: HTMLDivElement;
  private heatFill: HTMLDivElement;
  private breathEl: HTMLDivElement;
  private breathFill: HTMLDivElement;
  private chargeEl: HTMLDivElement;
  private chargeFill: HTMLDivElement;
  private meterKey = '';
  private nova: HTMLDivElement;
  private novaFill: HTMLSpanElement;
  private novaKey = '';

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.id = 'hud';
    this.root.innerHTML =
      '<div class="hud-bill"><span class="hud-bill-label">DAMAGE</span><span class="hud-bill-value">$0</span></div>' +
      '<div class="hud-nova"><span class="hud-bill-label">NOVA</span><span class="nova-track"><span class="nova-fill"></span></span></div>';
    this.reticle = document.createElement('div');
    this.reticle.id = 'reticle';
    this.meterRoot = document.createElement('div');
    this.meterRoot.id = 'power-meters';
    this.meterRoot.innerHTML =
      '<div class="meter heat"><div class="meter-fill"></div></div>' +
      '<div class="meter breath"><div class="meter-fill"></div></div>' +
      '<div class="meter charge" hidden><div class="meter-fill"></div></div>';
    parent.append(this.root, this.reticle, this.meterRoot);
    this.heatEl = this.meterRoot.querySelector('.heat')!;
    this.heatFill = this.heatEl.querySelector('.meter-fill')!;
    this.breathEl = this.meterRoot.querySelector('.breath')!;
    this.breathFill = this.breathEl.querySelector('.meter-fill')!;
    this.chargeEl = this.meterRoot.querySelector('.charge')!;
    this.chargeFill = this.chargeEl.querySelector('.meter-fill')!;
    this.bill = this.root.querySelector('.hud-bill-value')!;
    this.nova = this.root.querySelector('.hud-nova')!;
    this.novaFill = this.root.querySelector('.nova-fill')!;
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

  /** Nova charge 0..1 (glows when full, pulses during the wind-up). */
  novaMeter(level: number, windup: boolean) {
    const key = `${Math.round(level * 300)}|${windup}`;
    if (key === this.novaKey) return;
    this.novaKey = key;
    this.novaFill.style.width = `${(level * 100).toFixed(1)}%`;
    this.nova.classList.toggle('full', level >= 1);
    this.nova.classList.toggle('windup', windup);
  }

  /**
   * Power meters: energy-ball charge 0..1 (-1 = not charging, hidden); heat 0 = cool .. 1 =
   * overheated; breath 1 = full .. 0 = empty.
   */
  meters(charge: number, heat: number, locked: boolean, breath: number, exhausted: boolean) {
    // Only touch the DOM when something visible changed.
    const key = `${Math.round(charge * 200)}|${Math.round(heat * 200)}|${locked}|${Math.round(breath * 200)}|${exhausted}`;
    if (key === this.meterKey) return;
    this.meterKey = key;
    this.heatFill.style.width = `${(heat * 100).toFixed(1)}%`;
    this.breathFill.style.width = `${(breath * 100).toFixed(1)}%`;
    this.heatEl.classList.toggle('locked', locked);
    this.breathEl.classList.toggle('exhausted', exhausted);
    this.chargeEl.hidden = charge < 0;
    this.chargeFill.style.width = `${(Math.max(0, charge) * 100).toFixed(1)}%`;
    this.chargeEl.classList.toggle('full', charge >= 1);
    this.meterRoot.classList.toggle('idle', charge < 0 && heat < 0.005 && breath > 0.995);
  }
}

export function formatDollars(v: number) {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  return `$${Math.round(v).toLocaleString('en-US')}`;
}
