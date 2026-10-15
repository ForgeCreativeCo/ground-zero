import type { MetaMap } from './meta';

/** Synthesized placeholder audio (DESIGN.md §11). Real samples can replace these later. */
export const audio = {
  enabled: true,
  masterVolume: 0.7,
  windVolume: 0.5,
  effectsVolume: 0.9,
  /** Speed where wind is silent and where it peaks. */
  windStartSpeed: 8,
  windFullSpeed: 160,
};

export const audioMeta: MetaMap = {
  'audio.masterVolume': { min: 0, max: 1, step: 0.01 },
  'audio.windVolume': { min: 0, max: 1, step: 0.01 },
  'audio.effectsVolume': { min: 0, max: 1, step: 0.01 },
  'audio.windStartSpeed': { min: 0, max: 100, step: 1 },
  'audio.windFullSpeed': { min: 10, max: 600, step: 1 },
};
