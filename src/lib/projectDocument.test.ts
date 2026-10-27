import { describe, expect, it } from 'vitest';
import { createProject } from './projects';
import {
  createProjectDocument,
  migrateLegacyProjectEntry,
  PROJECT_DOCUMENTS_KEY,
  parseProjectDocument,
  readProjectDocuments,
  serializeProjectDocument,
  validateProjectDocument,
  writeProjectDocuments,
  type AudioClip,
  type VideoClip,
} from './projectDocument';

describe('versioned project documents', () => {
  it('creates an empty sequence with frame-based video and sample-based audio tracks', () => {
    const project = createProject('Portrait story', '9:16', 30, new Date('2026-10-27T12:00:00.000Z'));
    const document = createProjectDocument(project);
    expect(document.schemaVersion).toBe(1);
    expect(document.sequences[0].width).toBe(1080);
    expect(document.sequences[0].height).toBe(1920);
    expect(document.sequences[0].frameRate).toEqual({ numerator: 30, denominator: 1 });
    expect(document.sequences[0].audioSampleRate).toBe(48000);
    expect(document.sequences[0].tracks.map((track) => track.kind)).toEqual(['video', 'audio']);
    expect(validateProjectDocument(document)).toEqual({ valid: true, value: document });
  });

  it('round trips a document through validated JSON serialization', () => {
    const document = createProjectDocument(createProject('Interview', '16:9', 24));
    const text = serializeProjectDocument(document);
    expect(text.endsWith('\n')).toBe(true);
    expect(parseProjectDocument(text)).toEqual(document);
  });

  it('migrates a valid foundation project-list record into a v1 empty project file', () => {
    const legacy = {
      id: 'legacy-project-id',
      name: 'Before schema',
      createdAt: '2026-01-03T10:00:00.000Z',
      updatedAt: '2026-02-03T10:00:00.000Z',
      aspectRatio: '1:1',
      frameRate: 25,
      archived: false,
      favorite: true,
    };
    const migrated = migrateLegacyProjectEntry(legacy);
    expect(migrated.schemaVersion).toBe(1);
    expect(migrated.id).toBe(legacy.id);
    expect(migrated.metadata.name).toBe(legacy.name);
    expect(migrated.sequences[0]).toMatchObject({ width: 1080, height: 1080, frameRate: { numerator: 25, denominator: 1 } });
    expect(parseProjectDocument(JSON.stringify(legacy))).toEqual(migrated);
  });

  it('rejects unsupported versions and malformed JSON with actionable errors', () => {
    const document = createProjectDocument(createProject('Invalid', '16:9', 30));
    expect(() => parseProjectDocument('{broken')).toThrow('not valid JSON');
    expect(() => parseProjectDocument(JSON.stringify({ ...document, schemaVersion: 42 }))).toThrow('Unsupported project schema version: 42');
  });

  it('keeps audio sample timing aligned with the exact rational sequence duration', () => {
    const document = createProjectDocument(createProject('Audio timing', '16:9', 30));
    const sequence = document.sequences[0];
    sequence.durationFrames = 30;
    document.assets.push({
      id: 'audio-asset', name: 'Dialogue', sourcePath: 'media/dialogue.wav', pathKind: 'project-relative', kind: 'audio',
      streams: { audio: { timeBase: { numerator: 1, denominator: 48000 }, durationTicks: 96000, sampleRate: 48000, channels: 2 } },
    });
    const audioClip: AudioClip = {
      id: 'audio-clip', assetId: 'audio-asset', kind: 'audio', sourceInTick: 0, sourceOutTick: 48000,
      timelineStartSample: 0, timelineDurationSamples: 48000, sampleRate: 48000, playbackRate: { numerator: 1, denominator: 1 },
    };
    sequence.tracks[1].clips.push(audioClip);
    expect(validateProjectDocument(document).valid).toBe(true);
    audioClip.timelineDurationSamples = 48001;
    const result = validateProjectDocument(document);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.join(' ')).toContain('extends beyond the sequence duration');
  });

  it('round trips documents through local storage and never repairs malformed data implicitly', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };
    const document = createProjectDocument(createProject('Stored', '16:9', 30));
    writeProjectDocuments(storage, [document]);
    expect(readProjectDocuments(storage)).toEqual({ documents: [document], issue: null });
    const corrupt = '{broken';
    storage.setItem(PROJECT_DOCUMENTS_KEY, corrupt);
    expect(readProjectDocuments(storage).issue).toBe('invalid-data');
    expect(storage.getItem(PROJECT_DOCUMENTS_KEY)).toBe(corrupt);
  });

  it('validates exact integer timeline positions and rejects dangling or out-of-range media references', () => {
    const document = createProjectDocument(createProject('Timeline', '16:9', 30));
    document.assets.push({
      id: 'asset-1',
      name: 'Source clip',
      sourcePath: 'media/source.mp4',
      pathKind: 'project-relative',
      kind: 'video',
      streams: { video: { timeBase: { numerator: 1, denominator: 30 }, durationTicks: 900, frameRate: { numerator: 30, denominator: 1 }, width: 1920, height: 1080 } },
    });
    document.sequences[0].durationFrames = 300;
    const videoTrack = document.sequences[0].tracks[0];
    const videoClip: VideoClip = {
      id: 'clip-1', assetId: 'asset-1', kind: 'video', sourceInTick: 0, sourceOutTick: 120,
      timelineStartFrame: 48, timelineDurationFrames: 120, playbackRate: { numerator: 1, denominator: 1 },
    };
    videoTrack.clips.push(videoClip);
    expect(validateProjectDocument(document).valid).toBe(true);
    document.assets[0].sourcePath = 'https://example.invalid/source.mp4';
    const remotePathResult = validateProjectDocument(document);
    expect(remotePathResult.valid).toBe(false);
    if (!remotePathResult.valid) expect(remotePathResult.errors.join(' ')).toContain('must be a local path, not a URI');
    document.assets[0].sourcePath = 'media/source.mp4';
    document.assets[0].pathKind = 'browser-session';
    document.assets[0].sourcePath = 'source.mp4';
    document.assets[0].streams.video!.metadataSource = 'browser';
    expect(validateProjectDocument(document).valid).toBe(true);
    document.assets[0].sourcePath = 'folder/source.mp4';
    let sessionPathResult = validateProjectDocument(document);
    expect(sessionPathResult.valid).toBe(false);
    if (!sessionPathResult.valid) expect(sessionPathResult.errors.join(' ')).toContain('filename for a browser-session reference');
    document.assets[0].sourcePath = 'source.mp4';
    Reflect.set(document.assets[0].streams.video!, 'metadataSource', 'other');
    expect(validateProjectDocument(document).valid).toBe(false);
    document.assets[0].streams.video!.metadataSource = 'browser';
    document.assets[0].pathKind = 'project-relative';
    document.assets[0].streams.video!.metadataSource = undefined;
    videoClip.timelineStartFrame = 250;
    let result = validateProjectDocument(document);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.join(' ')).toContain('extends beyond the sequence duration');
    videoClip.timelineStartFrame = 48;
    videoClip.sourceOutTick = 901;
    result = validateProjectDocument(document);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.join(' ')).toContain('sourceOutTick exceeds the source stream duration');
    videoClip.timelineStartFrame = 1.5;
    videoClip.assetId = 'missing-asset';
    result = validateProjectDocument(document);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.join('\n')).toContain('non-negative frame index');
      expect(result.errors.join('\n')).toContain('existing media asset');
      expect(result.errors.join('\n')).toContain('required video stream');
    }
  });
});
