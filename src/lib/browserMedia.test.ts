import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeBrowserAudio, probeBrowserVideo } from './browserMedia';

describe('browser video metadata probe', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it('reports decoded dimensions and an explicitly microsecond-based browser duration', async () => {
    const originalCreateElement = document.createElement.bind(document);
    const video = originalCreateElement('video');
    Object.defineProperties(video, {
      duration: { configurable: true, value: 12.345678 },
      videoWidth: { configurable: true, value: 1920 },
      videoHeight: { configurable: true, value: 1080 },
    });
    vi.spyOn(document, 'createElement').mockImplementation(((tagName: string, options?: ElementCreationOptions) => tagName === 'video' ? video : originalCreateElement(tagName, options)) as typeof document.createElement);
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(function (this: HTMLMediaElement) {
      window.setTimeout(() => this.dispatchEvent(new Event('loadedmetadata')), 0);
    });

    await expect(probeBrowserVideo('blob:local-media')).resolves.toEqual({
      durationSeconds: 12.345678,
      durationTicks: 12_345_678,
      timeBase: { numerator: 1, denominator: 1_000_000 },
      width: 1920,
      height: 1080,
    });
  });

  it('rejects incomplete browser metadata instead of saving invalid dimensions', async () => {
    const originalCreateElement = document.createElement.bind(document);
    const video = originalCreateElement('video');
    Object.defineProperties(video, {
      duration: { configurable: true, value: 2 },
      videoWidth: { configurable: true, value: 0 },
      videoHeight: { configurable: true, value: 1080 },
    });
    vi.spyOn(document, 'createElement').mockImplementation(((tagName: string, options?: ElementCreationOptions) => tagName === 'video' ? video : originalCreateElement(tagName, options)) as typeof document.createElement);
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(function (this: HTMLMediaElement) {
      window.setTimeout(() => this.dispatchEvent(new Event('loadedmetadata')), 0);
    });

    await expect(probeBrowserVideo('blob:bad-dimensions')).rejects.toThrow('invalid or unsupported video dimensions');
  });

  it('returns an actionable error when the browser decoder rejects the source', async () => {
    const originalCreateElement = document.createElement.bind(document);
    const video = originalCreateElement('video');
    vi.spyOn(document, 'createElement').mockImplementation(((tagName: string, options?: ElementCreationOptions) => tagName === 'video' ? video : originalCreateElement(tagName, options)) as typeof document.createElement);
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(function (this: HTMLMediaElement) {
      window.setTimeout(() => this.dispatchEvent(new Event('error')), 0);
    });

    await expect(probeBrowserVideo('blob:unsupported')).rejects.toThrow('could not decode the selected video');
  });

  it('rejects a zero-length audio source instead of saving an unusable asset', async () => {
    const originalCreateElement = document.createElement.bind(document);
    const audio = originalCreateElement('audio');
    Object.defineProperty(audio, 'duration', { configurable: true, value: 0 });
    vi.spyOn(document, 'createElement').mockImplementation(((tagName: string, options?: ElementCreationOptions) => tagName === 'audio' ? audio : originalCreateElement(tagName, options)) as typeof document.createElement);
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(function (this: HTMLMediaElement) {
      window.setTimeout(() => this.dispatchEvent(new Event('loadedmetadata')), 0);
    });

    await expect(probeBrowserAudio('blob:empty-audio')).rejects.toThrow('no finite, readable duration');
  });

  it('times out and cleans up when the browser never returns metadata', async () => {
    vi.useFakeTimers();
    const originalCreateElement = document.createElement.bind(document);
    const video = originalCreateElement('video');
    vi.spyOn(document, 'createElement').mockImplementation(((tagName: string, options?: ElementCreationOptions) => tagName === 'video' ? video : originalCreateElement(tagName, options)) as typeof document.createElement);
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
    const pending = probeBrowserVideo('blob:never-loaded');
    const expectedRejection = expect(pending).rejects.toThrow('within 30 seconds');
    await vi.advanceTimersByTimeAsync(30_000);
    await expectedRejection;
  });
});
