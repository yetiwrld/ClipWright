import { afterEach, describe, expect, it, vi } from 'vitest';

const audioProbeMock = vi.hoisted(() => ({
  track: null as unknown,
  source: null as unknown,
  dispose: vi.fn(),
}));

vi.mock('mediabunny', () => ({
  ALL_FORMATS: [],
  BlobSource: class { constructor(readonly blob: Blob) {} },
  Input: class {
    constructor(options: { source: unknown }) { audioProbeMock.source = options.source; }
    async getPrimaryAudioTrack() { return audioProbeMock.track; }
    dispose() { audioProbeMock.dispose(); }
  },
}));

import { probeBrowserAudio, probeBrowserVideo, probeBrowserVideoAudio } from './browserMedia';

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

  it('detects and records audio streams embedded in video files for export', async () => {
    const file = new File(['video with embedded audio'], 'with-audio.mp4', { type: 'video/mp4' });
    const track = {
      getDurationFromMetadata: vi.fn().mockResolvedValue(7.5),
      getSampleRate: vi.fn().mockResolvedValue(48_000),
      getNumberOfChannels: vi.fn().mockResolvedValue(2),
    };
    audioProbeMock.track = track;
    audioProbeMock.source = null;
    audioProbeMock.dispose.mockClear();

    await expect(probeBrowserVideoAudio(file, 8)).resolves.toEqual({
      durationSeconds: 7.5,
      durationTicks: 7_500_000,
      timeBase: { numerator: 1, denominator: 1_000_000 },
      sampleRate: 48_000,
      channels: 2,
    });
    expect(audioProbeMock.source).toMatchObject({ blob: file });
    expect(audioProbeMock.dispose).toHaveBeenCalledTimes(1);
  });

  it('returns no audio stream for a silent video and still releases the media input', async () => {
    audioProbeMock.track = null;
    audioProbeMock.dispose.mockClear();

    await expect(probeBrowserVideoAudio(new File(['silent video'], 'silent.mp4'), 3)).resolves.toBeNull();
    expect(audioProbeMock.dispose).toHaveBeenCalledTimes(1);
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
