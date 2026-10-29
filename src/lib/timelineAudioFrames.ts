export type AudioClipTiming = {
  start: number;
  trimIn: number;
  trimOut: number;
};

export type AudioBufferPartTiming = {
  timestamp: number;
  duration: number;
  bufferDuration: number;
};

export type AudioTimelineMixWindow = {
  /** Absolute timeline time at which this source-buffer slice becomes audible. */
  timelineStart: number;
  /** Start time relative to the chunk currently being rendered. */
  timelineOffset: number;
  /** Start offset, in seconds, within the decoded AudioBuffer. */
  sourceOffset: number;
  /** Slice duration, constrained by the clip, chunk, and decoded buffer. */
  duration: number;
};

/**
 * Map one decoded source-audio buffer part into a rendered timeline chunk.
 * Source timestamps remain absolute media time; clip trims translate them to
 * timeline time, and all boundaries are intersected before scheduling playback.
 */
export function mapAudioPartToTimelineChunk(
  clip: AudioClipTiming,
  part: AudioBufferPartTiming,
  chunkStart: number,
  chunkDuration: number,
): AudioTimelineMixWindow | null {
  const values = [clip.start, clip.trimIn, clip.trimOut, part.timestamp, part.duration, part.bufferDuration, chunkStart, chunkDuration];
  if (values.some((value) => !Number.isFinite(value))) throw new RangeError('Audio timeline mapping requires finite timestamps and durations.');
  if (clip.trimOut < clip.trimIn || part.duration < 0 || part.bufferDuration < 0 || chunkDuration < 0) {
    throw new RangeError('Audio timeline mapping received a negative duration or reversed trim range.');
  }
  if (clip.trimOut === clip.trimIn || part.duration === 0 || part.bufferDuration === 0 || chunkDuration === 0) return null;

  const chunkEnd = chunkStart + chunkDuration;
  const clipTimelineEnd = clip.start + clip.trimOut - clip.trimIn;
  const effectivePartDuration = Math.min(part.duration, part.bufferDuration);
  const partTimelineStart = clip.start + part.timestamp - clip.trimIn;
  const partTimelineEnd = partTimelineStart + effectivePartDuration;
  const timelineStart = Math.max(chunkStart, clip.start, partTimelineStart);
  const timelineEnd = Math.min(chunkEnd, clipTimelineEnd, partTimelineEnd);
  if (timelineEnd <= timelineStart + 1e-9) return null;

  const sourceOffset = Math.max(0, timelineStart - partTimelineStart);
  const duration = Math.min(timelineEnd - timelineStart, effectivePartDuration - sourceOffset);
  if (duration <= 0) return null;
  return {
    timelineStart,
    timelineOffset: timelineStart - chunkStart,
    sourceOffset,
    duration,
  };
}
