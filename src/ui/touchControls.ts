import { config } from '../config';
import type { Input } from '../core/input';

/** One on-screen button: label, the raw input id it holds, and how it behaves. */
interface ButtonDef {
  id: string;
  label: string;
  input: string;
  /** Tap toggles it on and off instead of holding (boost: thumbs are busy). */
  toggle?: boolean;
  size: 'big' | 'mid' | 'small';
}

const BUTTONS: ButtonDef[] = [
  { id: 'punch', label: 'PUNCH', input: 'Touch:Punch', size: 'big' },
  { id: 'jump', label: 'FLY', input: 'Touch:Jump', size: 'mid' },
  { id: 'down', label: 'DOWN', input: 'Touch:Down', size: 'mid' },
  { id: 'grab', label: 'GRAB', input: 'Touch:Grab', size: 'mid' },
  { id: 'slam', label: 'SLAM', input: 'Touch:Slam', size: 'mid' },
  { id: 'heat', label: 'HEAT', input: 'Touch:Heat', size: 'mid' },
  { id: 'freeze', label: 'ICE', input: 'Touch:Freeze', size: 'mid' },
  { id: 'energy', label: 'BALL', input: 'Touch:Energy', size: 'mid' },
  { id: 'nova', label: 'NOVA', input: 'Touch:Nova', size: 'mid' },
  { id: 'boost', label: 'BOOST', input: 'Touch:Boost', size: 'mid', toggle: true },
  { id: 'debug', label: 'MENU', input: 'Touch:Debug', size: 'small' },
  { id: 'perf', label: 'FPS', input: 'Touch:Perf', size: 'small' },
];

/** True on phones and tablets (or whenever config.controls.touchUi is 'on'). */
export function wantsTouchUi() {
  const mode = config.controls.touchUi;
  if (mode === 'on') return true;
  if (mode === 'off') return false;
  // The main pointer is a finger that can't hover: phones and tablets, not touchscreen laptops.
  return window.matchMedia('(pointer: coarse) and (hover: none)').matches;
}

/**
 * On-screen controls for phones and tablets (added at the user's request; DESIGN.md §4 covers
 * keyboard and gamepad). A floating move stick on the left half (push it to the rim to boost), drag
 * anywhere else to look, and a button cluster on the right for every action. Buttons hold the same
 * raw inputs the bindings map ("Touch:*" in config/controls.ts), so they behave exactly like keys.
 * Also: a tap-to-play screen that goes fullscreen and locks landscape where the browser allows,
 * and a rotate prompt that covers the game in portrait.
 */
export class TouchControls {
  readonly root: HTMLDivElement;
  private stickBase: HTMLDivElement;
  private stickKnob: HTMLDivElement;
  private stickId = -1;
  private stickX = 0;
  private stickY = 0;
  private stickBoost = false;
  private looks = new Map<number, { x: number; y: number }>();
  private held = new Map<number, ButtonDef>();
  private toggled = new Set<string>();
  private els = new Map<string, HTMLButtonElement>();
  private rotate: HTMLDivElement;
  private start: HTMLDivElement | null = null;

  constructor(
    parent: HTMLElement,
    private readonly input: Input,
  ) {
    document.documentElement.classList.add('touch');
    this.root = document.createElement('div');
    this.root.id = 'touch-ui';
    this.stickBase = document.createElement('div');
    this.stickBase.className = 'touch-stick';
    this.stickBase.hidden = true;
    this.stickKnob = document.createElement('div');
    this.stickKnob.className = 'touch-knob';
    this.stickBase.append(this.stickKnob);
    this.root.append(this.stickBase);
    for (const def of BUTTONS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `touch-btn touch-${def.size} touch-${def.id}`;
      b.textContent = def.label;
      b.dataset.input = def.input;
      b.addEventListener('pointerdown', (e) => this.onButtonDown(e, def, b));
      this.els.set(def.id, b);
      this.root.append(b);
    }
    this.root.addEventListener('pointerdown', this.onDown);
    window.addEventListener('pointermove', this.onMove, { passive: false });
    window.addEventListener('pointerup', this.onUp);
    window.addEventListener('pointercancel', this.onUp);
    // Long-press menus and text selection would fight the controls.
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());

