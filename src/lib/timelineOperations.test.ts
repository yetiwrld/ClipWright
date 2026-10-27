import { describe, expect, it } from 'vitest';
import { createProject } from './projects';
import { createProjectDocument, serializeProjectDocument } from './projectDocument';
import { appendVideoClip, moveVideoClip, removeVideoClip, sequenceDurationInFrames } from './timelineOperations';

function makeDocument() {
  const document = createProjectDocument(createProject('Timeline operations', '16:9', 30));
  document.assets.push({
    id: 'asset-video',
    name: 'take.mp4',
    sourcePath: 'take.mp4',
    pathKind: 'browser-session',
    kind: 'video',
    streams: { video: {
      timeBase: { numerator: 1, denominator: 1000 },
      durationTicks: 10_000,
      width: 1920,
      height: 1080,
      metadataSource: 'browser',
    } },
  });
  return document;
}

function primaryVideoTrack(document: ReturnType<typeof makeDocument>) {
  return document.sequences[0].tracks.find((track) => track.kind === 'video')!;
}

describe('frame-based timeline operations', () => {
  it('appends a full-length source at the video track end using rational frame timing', () => {
    const document = makeDocument();
    const first = appendVideoClip(document, document.sequences[0].id, 'asset-video', 'clip-one', { modifiedAt: '2026-10-27T00:00:00.000Z' });
    const second = appendVideoClip(first, first.sequences[0].id, 'asset-video', 'clip-two');
    const clips = primaryVideoTrack(second).clips;

    expect(clips).toMatchObject([
      { id: 'clip-one', sourceInTick: 0, sourceOutTick: 10_000, timelineStartFrame: 0, timelineDurationFrames: 300 },
      { id: 'clip-two', sourceInTick: 0, sourceOutTick: 10_000, timelineStartFrame: 300, timelineDurationFrames: 300 },
    ]);
    expect(second.sequences[0].durationFrames).toBe(600);
    expect(document.sequences[0].durationFrames).toBe(0); // The source document was not mutated.
    expect(serializeProjectDocument(second)).toContain('"timelineDurationFrames": 300');
  });

  it('converts browser duration to integer frames with non-integer frame rates', () => {
    const document = makeDocument();
    document.sequences[0].frameRate = { numerator: 30_000, denominator: 1001 };
    document.assets[0].streams.video!.timeBase = { numerator: 1, denominator: 1_000_000 };
    document.assets[0].streams.video!.durationTicks = 12_345_678;

    const updated = appendVideoClip(document, document.sequences[0].id, 'asset-video', 'ntsc-clip');
    expect(primaryVideoTrack(updated).clips[0]).toMatchObject({ timelineStartFrame: 0, timelineDurationFrames: 370 });
    expect(updated.sequences[0].durationFrames).toBe(370);
    expect(() => serializeProjectDocument(updated)).not.toThrow();
  });

  it('moves clips only to non-overlapping safe frame positions and removes clips cleanly', () => {
    const document = makeDocument();
    const first = appendVideoClip(document, document.sequences[0].id, 'asset-video', 'clip-one');
    const second = appendVideoClip(first, first.sequences[0].id, 'asset-video', 'clip-two');
    const sequenceId = first.sequences[0].id;

    expect(() => moveVideoClip(second, sequenceId, 'clip-one', 1)).toThrow('cannot overlap');
    const moved = moveVideoClip(second, sequenceId, 'clip-one', 600);
    expect(primaryVideoTrack(moved).clips[0]).toMatchObject({ id: 'clip-one', timelineStartFrame: 600 });
    expect(moved.sequences[0].durationFrames).toBe(900);
    const withoutSecond = removeVideoClip(moved, sequenceId, 'clip-two');
    expect(primaryVideoTrack(withoutSecond).clips.map((clip) => clip.id)).toEqual(['clip-one']);
    expect(withoutSecond.sequences[0].durationFrames).toBe(900);
    const empty = removeVideoClip(withoutSecond, sequenceId, 'clip-one');
    expect(primaryVideoTrack(empty).clips).toEqual([]);
    expect(empty.sequences[0].durationFrames).toBe(0);
    expect(sequenceDurationInFrames(empty.sequences[0])).toBe(0);
    expect(() => serializeProjectDocument(empty)).not.toThrow();
  });

  it('keeps the sequence long enough for remaining audio clips when video is removed', () => {
    const document = makeDocument();
    document.assets.push({
      id: 'asset-audio', name: 'voice.wav', sourcePath: 'voice.wav', pathKind: 'project-relative', kind: 'audio',
      streams: { audio: { timeBase: { numerator: 1, denominator: 48_000 }, durationTicks: 96_000, sampleRate: 48_000 } },
    });
    const audioTrack = document.sequences[0].tracks.find((track) => track.kind === 'audio')!;
    audioTrack.clips.push({
      id: 'audio-clip', assetId: 'asset-audio', kind: 'audio', sourceInTick: 0, sourceOutTick: 96_000,
      timelineStartSample: 48_000, timelineDurationSamples: 48_000, sampleRate: 48_000,
      playbackRate: { numerator: 1, denominator: 1 },
    });
    const withVideo = appendVideoClip(document, document.sequences[0].id, 'asset-video', 'clip-one');
    const withoutVideo = removeVideoClip(withVideo, withVideo.sequences[0].id, 'clip-one');

    expect(withoutVideo.sequences[0].durationFrames).toBe(60);
    expect(() => serializeProjectDocument(withoutVideo)).not.toThrow();
  });
});
