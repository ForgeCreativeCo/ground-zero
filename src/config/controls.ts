import type { MetaMap } from './meta';

/**
 * Bindings (DESIGN.md §4). Each action lists alternative inputs; any one triggers it.
 * - Keyboard: KeyboardEvent.code, e.g. "KeyW", "Space", "ShiftLeft".
 * - Mouse: "Mouse0" (left), "Mouse1" (middle), "Mouse2" (right).
 * - Gamepad (Xbox standard mapping): "Pad:A", "Pad:LB", "Pad:RT", "Pad:DUp", ...
 * - Chords: inputs joined by "+" must all be held, e.g. "Pad:LB+Pad:RB".
 * - Touch buttons (ui/touchControls.ts): "Touch:Jump", "Touch:Punch", ...
 */
export const bindings = {
  moveForward: ['KeyW'],
  moveBack: ['KeyS'],
  moveLeft: ['KeyA'],
  moveRight: ['KeyD'],
  /** Hold to ascend. Double-tap = take off (see controls.doubleTapMs). */
  jump: ['Space', 'Pad:A', 'Touch:Jump'],
  /** Ctrl+W closes the browser tab outside fullscreen, so C is an alternate. */
  descend: ['ControlLeft', 'ControlRight', 'KeyC', 'Pad:B', 'Touch:Down'],
  boost: ['ShiftLeft', 'ShiftRight', 'Pad:LS', 'Pad:LB', 'Touch:Boost'],
  /** Punch combo; also throws while holding something. */
  punch: ['Mouse0', 'Pad:X', 'Touch:Punch'],
  heatVision: ['Mouse2', 'Pad:RT', 'Touch:Heat'],
  freezeBreath: ['KeyF', 'Pad:LT', 'Touch:Freeze'],
  /** Hold to charge an energy ball, release to throw it. */
  energyBall: ['KeyG', 'Mouse1', 'Pad:RS', 'Touch:Energy'],
  /** Grab; on gamepad, Y again throws. */
  grab: ['KeyE', 'Pad:Y', 'Touch:Grab'],
  slam: ['KeyQ', 'Pad:RB', 'Touch:Slam'],
  nova: ['KeyR', 'Pad:LB+Pad:RB', 'Touch:Nova'],
  slowMotion: ['KeyT', 'Pad:DUp'],
  photoMode: ['KeyP', 'Pad:View'],
  spawnMenu: ['Tab', 'Pad:DDown'],
  debugPanel: ['F1', 'Backquote', 'Touch:Debug'],
  perfHud: ['F2', 'Touch:Perf'],
};

export type ActionName = keyof typeof bindings;

export const controls = {
  /** Max gap between two presses to count as a double-tap (ms). */
  doubleTapMs: 280,
  stickDeadzone: 0.15,
  triggerThreshold: 0.35,
  /** Which gamepad index to read (-1 = first connected). */
  gamepadIndex: -1,
  /** On-screen touch controls: 'auto' shows them on touch devices, 'on' always (also drivable by
   *  mouse, for testing), 'off' never. */
  touchUi: 'auto' as 'auto' | 'on' | 'off',
  /** Touch look speed (multiplier on camera.mouseSensitivity, per pixel dragged). */
  touchLookSensitivity: 1.6,
  /** Move stick: radius (px) of full deflection, and the deflection past which he boosts. */
  touchStickRadius: 64,
  touchBoostAt: 0.97,
  /** Phones and tablets play in landscape only (a rotate prompt covers portrait). */
  landscapeOnly: true,
};

export const controlsMeta: MetaMap = {
  'controls.doubleTapMs': { min: 100, max: 600, step: 5 },
  'controls.stickDeadzone': { min: 0, max: 0.5, step: 0.01 },
  'controls.triggerThreshold': { min: 0.05, max: 0.95, step: 0.01 },
  'controls.gamepadIndex': { min: -1, max: 3, step: 1 },
  'controls.touchUi': { options: { auto: 'auto', on: 'on', off: 'off' }, reload: true },
  'controls.touchLookSensitivity': { min: 0.1, max: 8, step: 0.05 },
  'controls.touchStickRadius': { min: 20, max: 200, step: 1 },
  'controls.touchBoostAt': { min: 0.5, max: 1.01, step: 0.01 },
};
