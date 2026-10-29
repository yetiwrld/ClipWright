import { ALL_FORMATS, BlobSource, Input } from 'mediabunny';

export type BrowserVideoMetadata = {
  durationSeconds: number;
  durationTicks: number;
  timeBase: { numerator: 1; denominator: 1_000_000 };
  width: number;
  height: number;
};

export type BrowserAudioMetadata = {
  durationSeconds: number;
  durationTicks: number;
  timeBase: { numerator: 1; denominator: 1_000_000 };
  sampleRate?: number;
  channels?: number;
};

const MICROSECONDS_PER_SECOND = 1_000_000;
const MAX_DIMENSION = 16384;

/** Read browser-decodable local video metadata without uploading or copying the source file. */
export function probeBrowserVideo(url: string): Promise<BrowserVideoMetadata> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    let settled = false;
    const timeout = window.setTimeout(() => finish(new Error('The browser did not finish reading video metadata within 30 seconds.')), 30_000);
    const finish = (error?: Error, result?: BrowserVideoMetadata) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      video.removeEventListener('loadedmetadata', onLoaded);
      video.removeEventListener('error', onError);
      try { video.removeAttribute('src'); video.load(); } catch { /* Release the decoder when supported; retain the probe result either way. */ }
      if (error) reject(error);
      else if (result) resolve(result);
      else reject(new Error('The browser returned no video metadata.'));
    };
    const onLoaded = () => {
      const { duration, videoWidth: width, videoHeight: height } = video;
      const durationTicks = Math.round(duration * MICROSECONDS_PER_SECOND);
      if (!Number.isFinite(duration) || duration <= 0 || !Number.isSafeInteger(durationTicks) || durationTicks <= 0) {
        finish(new Error('This video has no finite, readable duration.'));
        return;
      }
      if (!Number.isInteger(width) || !Number.isInteger(height) || width < 16 || height < 16 || width > MAX_DIMENSION || height > MAX_DIMENSION) {
        finish(new Error('The browser returned invalid or unsupported video dimensions.'));
        return;
      }
      finish(undefined, {
        durationSeconds: duration,
        durationTicks,
        timeBase: { numerator: 1, denominator: MICROSECONDS_PER_SECOND },
        width,
        height,
      });
    };
    const onError = () => finish(new Error('This browser could not decode the selected video. Try an MP4/H.264 or WebM file supported by your browser.'));
    try {
      video.preload = 'metadata';
      video.addEventListener('loadedmetadata', onLoaded, { once: true });
      video.addEventListener('error', onError, { once: true });
      video.src = url;
      video.load();
    } catch (error) {
      finish(error instanceof Error ? error : new Error('The browser could not open this video source.'));
    }
  });
}

/** Inspect container metadata for an audio stream embedded in a local video, without decoding the whole file. */
export async function probeBrowserVideoAudio(file: Blob, fallbackDurationSeconds: number): Promise<BrowserAudioMetadata | null> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) return null;
    const metadataDuration = await track.getDurationFromMetadata();
    const durationSeconds = Number.isFinite(metadataDuration) && metadataDuration !== null && metadataDuration > 0
      ? metadataDuration
      : fallbackDurationSeconds;
    const durationTicks = Math.round(durationSeconds * MICROSECONDS_PER_SECOND);
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || !Number.isSafeInteger(durationTicks) || durationTicks <= 0) {
      throw new Error('The embedded video audio track has no finite, readable duration.');
    }
    const [sampleRate, channels] = await Promise.all([track.getSampleRate(), track.getNumberOfChannels()]);
    return {
      durationSeconds,
      durationTicks,
      timeBase: { numerator: 1, denominator: MICROSECONDS_PER_SECOND },
      ...(Number.isInteger(sampleRate) && sampleRate >= 8_000 && sampleRate <= 384_000 ? { sampleRate } : {}),
      ...(Number.isInteger(channels) && channels >= 1 && channels <= 128 ? { channels } : {}),
    };
  } finally {
    input.dispose();
  }
}

/** Read the duration of a browser-decodable local audio file without decoding it into memory. */
export function probeBrowserAudio(url: string): Promise<BrowserAudioMetadata> {
  return new Promise((resolve, reject) => {
    const audio = document.createElement('audio');
    let settled = false;
    const timeout = window.setTimeout(() => finish(new Error('The browser did not finish reading audio metadata within 30 seconds.')), 30_000);
    const finish = (error?: Error, result?: BrowserAudioMetadata) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      audio.removeEventListener('loadedmetadata', onLoaded);
      audio.removeEventListener('error', onError);
      try { audio.removeAttribute('src'); audio.load(); } catch { /* Release the decoder when supported; retain the probe result either way. */ }
      if (error) reject(error);
      else if (result) resolve(result);
      else reject(new Error('The browser returned no audio metadata.'));
    };
    const onLoaded = () => {
      const durationSeconds = audio.duration;
      const durationTicks = Math.round(durationSeconds * MICROSECONDS_PER_SECOND);
      if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || !Number.isSafeInteger(durationTicks) || durationTicks <= 0) {
        finish(new Error('This audio file has no finite, readable duration.'));
        return;
      }
      finish(undefined, {
        durationSeconds,
        durationTicks,
        timeBase: { numerator: 1, denominator: MICROSECONDS_PER_SECOND },
      });
    };
    const onError = () => finish(new Error('This browser could not decode the selected audio file. Try an MP3, WAV, AAC, or Ogg file supported by your browser.'));
    try {
      audio.preload = 'metadata';
      audio.addEventListener('loadedmetadata', onLoaded, { once: true });
      audio.addEventListener('error', onError, { once: true });
      audio.src = url;
      audio.load();
    } catch (error) {
      finish(error instanceof Error ? error : new Error('The browser could not open this audio source.'));
    }
  });
}
