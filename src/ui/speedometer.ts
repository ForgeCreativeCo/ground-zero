import { config } from '../config';
import type { PlayerState } from '../core/events';
import type { SpeedBand } from '../player/flightModel';

/**
 * Speed indicator (DESIGN.md §10.1): a bar with a marker at the sonic threshold, the current
 * speed and the movement state. Part of the minimal HUD; the rest of the HUD arrives later.
 */
export class Speedometer {
  private root: HTMLDivElement;
  private fill: HTMLDivElement;
  private marker: HTMLDivElement;
  private label: HTMLSpanElement;
  private stateEl: HTMLSpanElement;
  private lastText = '';
  private lastState = '';

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.id = 'speedometer';
    this.root.innerHTML =
      '<div class="sm-row"><span class="sm-speed"></span><span class="sm-state"></span></div>' +
      '<div class="sm-track"><div class="sm-fill"></div><div class="sm-marker" title="Sound barrier"></div></div>';
    parent.appendChild(this.root);
    this.fill = this.root.querySelector('.sm-fill')!;
    this.marker = this.root.querySelector('.sm-marker')!;
    this.label = this.root.querySelector('.sm-speed')!;
    this.stateEl = this.root.querySelector('.sm-state')!;
  }

  update(speed: number, state: PlayerState, band: SpeedBand, diving: boolean) {
    const p = config.player;
    const max = p.boostSpeed * 1.05;
    this.fill.style.transform = `scaleX(${Math.min(1, speed / max).toFixed(4)})`;
    this.marker.style.left = `${((p.sonicThreshold / max) * 100).toFixed(2)}%`;
    const sonic = speed >= p.sonicThreshold;
    this.root.classList.toggle('sonic', sonic);
    const text = `${Math.round(speed)} m/s`;
    if (text !== this.lastText) {
      this.label.textContent = text;
      this.lastText = text;
    }
    const s =
      state === 'flying'
        ? diving
          ? 'dive'
          : band
        : state === 'airborne'
          ? 'leap'
          : speed > p.walkSpeed + 0.5
            ? 'run'
            : 'ground';
    if (s !== this.lastState) {
      this.stateEl.textContent = s.toUpperCase();
      this.lastState = s;
    }
  }
}
