import { ALL_FORMATS, BlobSource, CanvasSink, Input } from 'mediabunny';
import type { WrappedCanvas } from 'mediabunny';
import type { TimelineClip, Track } from './projectDocument';
import { clipEnd } from './timelineOperations';

export type TimelineCanvas = HTMLCanvasElement | OffscreenCanvas;

interface TimestampQueue extends AsyncIterable<number>, AsyncIterator<number> {
  push(timestamp: number): void;
  close(): void;
}

function createTimestampQueue(): TimestampQueue {
  const values: number[] = [];
  const waiters: Array<(result: IteratorResult<number>) => void> = [];
  let closed = false;
  return {
    [Symbol.asyncIterator]() { return this; },
    next() {
      if (values.length) return Promise.resolve({ value: values.shift()!, done: false });
      if (closed) return Promise.resolve({ value: undefined, done: true });
      return new Promise<IteratorResult<number>>((resolve) => waiters.push(resolve));
    },
    return() {
      closed = true;
      for (const resolve of waiters.splice(0)) resolve({ value: undefined, done: true });
      return Promise.resolve({ value: undefined, done: true });
    },
    push(timestamp) {
      if (closed) throw new Error('Cannot request a frame from a closed decoder iterator.');
      const resolve = waiters.shift();
      if (resolve) resolve({ value: timestamp, done: false });
      else values.push(timestamp);
    },
    close() {
      closed = true;
      values.length = 0;
      for (const resolve of waiters.splice(0)) resolve({ value: undefined, done: true });
    },
  };
}

export interface VideoFrameReader {
  /** Returns the last presentation-order source frame whose timestamp is <= sourceTimeSeconds. */
  getCanvasAt(sourceTimeSeconds: number): Promise<WrappedCanvas | null>;
  dispose(): Promise<void>;
}

/**
 * Opens a browser-local Blob as a timestamp-addressable source. CanvasSink decodes actual presentation samples
 * and applies container rotation/display geometry before returning a canvas. Requests are streamed in timestamp
 * order so Mediabunny can reuse decoder work; a backwards source-time jump cleanly starts a new decoder iterator.
 */
export async function openVideoFrameReader(blob: Blob): Promise<VideoFrameReader> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('The selected source contains no decodable video track.');
    const sink = new CanvasSink(track, { alpha: false, poolSize: 1 });
    let queue: TimestampQueue | null = null;
    let iterator: AsyncGenerator<WrappedCanvas | null, void, unknown> | null = null;
    let lastTimestamp = -Infinity;
    const resetIterator = async () => {
      queue?.close();
      if (iterator) await iterator.return?.().catch(() => undefined);
      queue = createTimestampQueue();
      iterator = sink.canvasesAtTimestamps(queue);
      lastTimestamp = -Infinity;
    };
    return {
      async getCanvasAt(sourceTimeSeconds) {
        if (!Number.isFinite(sourceTimeSeconds) || sourceTimeSeconds < 0) {
          throw new RangeError('Source frame time must be a finite, non-negative number.');
        }
        if (!iterator || sourceTimeSeconds < lastTimestamp) await resetIterator();
        lastTimestamp = sourceTimeSeconds;
        const nextCanvas = iterator!.next();
        queue!.push(sourceTimeSeconds);
        const result = await nextCanvas;
        return result.done ? null : result.value;
      },
      async dispose() {
        queue?.close();
        input.dispose();
        if (iterator) await iterator.return?.().catch(() => undefined);
        iterator = null;
        queue = null;
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
