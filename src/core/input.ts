import { config } from '../config';
import { bindings as defaultBindings, type ActionName } from '../config/controls';
import { ActionState, applyDeadzone, PAD_BUTTONS, resolveAction } from './bindings';
import { events } from './events';

const ACTIONS = Object.keys(defaultBindings) as ActionName[];

/** Keys whose browser default would interfere with play. */
const PREVENT_DEFAULT = new Set(['F1', 'F2', 'Tab', 'Space', 'Backquote', 'ArrowUp', 'ArrowDown']);

/**
 * Keyboard, mouse and gamepad -> actions and axes (DESIGN.md §4).
 * Call update() once per rendered frame; fixed-step code reads latched edges and calls consumeLatches().
 */
export class Input {
  readonly actions = {} as Record<ActionName, ActionState>;
  /** Camera-relative move intent: x = right, y = forward. Length <= 1. */
  readonly move = { x: 0, y: 0 };
  /** Mouse look this frame (pixels). */
  readonly mouseDelta = { x: 0, y: 0 };
  /** Right stick, deadzoned (-1..1). */
  readonly lookStick = { x: 0, y: 0 };
  pointerLocked = false;
  gamepadConnected = false;
  lastDevice: 'keyboard' | 'gamepad' = 'keyboard';

  private held = new Set<string>();
  /** Inputs pressed since the last update (so sub-frame taps still register). */
  private tapped = new Set<string>();
  private pad = new Map<string, number>();
  private mouseAccum = { x: 0, y: 0 };
  private stickScratch = { x: 0, y: 0 };
  private readonly raw = (id: string): number => {
    if (this.held.has(id) || this.tapped.has(id)) return 1;
    return this.pad.get(id) ?? 0;
  };

  constructor(private readonly element: HTMLElement) {
    for (const a of ACTIONS) this.actions[a] = new ActionState();
    window.addEventListener('keydown', this.onKeyDown, { capture: true });
    window.addEventListener('keyup', this.onKeyUp, { capture: true });
    window.addEventListener('blur', this.onBlur);
    element.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('mousemove', this.onMouseMove);
    element.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
  }

  action(name: ActionName): ActionState {
    return this.actions[name];
  }

  update(nowMs: number) {
    this.pollGamepad();
    const { doubleTapMs } = config.controls;
    const b = config.bindings as Record<ActionName, string[]>;
    for (const name of ACTIONS)
      this.actions[name].update(resolveAction(b[name], this.raw), nowMs, doubleTapMs);
    this.tapped.clear();

    const kx = this.actions.moveRight.value - this.actions.moveLeft.value;
    const ky = this.actions.moveForward.value - this.actions.moveBack.value;
    const lx = this.pad.get('Axis:LX') ?? 0;
    const ly = this.pad.get('Axis:LY') ?? 0;
    applyDeadzone(lx, ly, config.controls.stickDeadzone, this.stickScratch);
    let mx = kx + this.stickScratch.x;
    let my = ky - this.stickScratch.y;
    const len = Math.hypot(mx, my);
    if (len > 1) {
      mx /= len;
      my /= len;
    }
    this.move.x = mx;
    this.move.y = my;

    applyDeadzone(
      this.pad.get('Axis:RX') ?? 0,
      this.pad.get('Axis:RY') ?? 0,
      config.controls.stickDeadzone,
      this.lookStick,
    );

    this.mouseDelta.x = this.mouseAccum.x;
    this.mouseDelta.y = this.mouseAccum.y;
    this.mouseAccum.x = 0;
    this.mouseAccum.y = 0;
  }

  /** Call after the first fixed step of a frame consumed the latched edges. */
  consumeLatches() {
    for (const name of ACTIONS) this.actions[name].consumeLatches();
  }

  requestPointerLock() {
    if (document.pointerLockElement === this.element) return;
    // unadjustedMovement gives raw mouse input where supported; fall back if rejected.
    const p = this.element.requestPointerLock({ unadjustedMovement: true }) as unknown;
    if (p instanceof Promise) {
      p.catch(() => {
        const q = this.element.requestPointerLock() as unknown;
        if (q instanceof Promise) q.catch(() => undefined);
      });
    }
  }

  private pollGamepad() {
    this.pad.clear();
    this.gamepadConnected = false;
    const pads = navigator.getGamepads?.() ?? [];
    const want = config.controls.gamepadIndex;
    let gp: Gamepad | null = null;
    for (const p of pads) {
      if (!p || !p.connected) continue;
      if (want < 0 || p.index === want) {
        gp = p;
        break;
      }
    }
    if (!gp) return;
    this.gamepadConnected = true;
    let active = false;
    const threshold = config.controls.triggerThreshold;
    for (let i = 0; i < PAD_BUTTONS.length; i++) {
      const btn = gp.buttons[i];
      if (!btn) continue;
      const name = PAD_BUTTONS[i] as string;
      // Triggers are analog; treat them as pressed past the threshold but keep the analog value.
      const isTrigger = name === 'LT' || name === 'RT';
      const v = isTrigger ? (btn.value >= threshold ? btn.value : 0) : btn.pressed ? 1 : 0;
      if (v > 0) {
        this.pad.set(`Pad:${name}`, v);
        active = true;
      }
    }
    const axes = ['LX', 'LY', 'RX', 'RY'];
    for (let i = 0; i < 4; i++) {
      const v = gp.axes[i] ?? 0;
      this.pad.set(`Axis:${axes[i]}`, v);
      if (Math.abs(v) > config.controls.stickDeadzone) active = true;
    }
    if (active && this.lastDevice !== 'gamepad') {
      this.lastDevice = 'gamepad';
      events.emit('input:device', { device: 'gamepad' });
    }
  }

  private isTyping(e: Event) {
    const t = e.target as HTMLElement | null;
    return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (this.isTyping(e)) return;
    if (PREVENT_DEFAULT.has(e.code)) e.preventDefault();
    if (e.repeat) return;
    this.held.add(e.code);
    this.tapped.add(e.code);
    if (this.lastDevice !== 'keyboard') {
      this.lastDevice = 'keyboard';
      events.emit('input:device', { device: 'keyboard' });
    }
  };

  private onKeyUp = (e: KeyboardEvent) => {
    this.held.delete(e.code);
  };

  private onMouseDown = (e: MouseEvent) => {
    if (e.button === 1) e.preventDefault(); // middle button: no autoscroll
    if (!this.pointerLocked) {
      this.requestPointerLock();
      return; // the capturing click shouldn't punch
    }
    const id = `Mouse${e.button}`;
    this.held.add(id);
    this.tapped.add(id);
  };

  private onMouseUp = (e: MouseEvent) => {
    this.held.delete(`Mouse${e.button}`);
  };

  private onMouseMove = (e: MouseEvent) => {
    if (!this.pointerLocked) return;
    this.mouseAccum.x += e.movementX;
    this.mouseAccum.y += e.movementY;
  };

  private onPointerLockChange = () => {
    this.pointerLocked = document.pointerLockElement === this.element;
    if (!this.pointerLocked) {
      for (const id of [...this.held]) if (id.startsWith('Mouse')) this.held.delete(id);
    }
  };

  private onBlur = () => {
    this.held.clear();
    this.tapped.clear();
  };

  /** Test hook: simulate a raw input being held (Playwright, unit tests). */
  setHeld(id: string, held: boolean) {
    if (held) {
      this.held.add(id);
      this.tapped.add(id);
    } else this.held.delete(id);
  }
}
