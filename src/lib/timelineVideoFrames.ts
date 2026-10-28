import { ALL_FORMATS, BlobSource, CanvasSink, Input } from 'mediabunny';
import type { WrappedCanvas } from 'mediabunny';
import type { TimelineClip, Track } from './projectDocument';
import { clipEnd } from './timelineOperations';

export type TimelineCanvas = HTMLCanvasElement | OffscreenCanvas;

// Encoder packet timestamps are rounded to microseconds; treat that representation noise as an exact boundary.
export const CANVAS_TIMESTAMP_EPSILON_SECONDS = 1 / 1_000_000;
type TimestampedCanvasIterator = AsyncIterator<WrappedCanvas, void, unknown>;

/** A look-ahead cursor over presentation-order frames, exposed separately for deterministic boundary tests. */
export function createOrderedCanvasCursor(createIterator: () => TimestampedCanvasIterator) {
  let iterator: TimestampedCanvasIterator | null = null;
  let previous: WrappedCanvas | null = null;
  let next: IteratorResult<WrappedCanvas, void> | null = null;
  let lastRequestedTime = -Infinity;

  const reset = async () => {
    if (iterator?.return) await iterator.return().catch(() => undefined);
    iterator = createIterator();
    previous = null;
    next = null;
    lastRequestedTime = -Infinity;
  };

  return {
    async getCanvasAt(sourceTimeSeconds: number): Promise<WrappedCanvas | null> {
      if (!Number.isFinite(sourceTimeSeconds) || sourceTimeSeconds < 0) {
        throw new RangeError('Source frame time must be a finite, non-negative number.');
      }
      if (!iterator || sourceTimeSeconds < lastRequestedTime) await reset();
      lastRequestedTime = sourceTimeSeconds;
      if (!next) next = await iterator!.next();
      while (!next.done && next.value.timestamp <= sourceTimeSeconds + CANVAS_TIMESTAMP_EPSILON_SECONDS) {
        previous = next.value;
        next = await iterator!.next();
      }
      return previous && previous.timestamp <= sourceTimeSeconds + CANVAS_TIMESTAMP_EPSILON_SECONDS ? previous : null;
    },
    async dispose() {
      if (iterator?.return) await iterator.return().catch(() => undefined);
      iterator = null;
      previous = null;
      next = null;
    },
  };
}

export interface VideoFrameReader {
  /** Returns the last presentation-order source frame whose start timestamp is <= sourceTimeSeconds. */
  getCanvasAt(sourceTimeSeconds: number): Promise<WrappedCanvas | null>;
  dispose(): Promise<void>;
}

/**
 * Opens a browser-local Blob as a timestamp-addressable source. CanvasSink decodes actual presentation samples
 * and applies container rotation/display geometry before returning a canvas. Frames are streamed in presentation
 * order with one-frame lookahead so exact timestamps still resolve without waiting for a later query.
 */
export async function openVideoFrameReader(blob: Blob): Promise<VideoFrameReader> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('The selected source contains no decodable video track.');
    const sink = new CanvasSink(track, { alpha: false, poolSize: 2 });
    const cursor = createOrderedCanvasCursor(() => sink.canvases());
    return {
      getCanvasAt: (sourceTimeSeconds) => cursor.getCanvasAt(sourceTimeSeconds),
      async dispose() {
        await cursor.dispose();
        input.dispose();
      },
    };
  } catch (error) {
    input.dispose();
    throw error;
  }
}

/** The active video clip is the highest-index visible video track at the requested timeline time. */
export function selectActiveVideoClip(
  clips: readonly TimelineClip[],
  tracks: readonly Track[],
  timelineTimeSeconds: number,
  hiddenTrackIds: Readonly<Record<string, boolean>> = {},
): TimelineClip | null {
  if (!Number.isFinite(timelineTimeSeconds)) return null;
  return clips
    .filter((clip) => !hiddenTrackIds[clip.trackId]
      && timelineTimeSeconds >= clip.start - 1e-9
      && timelineTimeSeconds < clipEnd(clip) - 1e-9)
    .sort((left, right) => tracks.findIndex((track) => track.id === right.trackId) - tracks.findIndex((track) => track.id === left.trackId))[0] ?? null;
}

export function sourceTimeForTimelineClip(clip: TimelineClip, timelineTimeSeconds: number): number {
  return clip.trimIn + timelineTimeSeconds - clip.start;
}

/** Clears to black, then aspect-fits a decoded frame without cropping or stretching. */
export function drawLetterboxedVideoFrame(
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  width: number,
  height: number,
  source: TimelineCanvas | null,
): void {
  context.fillStyle = '#000';
  context.fillRect(0, 0, width, height);
  if (!source || source.width <= 0 || source.height <= 0) return;
  const scale = Math.min(width / source.width, height / source.height);
  const drawWidth = source.width * scale;
  const drawHeight = source.height * scale;
  context.drawImage(source, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
}
