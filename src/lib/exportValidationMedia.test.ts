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

const inspection = (
  frames: number,
  durationSeconds = frames * 1_001 / 30_000,
  decodedFrames: number | null = frames,
  decodeError: string | null = null,
) => ({
  mimeType: 'video/webm; codecs="vp9, opus"',
  video: {
    frames,
    durationSeconds,
    frameRate: frames / durationSeconds,
    timeResolution: 1_000,
    width: 1920,
    height: 1080,
    codec: 'vp9',
    decodedFrames,
    decodeError,
  },
  audio: { durationSeconds, timeResolution: 1_000, sampleRate: 48_000, codec: 'opus' },
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

  it('uses actual encoded packet and decoded-frame counts, distinct from playback drops', () => {
    const expectation = readActiveSequenceExpectationFromJson(projectJson(667));
    const checks = measureExportFile(expectation, inspection(658));
    const browserPlayback = { droppedVideoFrames: 3, corruptedVideoFrames: 0 };
    expect(checks.actualVideoFrames).toBe(658);
    expect(checks.decodedVideoFrames).toBe(658);
    expect(checks.missingExportFrames).toBe(9);
    expect(checks.extraOutputFrames).toBe(0);
    expect(checks.frameCoveragePercent).toBeCloseTo(658 / 667 * 100, 10);
    expect(browserPlayback.droppedVideoFrames).toBe(3);
    expect(checks.missingExportFrames).not.toBe(browserPlayback.droppedVideoFrames);
    expect(checks.frameCountExact).toBe(false);
  });

  it('uses distinct frame-timebase and Opus-packet duration bounds', () => {
    const expectation = readActiveSequenceExpectationFromJson(projectJson(667));
    const checks = measureExportFile(expectation, inspection(667, expectation.durationSeconds + 0.2));
    expect(checks.videoDurationToleranceSeconds).toBeCloseTo((1_001 / 30_000) / 2 + 0.0005, 12);
    expect(checks.audioDurationToleranceSeconds).toBeCloseTo(0.020 + 0.0005 + 1 / 48_000, 12);
    expect(checks.containerDurationToleranceSeconds).toBe(checks.audioDurationToleranceSeconds);
    expect(checks.videoDurationWithinTolerance).toBe(false);
    expect(checks.audioDurationWithinTolerance).toBe(false);
    expect(checks.containerDurationWithinTolerance).toBe(false);
  });

  it('does not accept the historical-reported 22.646 s measurement against a 667-frame 30 fps expectation', () => {
    const project = JSON.parse(projectJson(667));
    project.sequences[0].frameRate = { numerator: 30, denominator: 1 };
    const expectation = readActiveSequenceExpectationFromJson(JSON.stringify(project));
    const inspectionWithLongAudioTail = {
      ...inspection(667, expectation.durationSeconds),
      audio: { durationSeconds: 22.646, timeResolution: 1_000, sampleRate: 48_000, codec: 'opus' },
      containerDurationSeconds: 22.646,
    };
    const checks = measureExportFile(expectation, inspectionWithLongAudioTail);
    expect(checks.videoDurationWithinTolerance).toBe(true);
    expect(checks.audioDurationDifferenceSeconds).toBeCloseTo(0.4126666667, 9);
    expect(checks.audioDurationWithinTolerance).toBe(false);
    expect(checks.containerDurationWithinTolerance).toBe(false);
    // This policy arithmetic does not reproduce or resolve the historical user's export.
  });

  it('fails exact frame-count validation when full decode errors or yields fewer frames', () => {
    const expectation = readActiveSequenceExpectationFromJson(projectJson(667));
    const decodeError = measureExportFile(expectation, inspection(667, expectation.durationSeconds, null, 'decoder failed'));
    const decodeCountMismatch = measureExportFile(expectation, inspection(667, expectation.durationSeconds, 666));
    expect(decodeError.decodedVideoComplete).toBe(false);
    expect(decodeError.frameCountExact).toBe(false);
    expect(decodeCountMismatch.decodedVideoComplete).toBe(false);
    expect(decodeCountMismatch.frameCountExact).toBe(false);
  });

  it('reports exact packet and decoded frame coverage and measured track durations independently', () => {
    const expectation = readActiveSequenceExpectationFromJson(projectJson(667));
    const videoDuration = expectation.durationSeconds;
    const checks = measureExportFile(expectation, {
      ...inspection(667, videoDuration),
      audio: { durationSeconds: videoDuration - 0.01, timeResolution: 1_000, sampleRate: 48_000, codec: 'opus' },
      containerDurationSeconds: videoDuration,
    });
    expect(checks.frameCoveragePercent).toBe(100);
    expect(checks.decodedVideoComplete).toBe(true);
    expect(checks.frameCountExact).toBe(true);
    expect(checks.missingExportFrames).toBe(0);
    expect(checks.videoDurationWithinTolerance).toBe(true);
    expect(checks.audioDurationDifferenceSeconds).toBeCloseTo(-0.01, 10);
    expect(checks.audioDurationWithinTolerance).toBe(true);
    expect(checks.containerDurationDifferenceSeconds).toBe(0);
    expect(checks.containerDurationWithinTolerance).toBe(true);
  });
});
