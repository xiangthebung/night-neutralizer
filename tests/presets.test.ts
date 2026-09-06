/**
 * The three chips are claims about what a tap sets, so the line under them has
 * to come from the same patch the tap writes, and "which preset is this?" has
 * to be answered by the settings rather than by remembering the last click.
 */
import { describe, expect, it } from 'vitest';
import {
  CUSTOM_PRESET_LINE,
  PRESETS,
  PRESET_ORDER,
  activePreset,
  presetById,
  presetMatches,
  presetPatch,
  type PresetId,
} from '../src/core/presets';
import { sanitizeSettings } from '../src/core/settings';
import { DEFAULT_SETTINGS, type Settings } from '../src/core/types';

const apply = (base: Settings, id: PresetId): Settings =>
  sanitizeSettings({ ...base, ...presetPatch(id) });

describe('the presets', () => {
  it('are the three the popup shows, each with a one-line explanation', () => {
    expect(PRESET_ORDER).toEqual(['dialogue', 'bedtime', 'balanced']);
    for (const id of PRESET_ORDER) {
      const preset = presetById(id);
      expect(preset.name.length).toBeGreaterThan(0);
      expect(preset.sets.length).toBeGreaterThan(10);
      // One line in a 306 px column at 11 px.
      expect(preset.sets.length).toBeLessThanOrEqual(60);
      expect(preset.sets).not.toContain('\n');
    }
  });

  it('Dialogue turns the sound up with night EQ and leaves the picture alone', () => {
    const base = sanitizeSettings({ videoStrength: 30, darkMode: true, images: false });
    const next = apply(base, 'dialogue');
    expect(next.audio).toBe(true);
    expect(next.audioStrength).toBe(70);
    expect(next.nightEq).toBe(true);
    expect(next.videoStrength).toBe(30);
    expect(next.darkMode).toBe(true);
    expect(next.images).toBe(false);
  });

  it('Bedtime turns both up and switches dark mode on', () => {
    const next = apply(sanitizeSettings({}), 'bedtime');
    expect(next.audioStrength).toBe(70);
    expect(next.nightEq).toBe(true);
    expect(next.videoStrength).toBe(70);
    expect(next.video).toBe(true);
    expect(next.images).toBe(true);
    expect(next.darkMode).toBe(true);
  });

  it('Balanced is the shipped defaults for everything a chip can set', () => {
    const scrambled = sanitizeSettings({
      audioStrength: 90,
      videoStrength: 10,
      nightEq: true,
      darkMode: true,
      video: false,
    });
    const next = apply(scrambled, 'balanced');
    for (const key of Object.keys(presetPatch('balanced')) as (keyof Settings)[]) {
      expect(next[key], key).toBe(DEFAULT_SETTINGS[key]);
    }
  });

  it('never touches the schedule, the master switch or the skip list', () => {
    const untouchable = [
      'enabled',
      'nightOnly',
      'nightStart',
      'nightEnd',
      'disabledSites',
      'skipMusic',
      'protectedBrightness',
    ];
    for (const preset of PRESETS) {
      for (const key of untouchable) {
        expect(preset.patch, `${preset.id} sets ${key}`).not.toHaveProperty(key);
      }
    }
  });

  it('returns a fresh patch each time, so a caller cannot mutate the preset', () => {
    const patch = presetPatch('dialogue');
    patch.audioStrength = 1;
    expect(presetPatch('dialogue').audioStrength).toBe(70);
  });
});

describe('activePreset', () => {
  it('names the shipped defaults Balanced', () => {
    expect(activePreset(sanitizeSettings({}))).toBe('balanced');
  });

  it('names a tapped preset by the settings it left behind', () => {
    const base = sanitizeSettings({});
    expect(activePreset(apply(base, 'dialogue'))).toBe('dialogue');
    expect(activePreset(apply(base, 'bedtime'))).toBe('bedtime');
    expect(activePreset(apply(apply(base, 'bedtime'), 'balanced'))).toBe('balanced');
  });

  it('prefers the more specific preset when a state matches two', () => {
    // Bedtime sets everything Dialogue sets, so a Bedtime tab must not read as
    // Dialogue — and it does match Dialogue, which is what this pins.
    const bedtime = apply(sanitizeSettings({}), 'bedtime');
    expect(presetMatches(presetById('dialogue'), bedtime)).toBe(true);
    expect(activePreset(bedtime)).toBe('bedtime');
  });

  it('returns null once a slider has been dragged off the preset', () => {
    const custom = sanitizeSettings({
      ...apply(sanitizeSettings({}), 'dialogue'),
      audioStrength: 71,
    });
    expect(activePreset(custom)).toBeNull();
    expect(CUSTOM_PRESET_LINE.length).toBeLessThanOrEqual(60);
  });
});
