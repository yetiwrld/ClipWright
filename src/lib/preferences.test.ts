import { describe, expect, it } from 'vitest';
import { DEFAULT_EDITOR_PREFERENCES, EDITOR_PREFERENCES_KEY, readEditorPreferences, writeEditorPreferences } from './preferences';

describe('local editor preferences', () => {
  it('uses safe defaults when there is no saved preference record', () => {
    expect(readEditorPreferences({ getItem: () => null })).toEqual(DEFAULT_EDITOR_PREFERENCES);
  });

  it('persists and reads valid app-level settings', () => {
    let value: string | null = null;
    const storage = { getItem: () => value, setItem: (_key: string, next: string) => { value = next; } };
    const next = structuredClone(DEFAULT_EDITOR_PREFERENCES);
    next.editor.snapEnabled = false;
    next.editor.snapStrength = 17;
    next.audio.masterVolume = 0.35;
    next.export.quality = 'high';
    next.shortcuts.split = 'Ctrl+Shift+X';
    writeEditorPreferences(storage, next);
    expect(value).not.toBeNull();
    expect(JSON.parse(value!).editor.snapEnabled).toBe(false);
    expect(readEditorPreferences(storage)).toEqual(next);
    expect(EDITOR_PREFERENCES_KEY).toBe('clipwright.preferences.v1');
  });

  it('clamps unsafe numeric values and ignores unsupported preference choices', () => {
    const raw = JSON.stringify({
      editor: { snapStrength: 999, zoomPercent: 12 },
      audio: { masterVolume: -2 },
      storage: { autosaveIntervalSeconds: 500 },
      appearance: { uiScale: 300, accent: 'neon' },
      export: { container: 'avi', quality: 'lossless', resolution: '8k' },
    });
    const preferences = readEditorPreferences({ getItem: () => raw });
    expect(preferences.editor.snapStrength).toBe(24);
    expect(preferences.editor.zoomPercent).toBe(50);
    expect(preferences.audio.masterVolume).toBe(0);
    expect(preferences.storage.autosaveIntervalSeconds).toBe(60);
    expect(preferences.appearance.uiScale).toBe(100);
    expect(preferences.appearance.accent).toBe('orange');
    expect(preferences.export).toEqual(DEFAULT_EDITOR_PREFERENCES.export);
  });

  it('falls back without throwing when saved JSON is malformed', () => {
    expect(readEditorPreferences({ getItem: () => '{broken' })).toEqual(DEFAULT_EDITOR_PREFERENCES);
  });
});