    this.rotate = document.createElement('div');
    this.rotate.id = 'rotate-prompt';
    this.rotate.innerHTML =
      '<div class="rotate-phone"></div><p>Turn your device sideways</p><p class="rotate-sub">GROUND ZERO plays in landscape</p>';
    parent.append(this.root, this.rotate);
    this.showStart(parent);
    window.addEventListener('blur', () => this.releaseAll());
    document.addEventListener('visibilitychange', () => this.releaseAll());
  }

  /** "Tap to play": fullscreen and a landscape lock (where supported) need a user gesture. */
  private showStart(parent: HTMLElement) {
    const s = document.createElement('div');
    s.id = 'touch-start';
    s.innerHTML =
      '<div class="touch-start-title">GROUND ZERO</div><button type="button" id="touch-start-btn">Tap to play</button><p>Left thumb: move · drag right side: look · push the stick to the rim to boost</p>';
    parent.append(s);
    this.start = s;
    s.querySelector('button')!.addEventListener('click', () => void this.enterPlay());
  }

  private async enterPlay() {
    this.start?.remove();
    this.start = null;
    try {
      if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
    } catch {
      // Not allowed here (iOS Safari, embedded frames): play in the page.
    }
    if (config.controls.landscapeOnly) {
      const o = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
      await o.lock?.('landscape').catch(() => undefined);
    }
  }

  /** Nova button glows when the meter is full. */
  setNovaReady(ready: boolean) {
    this.els.get('nova')!.classList.toggle('ready', ready);
  }

  /** Per frame: the toggled boost stays held; a stick pushed to the rim boosts too. */
  update() {
    const boost = this.toggled.has('boost') || this.stickBoost;
    this.input.setHeld('Touch:Boost', boost);
    this.els.get('boost')!.classList.toggle('on', boost);
  }

  private onButtonDown(e: PointerEvent, def: ButtonDef, el: HTMLButtonElement) {
    e.preventDefault();
    e.stopPropagation();
    if (def.toggle) {
      if (this.toggled.has(def.id)) this.toggled.delete(def.id);
      else this.toggled.add(def.id);
      return;
    }
    this.held.set(e.pointerId, def);
    el.classList.add('down');
    this.input.setHeld(def.input, true);
  }

  private onDown = (e: PointerEvent) => {
    if ((e.target as HTMLElement).classList.contains('touch-btn')) return;
    e.preventDefault();
    const leftHalf = e.clientX < window.innerWidth * 0.45;
    if (leftHalf && this.stickId < 0) {
      // The stick appears under the thumb.
      this.stickId = e.pointerId;
      this.stickX = e.clientX;
      this.stickY = e.clientY;
      const r = config.controls.touchStickRadius;
      this.stickBase.hidden = false;
      this.stickBase.style.width = this.stickBase.style.height = `${r * 2}px`;
      this.stickBase.style.left = `${e.clientX - r}px`;
      this.stickBase.style.top = `${e.clientY - r}px`;
      this.stickKnob.style.transform = 'translate(-50%, -50%)';
    } else {
      this.looks.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }
  };

  private onMove = (e: PointerEvent) => {
    if (e.pointerId === this.stickId) {
      e.preventDefault();
      const r = config.controls.touchStickRadius;
      let dx = e.clientX - this.stickX;
      let dy = e.clientY - this.stickY;
      const len = Math.hypot(dx, dy);
      if (len > r) {
        dx *= r / len;
        dy *= r / len;
      }
      this.stickKnob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
      this.input.setTouchMove(dx / r, -dy / r);
      this.stickBoost = len / r >= config.controls.touchBoostAt;
      return;
    }
    const look = this.looks.get(e.pointerId);
    if (look) {
      e.preventDefault();
      this.input.addTouchLook(e.clientX - look.x, e.clientY - look.y);
      look.x = e.clientX;
      look.y = e.clientY;
    }
  };

  private onUp = (e: PointerEvent) => {
    if (e.pointerId === this.stickId) {
      this.stickId = -1;
      this.stickBoost = false;
      this.stickBase.hidden = true;
      this.input.setTouchMove(0, 0);
    }
    this.looks.delete(e.pointerId);
    const def = this.held.get(e.pointerId);
    if (def) {
      this.held.delete(e.pointerId);
      this.els.get(def.id)!.classList.remove('down');
      // Another finger may still be on the same button.
      if (![...this.held.values()].includes(def)) this.input.setHeld(def.input, false);
    }
  };

  private releaseAll() {
    for (const def of this.held.values()) {
      this.input.setHeld(def.input, false);
      this.els.get(def.id)!.classList.remove('down');
    }
    this.held.clear();
    this.looks.clear();
    this.stickId = -1;
    this.stickBoost = false;
    this.stickBase.hidden = true;
    this.input.setTouchMove(0, 0);
  }
}
