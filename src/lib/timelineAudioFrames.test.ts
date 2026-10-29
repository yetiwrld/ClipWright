import { describe, expect, it } from 'vitest';
import { mapAudioPartToTimelineChunk } from './timelineAudioFrames';

describe('embedded audio timeline mapping', () => {
  it('preserves a 250 ms source A/V offset while applying the video clip trim', () => {
    const mapped = mapAudioPartToTimelineChunk(
      { start: 4, trimIn: 10, trimOut: 12 },
      { timestamp: 10.25, duration: 0.5, bufferDuration: 0.5 },
      4,
      1,
    );
    expect(mapped).toEqual({ timelineStart: 4.25, timelineOffset: 0.25, sourceOffset: 0, duration: 0.5 });
  });

  it('intersects decoded pre-roll with the clip trim and export chunk bounds', () => {
    const mapped = mapAudioPartToTimelineChunk(
      { start: 2, trimIn: 5, trimOut: 7 },
      { timestamp: 4.5, duration: 1.5, bufferDuration: 1.5 },
      2.25,
      0.5,
    );
    expect(mapped).toEqual({ timelineStart: 2.25, timelineOffset: 0, sourceOffset: 0.75, duration: 0.5 });
  });

  it('keeps adjacent split-clip audio slices contiguous without overlap or a gap', () => {
    const chunkStart = 0.9;
    const left = mapAudioPartToTimelineChunk(
      { start: 0, trimIn: 2, trimOut: 3 },
      { timestamp: 2.8, duration: 0.4, bufferDuration: 0.4 },
      chunkStart,
      0.2,
    );
    const right = mapAudioPartToTimelineChunk(
      { start: 1, trimIn: 3, trimOut: 4 },
      { timestamp: 3, duration: 0.4, bufferDuration: 0.4 },
      chunkStart,
      0.2,
    );
    expect(left).not.toBeNull();
    expect(right).not.toBeNull();
    expect(left!.timelineStart).toBeCloseTo(0.9, 12);
    expect(left!.timelineOffset).toBe(0);
    expect(left!.sourceOffset).toBeCloseTo(0.1, 12);
    expect(left!.duration).toBeCloseTo(0.1, 12);
    expect(right!.timelineStart).toBe(1);
    expect(right!.timelineOffset).toBeCloseTo(0.1, 12);
    expect(right!.sourceOffset).toBe(0);
    expect(right!.duration).toBeCloseTo(0.1, 12);
    expect(left!.timelineStart + left!.duration).toBeCloseTo(right!.timelineStart, 12);
  });

  it('caps decoded audio at the available buffer length and clip out-trim', () => {
    expect(mapAudioPartToTimelineChunk(
      { start: 0, trimIn: 3, trimOut: 3.5 },
      { timestamp: 3.25, duration: 1, bufferDuration: 0.2 },
      0,
      1,
    )).toEqual({ timelineStart: 0.25, timelineOffset: 0.25, sourceOffset: 0, duration: 0.2 });
    expect(mapAudioPartToTimelineChunk(
      { start: 0, trimIn: 3, trimOut: 3.5 },
      { timestamp: 3.25, duration: 1, bufferDuration: 1 },
      0.25,
      1,
    )).toEqual({ timelineStart: 0.25, timelineOffset: 0, sourceOffset: 0, duration: 0.25 });
  });

  it('returns no mix window when decoded audio falls outside the clip, chunk, or empty trim', () => {
    expect(mapAudioPartToTimelineChunk(
      { start: 2, trimIn: 5, trimOut: 6 },
      { timestamp: 4, duration: 0.5, bufferDuration: 0.5 },
      2,
      0.5,
    )).toBeNull();
    expect(mapAudioPartToTimelineChunk(
      { start: 0, trimIn: 0, trimOut: 0 },
      { timestamp: 0, duration: 1, bufferDuration: 1 },
      0,
      1,
    )).toBeNull();
  });
});
