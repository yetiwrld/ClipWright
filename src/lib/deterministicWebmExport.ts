import {
  ALL_FORMATS,
  AudioBufferSource,
  BufferSource,
  BufferTarget,
  CanvasSource,
  EncodedPacketSink,
  Input,
  Output,
  WebMOutputFormat,
} from 'mediabunny';
import type { VideoTrackMetadata } from 'mediabunny';
import { frameDurationMicroseconds, frameTimestampMicroseconds, MICROSECONDS_PER_SECOND } from './frameTime';
import type { RationalFrameRate } from './frameTime';

export type { RationalFrameRate } from './frameTime';

export interface SequenceExportPlan {
  frameRate: RationalFrameRate;
  frameCount: number;
  durationSeconds: number;
  frameDurationSeconds: number;
  timestampMicroseconds(frameIndex: number): number;
  timestampSeconds(frameIndex: number): number;
  frameDurationAt(frameIndex: number): number;
}

export interface FramePipelineCounts {
  requested: number;
  rendered: number;
  submitted: number;
}

export interface CompleteExportFrameCounts extends FramePipelineCounts {
  encoded: number;
  outputFile: number;
}

export interface EncodedFileMeasurements {
  outputVideoFrames: number;
  outputVideoDurationSeconds: number;
  outputVideoFrameRate: number;
  outputAudioDurationSeconds: number | null;
  outputContainerDurationSeconds: number;
  mimeType: string;
}

export interface DeterministicWebmOptions {
  canvas: HTMLCanvasElement;
  plan: SequenceExportPlan;
  videoBitrate: number;
  audioBitrate: number;
  includeAudio: boolean;
  signal: AbortSignal;
  drawFrame(frameIndex: number, timestampSeconds: number): Promise<void>;
  renderAudioChunk?(startSeconds: number, durationSeconds: number): Promise<AudioBuffer>;
  onProgress?(counts: FramePipelineCounts & { encoded: number }): void;
}

export interface DeterministicWebmResult {
  buffer: ArrayBuffer;
  counts: FramePipelineCounts & { encoded: number };
  measurements: EncodedFileMeasurements;
}

export function createSequenceExportPlan(frameCount: number, frameRate: RationalFrameRate): SequenceExportPlan {
  if (!Number.isSafeInteger(frameCount) || frameCount < 0) throw new Error('Sequence frame count must be a non-negative integer.');
  if (!Number.isSafeInteger(frameRate.numerator) || frameRate.numerator <= 0 || !Number.isSafeInteger(frameRate.denominator) || frameRate.denominator <= 0) {
    throw new Error('Sequence frame rate must be a positive rational number.');
  }
  const frameDurationSeconds = frameRate.denominator / frameRate.numerator;
  const assertFrameIndex = (frameIndex: number) => {
    if (!Number.isSafeInteger(frameIndex) || frameIndex < 0 || frameIndex >= frameCount) throw new RangeError('Frame index is outside the active sequence.');
  };
  return {
    frameRate: { ...frameRate },
    frameCount,
    durationSeconds: frameCount * frameDurationSeconds,
    frameDurationSeconds,
    timestampMicroseconds: (frameIndex) => {
      assertFrameIndex(frameIndex);
      return frameTimestampMicroseconds(frameIndex, frameRate);
    },
    timestampSeconds: (frameIndex) => {
      assertFrameIndex(frameIndex);
      return frameTimestampMicroseconds(frameIndex, frameRate) / MICROSECONDS_PER_SECOND;
    },
    frameDurationAt: (frameIndex) => {
      assertFrameIndex(frameIndex);
      return frameDurationMicroseconds(frameIndex, frameRate) / MICROSECONDS_PER_SECOND;
    },
  };
}

/** End-exclusive endpoint rule: include the frame containing any non-aligned endpoint. */
export { frameCountForEndTime } from './frameTime';

export async function runExactFramePipeline(
  plan: SequenceExportPlan,
  drawFrame: (frameIndex: number, timestampSeconds: number) => Promise<void>,
  submitFrame: (frameIndex: number, timestampSeconds: number, durationSeconds: number) => Promise<void>,
  options: { signal?: AbortSignal; onProgress?: (counts: FramePipelineCounts) => void } = {},
): Promise<FramePipelineCounts> {
  const counts: FramePipelineCounts = { requested: 0, rendered: 0, submitted: 0 };
  for (let frameIndex = 0; frameIndex < plan.frameCount; frameIndex += 1) {
    if (options.signal?.aborted) throw new DOMException('Export cancelled.', 'AbortError');
    const timestampSeconds = plan.timestampSeconds(frameIndex);
    counts.requested += 1;
    await drawFrame(frameIndex, timestampSeconds);
    counts.rendered += 1;
    if (options.signal?.aborted) throw new DOMException('Export cancelled.', 'AbortError');
    await submitFrame(frameIndex, timestampSeconds, plan.frameDurationAt(frameIndex));
    counts.submitted += 1;
    options.onProgress?.({ ...counts });
  }
  if (options.signal?.aborted) throw new DOMException('Export cancelled.', 'AbortError');
  return counts;
}

