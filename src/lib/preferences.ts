export const EDITOR_PREFERENCES_KEY = 'clipwright.preferences.v1';

export type EditorPreferences = {
  editor: {
    snapEnabled: boolean;
    snapStrength: number;
    rippleMode: boolean;
    zoomPercent: number;
    showThumbnails: boolean;
    showWaveforms: boolean;
    playbackLoop: boolean;
  };
  audio: {
    masterVolume: number;
    defaultAudioMuted: boolean;
  };
  shortcuts: Record<'undo' | 'redo' | 'playPause' | 'split' | 'snap' | 'copy' | 'paste' | 'duplicate', string>;
  export: {
    container: 'webm' | 'mp4';
    quality: 'compact' | 'standard' | 'high';
    resolution: 'sequence' | '720p' | '540p' | '360p';
  };
  storage: {
    autosaveIntervalSeconds: number;
  };
  appearance: {
    uiScale: number;
    accent: 'orange' | 'blue' | 'violet';
  };
};

export const DEFAULT_EDITOR_PREFERENCES: EditorPreferences = {
  editor: { snapEnabled: true, snapStrength: 8, rippleMode: false, zoomPercent: 100, showThumbnails: true, showWaveforms: true, playbackLoop: false },
  audio: { masterVolume: 0.8, defaultAudioMuted: false },
  shortcuts: { undo: 'Ctrl+Z', redo: 'Ctrl+Shift+Z', playPause: 'Space', split: 'S', snap: 'N', copy: 'Ctrl+C', paste: 'Ctrl+V', duplicate: 'Ctrl+D' },
  export: { container: 'webm', quality: 'standard', resolution: 'sequence' },
  storage: { autosaveIntervalSeconds: 2 },
  appearance: { uiScale: 100, accent: 'orange' },
};

function boundedNumber(value: unknown, fallback: number, min: number, max: number) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

export function readEditorPreferences(storage: Pick<Storage, 'getItem'>): EditorPreferences {
  try {
    const parsed = JSON.parse(storage.getItem(EDITOR_PREFERENCES_KEY) ?? 'null') as Partial<EditorPreferences> | null;
    if (!parsed || typeof parsed !== 'object') return structuredClone(DEFAULT_EDITOR_PREFERENCES);
    return {
      editor: {
        snapEnabled: typeof parsed.editor?.snapEnabled === 'boolean' ? parsed.editor.snapEnabled : true,
        snapStrength: boundedNumber(parsed.editor?.snapStrength, 8, 2, 24),
        rippleMode: typeof parsed.editor?.rippleMode === 'boolean' ? parsed.editor.rippleMode : false,
        zoomPercent: boundedNumber(parsed.editor?.zoomPercent, 100, 50, 200),
        showThumbnails: typeof parsed.editor?.showThumbnails === 'boolean' ? parsed.editor.showThumbnails : true,
        showWaveforms: typeof parsed.editor?.showWaveforms === 'boolean' ? parsed.editor.showWaveforms : true,
        playbackLoop: typeof parsed.editor?.playbackLoop === 'boolean' ? parsed.editor.playbackLoop : false,
      },
      audio: {
        masterVolume: boundedNumber(parsed.audio?.masterVolume, 0.8, 0, 1),
        defaultAudioMuted: typeof parsed.audio?.defaultAudioMuted === 'boolean' ? parsed.audio.defaultAudioMuted : false,
      },
      shortcuts: {
        undo: typeof parsed.shortcuts?.undo === 'string' ? parsed.shortcuts.undo.slice(0, 24) : 'Ctrl+Z',
        redo: typeof parsed.shortcuts?.redo === 'string' ? parsed.shortcuts.redo.slice(0, 24) : 'Ctrl+Shift+Z',
        playPause: typeof parsed.shortcuts?.playPause === 'string' ? parsed.shortcuts.playPause.slice(0, 24) : 'Space',
        split: typeof parsed.shortcuts?.split === 'string' ? parsed.shortcuts.split.slice(0, 24) : 'S',
        snap: typeof parsed.shortcuts?.snap === 'string' ? parsed.shortcuts.snap.slice(0, 24) : 'N',
        copy: typeof parsed.shortcuts?.copy === 'string' ? parsed.shortcuts.copy.slice(0, 24) : 'Ctrl+C',
        paste: typeof parsed.shortcuts?.paste === 'string' ? parsed.shortcuts.paste.slice(0, 24) : 'Ctrl+V',
        duplicate: typeof parsed.shortcuts?.duplicate === 'string' ? parsed.shortcuts.duplicate.slice(0, 24) : 'Ctrl+D',
      },
      export: {
        container: parsed.export?.container === 'mp4' ? 'mp4' : 'webm',
        quality: parsed.export?.quality === 'compact' || parsed.export?.quality === 'high' ? parsed.export.quality : 'standard',
        resolution: parsed.export?.resolution === '720p' || parsed.export?.resolution === '540p' || parsed.export?.resolution === '360p' ? parsed.export.resolution : 'sequence',
      },
      storage: { autosaveIntervalSeconds: boundedNumber(parsed.storage?.autosaveIntervalSeconds, 2, 1, 60) },
      appearance: {
        uiScale: [90, 100, 110, 125].includes(Number(parsed.appearance?.uiScale)) ? Number(parsed.appearance?.uiScale) : 100,
        accent: parsed.appearance?.accent === 'blue' || parsed.appearance?.accent === 'violet' ? parsed.appearance.accent : 'orange',
      },
    };
  } catch {
    return structuredClone(DEFAULT_EDITOR_PREFERENCES);
  }
}

export function writeEditorPreferences(storage: Pick<Storage, 'setItem'>, preferences: EditorPreferences) {
  storage.setItem(EDITOR_PREFERENCES_KEY, JSON.stringify(preferences));
}
