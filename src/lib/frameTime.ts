export interface RationalFrameRate {
  numerator: number;
  denominator: number;
}

export const MICROSECONDS_PER_SECOND = 1_000_000;

function validateFrameRate(frameRate: RationalFrameRate) {
  if (!Number.isSafeInteger(frameRate.numerator) || frameRate.numerator <= 0
    || !Number.isSafeInteger(frameRate.denominator) || frameRate.denominator <= 0) {
    throw new Error('Sequence frame rate must be a positive rational number.');
  }
}

/** Round only floating-point representation noise around exact integer-frame endpoints. */
export function frameCountForEndTime(endSeconds: number, frameRate: RationalFrameRate): number {
  if (!Number.isFinite(endSeconds) || endSeconds <= 0) return 0;
  validateFrameRate(frameRate);
  const exactFrames = endSeconds * frameRate.numerator / frameRate.denominator;
  const nearestFrame = Math.round(exactFrames);
  const representationTolerance = Number.EPSILON * Math.max(1, Math.abs(exactFrames)) * 8;
  return Math.max(0, Math.abs(exactFrames - nearestFrame) <= representationTolerance ? nearestFrame : Math.ceil(exactFrames));
}

/** Derive every WebCodecs-facing timestamp from its integer frame index and round once to microseconds. */
export function frameTimestampMicroseconds(frameIndex: number, frameRate: RationalFrameRate): number {
  validateFrameRate(frameRate);
  if (!Number.isSafeInteger(frameIndex) || frameIndex < 0) throw new RangeError('Frame index must be a non-negative safe integer.');
  const timestamp = frameIndex * frameRate.denominator * MICROSECONDS_PER_SECOND / frameRate.numerator;
  if (!Number.isSafeInteger(Math.round(timestamp))) throw new RangeError('Frame timestamp exceeds the safe microsecond range.');
  return Math.round(timestamp);
}

/** Derive duration from adjacent rounded frame boundaries, preventing cumulative per-frame rounding drift. */
export function frameDurationMicroseconds(frameIndex: number, frameRate: RationalFrameRate): number {
  return frameTimestampMicroseconds(frameIndex + 1, frameRate) - frameTimestampMicroseconds(frameIndex, frameRate);
}
