import { describe, expect, it } from 'vitest';
import { measureExportFile, readActiveSequenceExpectationFromJson } from './exportValidationMedia';

const projectJson = (frameCount: number) => JSON.stringify({
  schemaVersion: 2,
  id: 'project-1',
  metadata: { name: 'Validation project' },
  projectSettings: { defaultSequenceId: 'sequence-1' },
  sequences: [{
    id: 'sequence-1', name: 'Sequence 01', width: 1920, height: 1080,
    frameRate: { numerator: 30_000, denominator: 1_001 }, durationFrames: frameCount,
  }],
});

const inspection = (frames: number, durationSeconds = frames * 1_001 / 30_000) => ({
  mimeType: 'video/webm; codecs="vp9, opus"',
  video: { frames, durationSeconds, frameRate: frames / durationSeconds, width: 1920, height: 1080, codec: 'vp9', decodedFrames: frames, decodeError: null },
  audio: { durationSeconds, codec: 'opus' },
  containerDurationSeconds: durationSeconds,
});

describe('active sequence export validation', () => {
  it('refreshes rational rate, frame count, and frame-aligned duration from each current project document read', () => {
    const previousSavedSnapshot = readActiveSequenceExpectationFromJson(projectJson(600));
    const justSavedActiveSequence = readActiveSequenceExpectationFromJson(projectJson(601));
    expect(previousSavedSnapshot.frameCount).toBe(600);
    expect(justSavedActiveSequence.frameCount).toBe(601);
    expect(justSavedActiveSequence.frameRate).toEqual({ numerator: 30_000, denominator: 1_001, value: 30_000 / 1_001 });
    expect(justSavedActiveSequence.durationSeconds).toBeCloseTo(601 * 1_001 / 30_000, 12);
  });

  it('uses actual encoded file packets for frame coverage and keeps playback drops separate', () => {
    const expectation = readActiveSequenceExpectationFromJson(projectJson(667));
    const checks = measureExportFile(expectation, inspection(658));
    const browserPlayback = { droppedVideoFrames: 3, corruptedVideoFrames: 0 };
    expect(checks.actualVideoFrames).toBe(658);
    expect(checks.missingExportFrames).toBe(9);
    expect(checks.extraOutputFrames).toBe(0);
    expect(checks.frameCoveragePercent).toBeCloseTo(658 / 667 * 100, 10);
    expect(browserPlayback.droppedVideoFrames).toBe(3);
    expect(checks.missingExportFrames).toBe(9);
    expect(checks.missingExportFrames).not.toBe(browserPlayback.droppedVideoFrames);
    expect(checks.frameCountExact).toBe(false);
  });

  it('marks duration failures against frame-aligned expectation without broad tolerance', () => {
    const expectation = readActiveSequenceExpectationFromJson(projectJson(667));
    const checks = measureExportFile(expectation, inspection(667, expectation.durationSeconds + 0.2));
    expect(checks.durationToleranceSeconds).toBeCloseTo(1_001 / 30_000, 12);
    expect(checks.videoDurationWithinOneFrame).toBe(false);
    expect(checks.audioDurationWithinOneFrame).toBe(false);
    expect(checks.containerDurationWithinOneFrame).toBe(false);
  });

  it('reports exact output frame coverage and media durations independently', () => {
    const expectation = readActiveSequenceExpectationFromJson(projectJson(667));
    const videoDuration = expectation.durationSeconds;
    const checks = measureExportFile(expectation, {
      ...inspection(667, videoDuration),
      audio: { durationSeconds: videoDuration - 0.01, codec: 'opus' },
      containerDurationSeconds: videoDuration,
    });
    expect(checks.frameCoveragePercent).toBe(100);
    expect(checks.frameCountExact).toBe(true);
    expect(checks.missingExportFrames).toBe(0);
    expect(checks.videoDurationWithinOneFrame).toBe(true);
    expect(checks.audioDurationDifferenceSeconds).toBeCloseTo(-0.01, 10);
    expect(checks.containerDurationDifferenceSeconds).toBe(0);
  });
});