export function areExportFrameCountsExact(expectedFrames: number, counts: CompleteExportFrameCounts): boolean {
  return Number.isSafeInteger(expectedFrames) && expectedFrames >= 0
    && counts.requested === expectedFrames
    && counts.rendered === expectedFrames
    && counts.submitted === expectedFrames
    && counts.encoded === expectedFrames
    && counts.outputFile === expectedFrames;
}

export async function encodeDeterministicWebm(options: DeterministicWebmOptions): Promise<DeterministicWebmResult> {
  if (options.signal.aborted) throw new DOMException('Export cancelled.', 'AbortError');
  if (typeof VideoEncoder === 'undefined') throw new Error('This browser does not support deterministic WebCodecs video encoding. Use an up-to-date Chromium-based browser.');
  if (options.includeAudio && typeof AudioEncoder === 'undefined') throw new Error('This browser does not support deterministic WebCodecs audio encoding.');

  const target = new BufferTarget();
  const output = new Output({ format: new WebMOutputFormat(), target });
  let encoded = 0;
  const counts: FramePipelineCounts = { requested: 0, rendered: 0, submitted: 0 };
  const videoSource = new CanvasSource(options.canvas, {
    codec: 'vp9',
    bitrate: options.videoBitrate,
    keyFrameInterval: 2,
    onEncodedPacket: () => {
      encoded += 1;
      options.onProgress?.({ requested: counts.requested, rendered: counts.rendered, submitted: counts.submitted, encoded });
    },
  });
  const frameRate = options.plan.frameRate.numerator / options.plan.frameRate.denominator;
  output.addVideoTrack(videoSource, { frameRate } satisfies VideoTrackMetadata);

  let audioSource: AudioBufferSource | null = null;
  if (options.includeAudio) {
    if (!options.renderAudioChunk) throw new Error('Audio rendering was requested without a sequence audio renderer.');
    audioSource = new AudioBufferSource({ codec: 'opus', bitrate: options.audioBitrate });
    output.addAudioTrack(audioSource);
  }

  try {
    await output.start();
    const videoRun = runExactFramePipeline(
      options.plan,
      async (frameIndex, timestampSeconds) => {
        if (options.signal.aborted) throw new DOMException('Export cancelled.', 'AbortError');
        await options.drawFrame(frameIndex, timestampSeconds);
      },
      async (_frameIndex, timestampSeconds, durationSeconds) => {
        if (options.signal.aborted) throw new DOMException('Export cancelled.', 'AbortError');
        await videoSource.add(timestampSeconds, durationSeconds);
      },
      {
        signal: options.signal,
        onProgress: (next) => {
          counts.requested = next.requested;
          counts.rendered = next.rendered;
          counts.submitted = next.submitted;
          options.onProgress?.({ ...counts, encoded });
        },
      },
    );

    const audioRun = audioSource ? (async () => {
      const chunkSeconds = 0.5;
      for (let startSeconds = 0; startSeconds < options.plan.durationSeconds - 1e-9; startSeconds += chunkSeconds) {
        if (options.signal.aborted) throw new DOMException('Export cancelled.', 'AbortError');
        const durationSeconds = Math.min(chunkSeconds, options.plan.durationSeconds - startSeconds);
        const audioBuffer = await options.renderAudioChunk!(startSeconds, durationSeconds);
        if (options.signal.aborted) throw new DOMException('Export cancelled.', 'AbortError');
        await audioSource!.add(audioBuffer);
      }
    })() : Promise.resolve();

    await Promise.all([videoRun, audioRun]);
    if (options.signal.aborted) throw new DOMException('Export cancelled.', 'AbortError');
    await output.finalize();
    if (options.signal.aborted) throw new DOMException('Export cancelled.', 'AbortError');
    if (!target.buffer) throw new Error('The WebM muxer finalized without producing an output file.');

    const measurements = await inspectEncodedWebm(target.buffer);
    return { buffer: target.buffer, counts: { ...counts, encoded }, measurements };
  } catch (error) {
    await output.cancel().catch(() => undefined);
    throw error;
  }
}

export async function inspectEncodedWebm(buffer: ArrayBuffer): Promise<EncodedFileMeasurements> {
  const input = new Input({ source: new BufferSource(buffer), formats: ALL_FORMATS });
  try {
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) throw new Error('The finalized WebM file contains no video track.');
    let outputVideoFrames = 0;
    const packetSink = new EncodedPacketSink(videoTrack);
    for await (const _packet of packetSink.packets()) outputVideoFrames += 1;
    const outputVideoDurationSeconds = await videoTrack.computeDuration();
    const audioTrack = await input.getPrimaryAudioTrack();
    const outputAudioDurationSeconds = audioTrack ? await audioTrack.computeDuration() : null;
    const outputContainerDurationSeconds = await input.computeDuration();
    return {
      outputVideoFrames,
      outputVideoDurationSeconds,
      outputVideoFrameRate: outputVideoDurationSeconds > 0 ? outputVideoFrames / outputVideoDurationSeconds : 0,
      outputAudioDurationSeconds,
      outputContainerDurationSeconds,
      mimeType: await input.getMimeType(),
    };
  } finally {
    input.dispose();
  }
}
