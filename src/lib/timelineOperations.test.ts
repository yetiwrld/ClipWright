import { describe, expect, it } from 'vitest';
import { createProject } from './projects';
import { createProjectDocument, serializeProjectDocument } from './projectDocument';
import {
  addTimelineClip, clipDuration, duplicateTimelineClips, moveTimelineClips, pasteTimelineClips,
  removeTimelineClips, resizeTimelineClip, sequenceDurationInFrames, splitTimelineClip,
} from './timelineOperations';

function makeDocument() {
  const document = createProjectDocument(createProject('Timeline operations', '16:9', 30));
  document.assets.push({
    id: 'asset-video', name: 'take.mp4', sourcePath: 'take.mp4', pathKind: 'browser-session', kind: 'video',
    streams: { video: { timeBase: { numerator: 1, denominator: 1000 }, durationTicks: 10_000, width: 1920, height: 1080, metadataSource: 'browser' } },
  });
  return document;
}
function videoTrack(document: ReturnType<typeof makeDocument>) { return document.sequences[0].tracks.find((track) => track.kind === 'video')!; }
describe('seconds-based timeline operations', () => {
  it('adds source clips with frame-quantized timing, updates duration, and leaves the input immutable', () => {
    const original = makeDocument();
    const first = addTimelineClip(original, original.sequences[0].id, 'asset-video', videoTrack(original).id, 0, 'clip-one');
    const second = addTimelineClip(first, first.sequences[0].id, 'asset-video', videoTrack(first).id, 10, 'clip-two');
    expect(videoTrack(second).clips).toMatchObject([
      { id: 'clip-one', sourceId: 'asset-video', trackId: videoTrack(second).id, start: 0, trimIn: 0, trimOut: 10 },
      { id: 'clip-two', sourceId: 'asset-video', trackId: videoTrack(second).id, start: 10, trimIn: 0, trimOut: 10 },
    ]);
    expect(second.sequences[0].durationFrames).toBe(600);
    expect(original.sequences[0].durationFrames).toBe(0);
    expect(serializeProjectDocument(second)).toContain('"trimOut": 10');
  });

  it('places still images on video tracks with editable duration and schema-v2 persistence', () => {
    const document = makeDocument();
    document.assets.push({ id: 'asset-image', name: 'still.png', sourcePath: 'still.png', pathKind: 'browser-session', kind: 'image', streams: {}, imageDimensions: { width: 1600, height: 900 } });
    const sequenceId = document.sequences[0].id;
    const trackId = videoTrack(document).id;
    const added = addTimelineClip(document, sequenceId, 'asset-image', trackId, 1, 'image-clip');
    expect(videoTrack(added).clips[0]).toMatchObject({ id: 'image-clip', sourceId: 'asset-image', start: 1, trimIn: 0, trimOut: 5 });
    expect(added.sequences[0].durationFrames).toBe(180);
    expect(() => serializeProjectDocument(added)).not.toThrow();

    const shortened = resizeTimelineClip(added, sequenceId, 'image-clip', 1, 0, 3);
    const moved = moveTimelineClips(shortened, sequenceId, ['image-clip'], trackId, 4);
    const duplicated = duplicateTimelineClips(moved, sequenceId, ['image-clip'], ['image-copy'], 8);
    expect(videoTrack(duplicated).clips.map((clip) => [clip.id, clip.start, clipDuration(clip)])).toEqual([
      ['image-clip', 4, 3], ['image-copy', 8, 3],
    ]);
    expect(() => serializeProjectDocument(duplicated)).not.toThrow();
    expect(videoTrack(removeTimelineClips(duplicated, sequenceId, ['image-copy'])).clips).toHaveLength(1);
  });

  it('rounds timeline times to rational sequence frames and duration to the last frame', () => {
    const document = makeDocument();
    document.sequences[0].frameRate = { numerator: 30_000, denominator: 1001 };
    const updated = addTimelineClip(document, document.sequences[0].id, 'asset-video', videoTrack(document).id, 1.23456, 'ntsc-clip');
    const item = videoTrack(updated).clips[0];
    expect(item.start * 30_000 / 1001).toBeCloseTo(Math.round(1.23456 * 30_000 / 1001), 6);
    expect(updated.sequences[0].durationFrames).toBe(sequenceDurationInFrames(updated.sequences[0]));
    expect(() => serializeProjectDocument(updated)).not.toThrow();
  });

  it('trims source ranges, prevents same-track overlap, and preserves original assets', () => {
    const document = makeDocument(); const sequenceId = document.sequences[0].id; const trackId = videoTrack(document).id;
    const added = addTimelineClip(document, sequenceId, 'asset-video', trackId, 0, 'clip-one');
    const second = addTimelineClip(added, sequenceId, 'asset-video', trackId, 10, 'clip-two');
    const trimmed = resizeTimelineClip(second, sequenceId, 'clip-one', 0, 1, 9);
    expect(videoTrack(trimmed).clips[0]).toMatchObject({ trimIn: 1, trimOut: 9 });
    expect(clipDuration(videoTrack(trimmed).clips[0])).toBe(8);
    expect(document.assets[0].streams.video?.durationTicks).toBe(10_000);
    expect(() => resizeTimelineClip(trimmed, sequenceId, 'clip-one', 0, 9, 9)).toThrow('at least one frame');
    expect(videoTrack(resizeTimelineClip(trimmed, sequenceId, 'clip-one', 0, 0, 11)).clips[0].trimOut).toBe(10);
    expect(videoTrack(resizeTimelineClip(second, sequenceId, 'clip-one', 0, 0, 10.1)).clips[0].trimOut).toBe(10);
  });

  it('moves clips between same-type tracks and rejects overlap or wrong track types', () => {
    const document = makeDocument(); const sequenceId = document.sequences[0].id;
    const sourceTrack = videoTrack(document); const secondTrack = { ...sourceTrack, id: 'video-track-2', name: 'Video 2', clips: [] };
    document.sequences[0].tracks.unshift(secondTrack);
    const first = addTimelineClip(document, sequenceId, 'asset-video', sourceTrack.id, 0, 'clip-one');
    const second = addTimelineClip(first, sequenceId, 'asset-video', sourceTrack.id, 10, 'clip-two');
    expect(() => moveTimelineClips(second, sequenceId, ['clip-one'], sourceTrack.id, 1)).toThrow('cannot overlap');
    const moved = moveTimelineClips(second, sequenceId, ['clip-one'], secondTrack.id, 2);
    expect(moved.sequences[0].tracks.find((track) => track.id === secondTrack.id)?.clips[0]).toMatchObject({ id: 'clip-one', start: 2, trackId: secondTrack.id });
    const audioTrack = document.sequences[0].tracks.find((track) => track.kind === 'audio')!;
    expect(() => moveTimelineClips(second, sequenceId, ['clip-one'], audioTrack.id, 0)).toThrow('same type');
  });

  it('splits at the playhead and preserves contiguous source trim ranges', () => {
    const document = makeDocument(); const sequenceId = document.sequences[0].id; const trackId = videoTrack(document).id;
    const withClip = addTimelineClip(document, sequenceId, 'asset-video', trackId, 2, 'clip-one');
    const split = splitTimelineClip(withClip, sequenceId, 'clip-one', 5, 'clip-right');
    expect(videoTrack(split).clips).toMatchObject([
      { id: 'clip-one', start: 2, trimIn: 0, trimOut: 3 },
      { id: 'clip-right', start: 5, trimIn: 3, trimOut: 10 },
    ]);
    expect(split.sequences[0].durationFrames).toBe(withClip.sequences[0].durationFrames);
    expect(() => splitTimelineClip(split, sequenceId, 'clip-one', 2, 'bad-split')).toThrow('inside');
  });

  it('supports ripple delete, moving and right-edge trimming, plus copy/duplicate pastes', () => {
    const document = makeDocument(); const sequenceId = document.sequences[0].id; const trackId = videoTrack(document).id;
    let timeline = addTimelineClip(document, sequenceId, 'asset-video', trackId, 0, 'one');
    timeline = addTimelineClip(timeline, sequenceId, 'asset-video', trackId, 10, 'two');
    timeline = addTimelineClip(timeline, sequenceId, 'asset-video', trackId, 20, 'three');
    const shortened = resizeTimelineClip(timeline, sequenceId, 'two', 10, 0, 5, true);
    expect(videoTrack(shortened).clips.find((item) => item.id === 'three')?.start).toBe(15);
    const restored = resizeTimelineClip(shortened, sequenceId, 'two', 10, 0, 10, true);
    const rippleDeleted = removeTimelineClips(restored, sequenceId, ['two'], true);
    expect(videoTrack(rippleDeleted).clips.map((item) => [item.id, item.start])).toEqual([['one', 0], ['three', 10]]);
    const moved = moveTimelineClips(rippleDeleted, sequenceId, ['one'], trackId, 2, true);
    expect(videoTrack(moved).clips.map((item) => [item.id, item.start])).toEqual([['one', 2], ['three', 12]]);
    const movedAside = moveTimelineClips(moved, sequenceId, ['three'], trackId, 30);
    const duplicated = duplicateTimelineClips(movedAside, sequenceId, ['one'], ['one-copy'], 40);
    expect(videoTrack(duplicated).clips.find((item) => item.id === 'one-copy')?.start).toBe(40);
    const pasted = pasteTimelineClips(duplicated, sequenceId, [videoTrack(duplicated).clips.find((item) => item.id === 'one')!], 50, ['pasted-one']);
    expect(videoTrack(pasted).clips.find((item) => item.id === 'pasted-one')?.start).toBe(50);
  });

  it('keeps project duration aligned to the last remaining track clip', () => {
    const document = makeDocument(); const sequenceId = document.sequences[0].id; const video = videoTrack(document);
    document.assets.push({ id: 'asset-audio', name: 'voice.wav', sourcePath: 'voice.wav', pathKind: 'project-relative', kind: 'audio', streams: { audio: { timeBase: { numerator: 1, denominator: 48_000 }, durationTicks: 96_000, sampleRate: 48_000 } } });
    document.sequences[0].tracks[1].clips.push({ id: 'audio-clip', sourceId: 'asset-audio', trackId: document.sequences[0].tracks[1].id, start: 1, trimIn: 0, trimOut: 2 });
    const withVideo = addTimelineClip(document, sequenceId, 'asset-video', video.id, 0, 'clip-one');
    const withoutVideo = removeTimelineClips(withVideo, sequenceId, ['clip-one']);
    expect(withoutVideo.sequences[0].durationFrames).toBe(90);
    expect(() => serializeProjectDocument(withoutVideo)).not.toThrow();
  });
});
