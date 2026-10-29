import { describe, expect, it, vi } from 'vitest';
import type { WrappedCanvas } from 'mediabunny';
import type { TimelineClip, Track } from './projectDocument';
import { createOrderedCanvasCursor, drawLetterboxedVideoFrame, selectActiveVideoClip, sourceTimeForTimelineClip } from './timelineVideoFrames';

const lower: Track = { id: 'v1', name: 'Video 1', kind: 'video', muted: false, locked: false, clips: [] };
const upper: Track = { id: 'v2', name: 'Video 2', kind: 'video', muted: false, locked: false, clips: [] };
const clip = (id: string, trackId: string, start: number, trimIn: number, trimOut: number): TimelineClip => ({
  id, sourceId: `${id}-source`, trackId, start, trimIn, trimOut,
});

describe('timeline video frame selection and draw policy', () => {
  it('uses half-open clip intervals and picks the next adjacent clip at the exact cut', () => {
    const first = clip('first', lower.id, 0, 2, 3);
    const second = clip('second', lower.id, 1, 7, 8);
    expect(selectActiveVideoClip([first, second], [lower], 1)?.id).toBe('second');
    expect(selectActiveVideoClip([first, second], [lower], 2)).toBeNull();
  });

  it('keeps microsecond-rounded frame timestamps on the correct side of exact clip cuts', () => {
    const boundary = 40 / 30;
    const first = clip('first', lower.id, 0, 0, boundary);
    const second = clip('second', lower.id, boundary, 0, 1 / 30);
    const roundedBoundaryTimestamp = Math.round(boundary * 1_000_000) / 1_000_000;
    expect(selectActiveVideoClip([first, second], [lower], roundedBoundaryTimestamp)?.id).toBe('second');
  });

  it('uses the topmost unhidden video track for overlaps and reveals the lower clip when hidden', () => {
    const base = clip('base', lower.id, 0, 0, 4);
    const overlay = clip('overlay', upper.id, 1, 3, 6);
    expect(selectActiveVideoClip([base, overlay], [lower, upper], 2)?.id).toBe('overlay');
    expect(selectActiveVideoClip([base, overlay], [lower, upper], 2, { [upper.id]: true })?.id).toBe('base');
  });

  it('maps a timeline time to the source timestamp using clip start and trim-in', () => {
    const trimmed = clip('trimmed', lower.id, 4, 12.5, 16.5);
    expect(sourceTimeForTimelineClip(trimmed, 5.25)).toBe(13.75);
  });

  it('resolves exact rounded frame timestamps with one-frame lookahead and resets on backward source time', async () => {
    const frames: WrappedCanvas[] = Array.from({ length: 9 }, (_, index) => ({
      canvas: { width: 16, height: 9 } as HTMLCanvasElement,
      timestamp: Math.round(index / 30 * 1_000_000) / 1_000_000,
      duration: 1 / 30,
    }));
    let iteratorCreations = 0;
    let reads = 0;
    const cursor = createOrderedCanvasCursor(() => {
      iteratorCreations += 1;
      let index = 0;
      return {
        next: async () => {
          reads += 1;
          return index < frames.length
            ? { done: false as const, value: frames[index++] }
            : { done: true as const, value: undefined };
        },
        return: async () => ({ done: true as const, value: undefined }),
      };
    });

    const exactRationalTimestamp = 5 / 30;
    expect(await cursor.getCanvasAt(exactRationalTimestamp)).toBe(frames[5]);
    const readsAfterBoundary = reads;
    expect(await cursor.getCanvasAt(exactRationalTimestamp)).toBe(frames[5]);
    expect(reads).toBe(readsAfterBoundary);
    expect(await cursor.getCanvasAt(1 / 30)).toBe(frames[1]);
    expect(iteratorCreations).toBe(2);
    await cursor.dispose();
  });

  it('returns null for a timestamp before the first source frame', async () => {
    const cursor = createOrderedCanvasCursor(() => ({
      next: async () => ({ done: false as const, value: { canvas: {} as HTMLCanvasElement, timestamp: 0.1, duration: 1 / 30 } }),
      return: async () => ({ done: true as const, value: undefined }),
    }));
    expect(await cursor.getCanvasAt(0)).toBeNull();
    await cursor.dispose();
  });

  it('clears every output frame to black and aspect-fits decoded source frames', () => {
    const fillRect = vi.fn();
    const drawImage = vi.fn();
    const context = { fillStyle: '', fillRect, drawImage } as unknown as CanvasRenderingContext2D;
    const source = { width: 200, height: 100 } as HTMLCanvasElement;
    drawLetterboxedVideoFrame(context, 100, 100, source);
    expect(context.fillStyle).toBe('#000');
    expect(fillRect).toHaveBeenCalledWith(0, 0, 100, 100);
    expect(drawImage).toHaveBeenCalledWith(source, 0, 25, 100, 50);
  });

  it('composes still-image bitmaps through the same fit policy as video frames', () => {
    const fillRect = vi.fn();
    const drawImage = vi.fn();
    const context = { fillStyle: '', fillRect, drawImage } as unknown as CanvasRenderingContext2D;
    const image = { width: 300, height: 300, close: vi.fn() } as unknown as ImageBitmap;
    drawLetterboxedVideoFrame(context, 160, 90, image, { fit: 'fit', background: '#101820' });
    expect(context.fillStyle).toBe('#101820');
    expect(fillRect).toHaveBeenCalledWith(0, 0, 160, 90);
    expect(drawImage).toHaveBeenCalledWith(image, 35, 0, 90, 90);
  });

  it('uses explicit fill cropping, stretch geometry, and project background colors', () => {
    const fillRect = vi.fn();
    const drawImage = vi.fn();
    const context = { fillStyle: '', fillRect, drawImage } as unknown as CanvasRenderingContext2D;
    const source = { width: 200, height: 100 } as HTMLCanvasElement;
    drawLetterboxedVideoFrame(context, 100, 100, source, { fit: 'fill', background: '#123456' });
    expect(context.fillStyle).toBe('#123456');
    expect(drawImage).toHaveBeenLastCalledWith(source, -50, 0, 200, 100);
    drawLetterboxedVideoFrame(context, 100, 100, source, { fit: 'stretch', background: '#abcdef' });
    expect(context.fillStyle).toBe('#abcdef');
    expect(drawImage).toHaveBeenLastCalledWith(source, 0, 0, 100, 100);
  });

  it('leaves offline clips and timeline gaps as the selected background', () => {
    const fillRect = vi.fn();
    const drawImage = vi.fn();
    const context = { fillStyle: '', fillRect, drawImage } as unknown as CanvasRenderingContext2D;
    drawLetterboxedVideoFrame(context, 320, 180, null, { background: '#123456' });
    expect(context.fillStyle).toBe('#123456');
    expect(fillRect).toHaveBeenCalledWith(0, 0, 320, 180);
    expect(drawImage).not.toHaveBeenCalled();
  });
});
