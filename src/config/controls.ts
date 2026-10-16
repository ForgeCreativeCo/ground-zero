import type { MetaMap } from './meta';

/**
 * Bindings (DESIGN.md §4). Each action lists alternative inputs; any one triggers it.
 * - Keyboard: KeyboardEvent.code, e.g. "KeyW", "Space", "ShiftLeft".
 * - Mouse: "Mouse0" (left), "Mouse1" (middle), "Mouse2" (right).
 * - Gamepad (Xbox standard mapping): "Pad:A", "Pad:LB", "Pad:RT", "Pad:DUp", ...
 * - Chords: inputs joined by "+" must all be held, e.g. "Pad:LB+Pad:RB".
 */
export const bindings = {
  moveForward: ['KeyW'],
  moveBack: ['KeyS'],
  moveLeft: ['KeyA'],
  moveRight: ['KeyD'],
  /** Hold to ascend. Double-tap = take off (see controls.doubleTapMs). */
  jump: ['Space', 'Pad:A'],
  /** Ctrl+W closes the browser tab outside fullscreen, so C is an alternate. */
  descend: ['ControlLeft', 'ControlRight', 'KeyC', 'Pad:B'],
  boost: ['ShiftLeft', 'ShiftRight', 'Pad:LS', 'Pad:LB'],
  /** Punch combo; also throws while holding something. */
  punch: ['Mouse0', 'Pad:X'],
  heatVision: ['Mouse2', 'Pad:RT'],
  freezeBreath: ['KeyF', 'Pad:LT'],
  /** Hold to charge an energy ball, release to throw it. */
  energyBall: ['KeyG', 'Mouse1', 'Pad:RS'],
  /** Grab; on gamepad, Y again throws. */
  grab: ['KeyE', 'Pad:Y'],
  slam: ['KeyQ', 'Pad:RB'],
  nova: ['KeyR', 'Pad:LB+Pad:RB'],
  slowMotion: ['KeyT', 'Pad:DUp'],
  photoMode: ['KeyP', 'Pad:View'],
  spawnMenu: ['Tab', 'Pad:DDown'],
  debugPanel: ['F1', 'Backquote'],
  perfHud: ['F2'],
};

export type ActionName = keyof typeof bindings;

export const controls = {
  /** Max gap between two presses to count as a double-tap (ms). */
  doubleTapMs: 280,
  stickDeadzone: 0.15,
  triggerThreshold: 0.35,
  /** Which gamepad index to read (-1 = first connected). */
  gamepadIndex: -1,
};

export const controlsMeta: MetaMap = {
  'controls.doubleTapMs': { min: 100, max: 600, step: 5 },
  'controls.stickDeadzone': { min: 0, max: 0.5, step: 0.01 },
  'controls.triggerThreshold': { min: 0.05, max: 0.95, step: 0.01 },
  'controls.gamepadIndex': { min: -1, max: 3, step: 1 },
};
