import { describe, expect, it, vi } from 'vitest';
import type { TimelineClip, Track } from './projectDocument';
import { drawLetterboxedVideoFrame, selectActiveVideoClip, sourceTimeForTimelineClip } from './timelineVideoFrames';

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

  it('leaves offline clips and timeline gaps black', () => {
    const fillRect = vi.fn();
    const drawImage = vi.fn();
    const context = { fillStyle: '', fillRect, drawImage } as unknown as CanvasRenderingContext2D;
    drawLetterboxedVideoFrame(context, 320, 180, null);
    expect(fillRect).toHaveBeenCalledWith(0, 0, 320, 180);
    expect(drawImage).not.toHaveBeenCalled();
  });
});
