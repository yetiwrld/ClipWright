export type BrowserVideoMetadata = {
  durationSeconds: number;
  durationTicks: number;
  timeBase: { numerator: 1; denominator: 1_000_000 };
  width: number;
  height: number;
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
      video.removeAttribute('src');
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
