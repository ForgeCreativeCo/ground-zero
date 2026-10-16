import { audio, audioMeta } from './audio';
import { budgets, budgetsMeta, perf } from './budgets';
import { camera, cameraMeta } from './camera';
import { city, cityMeta } from './city';
import { bindings, controls, controlsMeta } from './controls';
import { debug, debugMeta } from './debug';
import { debugCamera, debugCameraMeta } from './debugCamera';
import {
  construction,
  damage,
  debris,
  destructionMeta,
  materials,
  slam,
  sonicCity,
  strength,
  structure,
} from './destruction';
import { environmentMeta, moon, sky, sun } from './environment';
import { fx, fxMeta } from './fx';
import { fire, interiors, interiorsMeta, power } from './interiors';
import { loop, loopMeta } from './loop';
import { player, playerMeta } from './player';
import { energyBall, flyThrough, freezeBreath, heatVision, powersMeta } from './powers';
import type { MetaMap } from './meta';
import { render, renderMeta } from './render';
import {
  applyOverrides,
  assignInPlace,
  deepClone,
  diff,
  type ConfigTree,
  type ConfigValue,
} from './store';
import { world, worldMeta } from './world';

const defaultsTree = {
  loop,
  render,
  sun,
  moon,
  sky,
  world,
  city,
  player,
  camera,
  fx,
  audio,
  materials,
  construction,
  damage,
  structure,
  debris,
  strength,
  slam,
  sonicCity,
  heatVision,
  freezeBreath,
  energyBall,
  flyThrough,
  interiors,
  power,
  fire,
  debugCamera,
  controls,
  bindings,
  budgets,
  perf,
  debug,
};

export type GameConfig = typeof defaultsTree;

/** Pristine defaults. Never mutate. */
export const defaults: Readonly<GameConfig> = deepClone(defaultsTree);

/** The live config. Systems read from this every frame; the debug panel writes to it. */
export const config: GameConfig = deepClone(defaultsTree);

export const meta: MetaMap = {
  ...loopMeta,
  ...renderMeta,
  ...environmentMeta,
  ...worldMeta,
  ...cityMeta,
  ...playerMeta,
  ...cameraMeta,
  ...fxMeta,
  ...audioMeta,
  ...destructionMeta,
  ...interiorsMeta,
  ...powersMeta,
  ...debugCameraMeta,
  ...controlsMeta,
  ...budgetsMeta,
  ...debugMeta,
};

const STORAGE_KEY = 'ground-zero:config-overrides';

const asTree = (c: GameConfig | Readonly<GameConfig>) => c as unknown as ConfigTree;

/** Loads persisted debug-panel tweaks. Returns paths that no longer exist (renamed or removed). */
export function loadOverrides(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return applyOverrides(asTree(config), JSON.parse(raw) as Record<string, unknown>);
  } catch {
    return [];
  }
}

export function saveOverrides() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(changedValues()));
  } catch {
    // Storage unavailable (private mode); tweaks just won't persist.
  }
}

export function changedValues(): Record<string, ConfigValue> {
  return diff(asTree(defaults), asTree(config));
}

export function resetConfig() {
  assignInPlace(asTree(config), deepClone(asTree(defaults)));
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

/** Seed from ?seed=, else the config default. */
export function getSeed(): number {
  const param = new URLSearchParams(location.search).get('seed');
  const n = param === null ? NaN : Number.parseInt(param, 10);
  return Number.isFinite(n) ? n : config.world.defaultSeed;
}

export { asTree };
