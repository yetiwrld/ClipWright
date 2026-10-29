import { describe, expect, it } from 'vitest';
import { createProject } from './projects';
import {
  createProjectDocument, migrateLegacyProjectEntry, PROJECT_DOCUMENTS_KEY, parseProjectDocument,
  readProjectDocuments, serializeProjectDocument, validateProjectDocument, writeProjectDocuments,
} from './projectDocument';

describe('versioned project documents', () => {
  it('creates and round-trips an empty sequence with second-based timeline clips', () => {
    const document = createProjectDocument(createProject('Portrait story', '9:16', 30, new Date('2026-10-27T12:00:00.000Z')));
    expect(document.schemaVersion).toBe(2);
    expect(document.sequences[0]).toMatchObject({ width: 1080, height: 1920, frameRate: { numerator: 30, denominator: 1 }, audioSampleRate: 48000 });
    expect(document.sequences[0].tracks.map((track) => track.kind)).toEqual(['video', 'audio']);
    expect(validateProjectDocument(document)).toEqual({ valid: true, value: document });
    expect(parseProjectDocument(serializeProjectDocument(document))).toEqual(document);
  });

  it('maps displayed fractional project rates to their exact rational sequence rates', () => {
    const cases = [
      [23.976, { numerator: 24_000, denominator: 1_001 }],
      [29.97, { numerator: 30_000, denominator: 1_001 }],
      [50, { numerator: 50, denominator: 1 }],
      [59.94, { numerator: 60_000, denominator: 1_001 }],
    ] as const;
    for (const [displayRate, exactRate] of cases) {
      const document = createProjectDocument(createProject('Fractional sequence', '16:9', displayRate));
      expect(document.sequences[0].frameRate).toEqual(exactRate);
    }
  });

  it('round-trips custom canvas dimensions and explicit fit/fill/stretch composition settings', () => {
    const document = createProjectDocument(createProject('Custom canvas', '117:73', 30));
    const sequence = document.sequences[0];
    sequence.width = 234;
    sequence.height = 146;
    sequence.canvasFit = 'fill';
    sequence.canvasBackground = '#26384a';
    const reopened = parseProjectDocument(serializeProjectDocument(document));
    expect(reopened.sequences[0]).toMatchObject({ width: 234, height: 146, canvasFit: 'fill', canvasBackground: '#26384a' });

    sequence.canvasFit = 'stretch';
    expect(validateProjectDocument(document).valid).toBe(true);
    sequence.canvasFit = 'silent-crop' as never;
    const invalidFit = validateProjectDocument(document);
    expect(invalidFit.valid).toBe(false);
    if (!invalidFit.valid) expect(invalidFit.errors).toContain('sequences[0].canvasFit must be fit, fill, or stretch.');
    sequence.canvasFit = 'fit';
    sequence.canvasBackground = 'red';
    const invalidBackground = validateProjectDocument(document);
    expect(invalidBackground.valid).toBe(false);
    if (!invalidBackground.valid) expect(invalidBackground.errors).toContain('sequences[0].canvasBackground must be a six-digit hex color.');
  });

  it('supports backward-compatible per-track gain and pan settings', () => {
    const document = createProjectDocument(createProject('Audio controls', '16:9', 30));
    const audioTrack = document.sequences[0].tracks.find((track) => track.kind === 'audio')!;
    expect(audioTrack).toMatchObject({ gain: 1, pan: 0 });
    audioTrack.gain = 1.6;
    audioTrack.pan = -0.4;
    expect(validateProjectDocument(document).valid).toBe(true);
    expect(parseProjectDocument(serializeProjectDocument(document)).sequences[0].tracks[1]).toMatchObject({ gain: 1.6, pan: -0.4 });

    const legacySchemaV2 = structuredClone(document);
    const legacyTrack = legacySchemaV2.sequences[0].tracks.find((track) => track.kind === 'audio')!;
    delete legacyTrack.gain;
    delete legacyTrack.pan;
    expect(validateProjectDocument(legacySchemaV2).valid).toBe(true);

    legacyTrack.gain = 2.1;
    const invalidResult = validateProjectDocument(legacySchemaV2);
    expect(invalidResult.valid).toBe(false);
    if (!invalidResult.valid) expect(invalidResult.errors).toContain('sequences[0].tracks[1].gain must be a finite value between 0 and 2.');
  });

  it('persists track hide and solo render state while accepting older schema-v2 tracks', () => {
    const document = createProjectDocument(createProject('Render state', '16:9', 30));
    const [videoTrack, audioTrack] = document.sequences[0].tracks;
    videoTrack.hidden = true;
    audioTrack.solo = true;
    const reopened = parseProjectDocument(serializeProjectDocument(document));
    expect(reopened.sequences[0].tracks[0].hidden).toBe(true);
    expect(reopened.sequences[0].tracks[1].solo).toBe(true);

    const olderV2 = structuredClone(reopened);
    delete olderV2.sequences[0].tracks[0].hidden;
    delete olderV2.sequences[0].tracks[1].solo;
    expect(validateProjectDocument(olderV2).valid).toBe(true);
    expect(parseProjectDocument(serializeProjectDocument(olderV2)).sequences[0].tracks.map((track) => [track.hidden ?? false, track.solo ?? false])).toEqual([[false, false], [false, false]]);

    const invalid = structuredClone(olderV2);
    invalid.sequences[0].tracks[0].hidden = 'yes' as unknown as boolean;
    const result = validateProjectDocument(invalid);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors).toContain('sequences[0].tracks[0].hidden must be a boolean when present.');
  });

  it('migrates a project-list entry to a v2 empty project document', () => {
    const legacy = {
      id: 'legacy-project-id', name: 'Before schema', createdAt: '2026-01-03T10:00:00.000Z', updatedAt: '2026-02-03T10:00:00.000Z',
      aspectRatio: '1:1', frameRate: 25, archived: false, favorite: true,
    };
    const migrated = migrateLegacyProjectEntry(legacy);
    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.id).toBe(legacy.id);
    expect(migrated.metadata.name).toBe(legacy.name);
    expect(migrated.sequences[0]).toMatchObject({ width: 1080, height: 1080, frameRate: { numerator: 25, denominator: 1 } });
    expect(parseProjectDocument(JSON.stringify(legacy))).toEqual(migrated);
  });

  it('migrates legacy v1 tick/sample clip timing into quantized seconds', () => {
    const old = createProjectDocument(createProject('Old project', '16:9', 30));
    const oldDoc = {
      ...old, schemaVersion: 1,
      assets: [{ id: 'asset', name: 'source.mp4', sourcePath: 'source.mp4', pathKind: 'browser-session', kind: 'video', streams: { video: { timeBase: { numerator: 1, denominator: 1000 }, durationTicks: 10000, width: 1920, height: 1080, metadataSource: 'browser' } } }],
      sequences: old.sequences.map((sequence) => ({ ...sequence, durationFrames: 90, tracks: sequence.tracks.map((track, index) => ({
        ...track, clips: index === 0 ? [{ id: 'clip', assetId: 'asset', kind: 'video', sourceInTick: 1000, sourceOutTick: 5000, timelineStartFrame: 30, timelineDurationFrames: 120, playbackRate: { numerator: 1, denominator: 1 } }] : [],
      })) })),
    };
    const migrated = parseProjectDocument(JSON.stringify(oldDoc));
    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.sequences[0].tracks[0].clips[0]).toMatchObject({ id: 'clip', sourceId: 'asset', trackId: old.sequences[0].tracks[0].id, start: 1, trimIn: 1, trimOut: 5 });
    expect(migrated.sequences[0].durationFrames).toBe(150);
  });

  it('rejects unsupported versions, malformed JSON, non-frame times, dangling sources, and overlap', () => {
    const document = createProjectDocument(createProject('Validation', '16:9', 30));
    expect(() => parseProjectDocument('{broken')).toThrow('not valid JSON');
    expect(() => parseProjectDocument(JSON.stringify({ ...document, schemaVersion: 42 }))).toThrow('Unsupported project schema version: 42');
    document.assets.push({ id: 'asset-1', name: 'Source clip', sourcePath: 'media/source.mp4', pathKind: 'project-relative', kind: 'video', streams: { video: { timeBase: { numerator: 1, denominator: 30 }, durationTicks: 900, frameRate: { numerator: 30, denominator: 1 }, width: 1920, height: 1080 } } });
    const video = document.sequences[0].tracks[0];
    video.clips.push({ id: 'clip-1', sourceId: 'asset-1', trackId: video.id, start: 0, trimIn: 0, trimOut: 4 });
    video.clips.push({ id: 'clip-2', sourceId: 'asset-1', trackId: video.id, start: 4, trimIn: 0, trimOut: 4 });
    document.sequences[0].durationFrames = 240;
    expect(validateProjectDocument(document).valid).toBe(true);
    video.clips[1].start = 4.01;
    expect(validateProjectDocument(document).valid).toBe(false);
    video.clips[1].start = 2;
    expect(validateProjectDocument(document).valid).toBe(false);
    video.clips[1].start = 4;
    video.clips[1].sourceId = 'missing';
    const result = validateProjectDocument(document);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.join(' ')).toContain('existing media asset');
  });

  it('validates source paths and duration, and persists documents without repairing malformed storage', () => {
    const document = createProjectDocument(createProject('Stored', '16:9', 30));
    document.assets.push({ id: 'asset-1', name: 'Source', sourcePath: 'media/source.mp4', pathKind: 'project-relative', kind: 'video', streams: { video: { timeBase: { numerator: 1, denominator: 30 }, durationTicks: 900, width: 1920, height: 1080 } } });
    const track = document.sequences[0].tracks[0];
    track.clips.push({ id: 'clip-1', sourceId: 'asset-1', trackId: track.id, start: 0, trimIn: 0, trimOut: 4 });
    document.sequences[0].durationFrames = 120;
    document.assets[0].sourcePath = 'https://example.invalid/source.mp4';
    expect(validateProjectDocument(document).valid).toBe(false);
    document.assets[0].sourcePath = 'media/source.mp4';
    expect(validateProjectDocument(document).valid).toBe(true);

    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    writeProjectDocuments(storage, [document]);
    expect(readProjectDocuments(storage)).toEqual({ documents: [document], issue: null });
    storage.setItem(PROJECT_DOCUMENTS_KEY, '{broken');
    expect(readProjectDocuments(storage).issue).toBe('invalid-data');
    expect(storage.getItem(PROJECT_DOCUMENTS_KEY)).toBe('{broken');
  });
});
