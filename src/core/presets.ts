/**
 * Presets: three one-tap settings for the popup.
 *
 * The sliders can express everything a preset can, so a preset is not a new
 * capability. It is an answer to the first-time question the sliders do not
 * answer — "what should I set this to?" — given in the vocabulary of the
 * situation rather than of the mechanism. Someone who cannot hear the dialogue
 * wants *Dialogue*; they do not want to learn that the fix is the sound slider
 * at 70 with the EQ switched on.
 *
 * Each preset is a patch over the settings, and only the keys it names. That
 * is what lets *Dialogue* leave the picture exactly as the user had it, and
 * what makes "which preset is this?" answerable: a preset is active when every
 * key it sets holds the value it would set. Pure, so the popup and the welcome
 * page cannot disagree about what a chip does.
 */
import { DEFAULT_SETTINGS, type Settings } from './types';

export type PresetId = 'dialogue' | 'bedtime' | 'balanced';

export interface Preset {
  id: PresetId;
  /** The chip. */
  name: string;
  /** One line under the chips, saying exactly what the tap sets. */
  sets: string;
  patch: Partial<Settings>;
}

/**
 * Most specific first, so that a state matching more than one preset is named
 * by the one that set more of it: *Bedtime* sets everything *Dialogue* sets and
 * the picture besides, so a tab on Bedtime must not read as Dialogue.
 */
export const PRESETS: readonly Preset[] = Object.freeze([
  {
    id: 'bedtime',
    name: 'Bedtime',
    sets: 'Sound 70 with night EQ · picture 70 · dark mode on',
    patch: {
      audio: true,
      audioStrength: 70,
      nightEq: true,
      video: true,
      images: true,
      videoStrength: 70,
      darkMode: true,
    },
  },
  {
    id: 'dialogue',
    name: 'Dialogue',
    sets: 'Sound 70 with night EQ · picture left as it is',
    patch: { audio: true, audioStrength: 70, nightEq: true },
  },
  {
    id: 'balanced',
    name: 'Balanced',
    sets: 'The defaults · sound 45 · picture 45 · no EQ, no dark mode',
    patch: {
      audio: true,
      audioStrength: DEFAULT_SETTINGS.audioStrength,
      nightEq: DEFAULT_SETTINGS.nightEq,
      video: true,
      images: true,
      videoStrength: DEFAULT_SETTINGS.videoStrength,
      darkMode: DEFAULT_SETTINGS.darkMode,
    },
  },
]);

/** The chips in the order they are shown: the everyday one first. */
export const PRESET_ORDER: readonly PresetId[] = Object.freeze(['dialogue', 'bedtime', 'balanced']);

export function presetById(id: PresetId): Preset {
  const preset = PRESETS.find((candidate) => candidate.id === id);
  if (!preset) throw new Error(`unknown preset ${id}`);
  return preset;
}

/** The patch a tap on the chip writes. */
export function presetPatch(id: PresetId): Partial<Settings> {
  return { ...presetById(id).patch };
}

/** Whether every key the preset sets already holds the value it would set. */
export function presetMatches(preset: Preset, settings: Settings): boolean {
  return (Object.keys(preset.patch) as (keyof Settings)[]).every(
    (key) => settings[key] === preset.patch[key],
  );
}

/**
 * Which chip describes the current settings, or null for anything the sliders
 * were dragged to by hand. Presets are checked most specific first.
 */
export function activePreset(settings: Settings): PresetId | null {
  return PRESETS.find((preset) => presetMatches(preset, settings))?.id ?? null;
}

/** The line under the chips when no preset matches. */
export const CUSTOM_PRESET_LINE = 'Your own settings · tap a preset to change them';
