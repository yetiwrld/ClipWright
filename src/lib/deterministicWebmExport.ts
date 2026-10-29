import {
  ALL_FORMATS,
  AudioBufferSink,
  AudioBufferSource,
  BufferSource,
  BufferTarget,
  CanvasSink,
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

/** WebM/Matroska TimecodeScale used by Mediabunny's muxer: 1,000,000 ns = 1 ms. */
export const WEBM_TIMEBASE_SECONDS = 0.001;
/** WebCodecs Opus output uses 20 ms packets in the supported browser export path. */
export const OPUS_PACKET_DURATION_SECONDS = 0.020;
/** Average RGB error threshold for three tiny decoded frame probes; the encoded file is lossy. */
export const MAX_DECODED_PROBE_MEAN_ABSOLUTE_ERROR = 48;

export function videoTimestampToleranceSeconds(framePeriodSeconds: number, timebaseSeconds = WEBM_TIMEBASE_SECONDS) {
  return framePeriodSeconds / 2 + timebaseSeconds / 2;
}

export function audioOnsetToleranceSeconds(sampleRate: number, packetDurationSeconds = OPUS_PACKET_DURATION_SECONDS, timebaseSeconds = WEBM_TIMEBASE_SECONDS) {
  return packetDurationSeconds / 2 + timebaseSeconds / 2 + 1 / sampleRate;
}

export function audioDurationToleranceSeconds(sampleRate: number, packetDurationSeconds = OPUS_PACKET_DURATION_SECONDS, timebaseSeconds = WEBM_TIMEBASE_SECONDS) {
  return packetDurationSeconds + timebaseSeconds / 2 + 1 / sampleRate;
}

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
  outputFilePackets: number;
}

export interface DecodedVideoProbe {
  frameIndex: number;
  expectedTimestampSeconds: number;
  actualTimestampSeconds: number;
  timestampErrorSeconds: number;
  meanAbsolutePixelError: number;
  passed: boolean;
}

export interface EncodedFileMeasurements {
  /** Encoded packet count. Kept distinct from full decoded frame counts reported by CI. */
  outputVideoPackets: number;
  outputVideoPacketRate: number;
  outputVideoDurationSeconds: number;
  outputAudioPackets: number | null;
  outputAudioDurationSeconds: number | null;
  outputContainerDurationSeconds: number;
  videoTimeResolution: number;
  audioTimeResolution: number | null;
  outputAudioSampleRate: number | null;
  videoTimestampsMonotonic: boolean;
  firstVideoTimestampError: { packetIndex: number; expectedSeconds: number; actualSeconds: number; errorSeconds: number } | null;
  decodedSampleFrames: number;
  decodedVideoProbes: DecodedVideoProbe[];
  decodedAudioSampleBuffers: number;
  mimeType: string;
}

export interface DeterministicWebmOptions {
  canvas: HTMLCanvasElement;
  plan: SequenceExportPlan;
  videoBitrate: number;
  audioBitrate: number;
  includeAudio: boolean;
  signal: AbortSignal;
  hardwareAcceleration?: VideoEncoderConfig['hardwareAcceleration'];
  onEncoderConfig?(config: VideoEncoderConfig): void;
  onAudioEncoderConfig?(config: AudioEncoderConfig): void;
  drawFrame(frameIndex: number, timestampSeconds: number): Promise<void>;
  renderAudioChunk?(startSeconds: number, durationSeconds: number): Promise<AudioBuffer>;
  onProgress?(counts: FramePipelineCounts & { encoded: number }): void;
  onValidationStage?(stage: string): void;
}

export interface DeterministicWebmResult {
  buffer: ArrayBuffer;
  counts: FramePipelineCounts & { encoded: number };
  measurements: EncodedFileMeasurements;
}

interface ExpectedVideoProbe {
  frameIndex: number;
  expectedTimestampSeconds: number;
  queryTimestampSeconds: number;
  pixels: Uint8ClampedArray;
}

const DECODED_PROBE_SIZE = { width: 16, height: 9 };

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

/** End-exclusive endpoint rule: include the frame containing any non-frame-aligned endpoint. */
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
    && counts.outputFilePackets === expectedFrames;
}

function getProbeIndexes(frameCount: number): number[] {
  if (frameCount <= 0) return [];
  return [...new Set([0, Math.floor((frameCount - 1) / 2), frameCount - 1])];
}

function captureCanvasProbe(canvas: HTMLCanvasElement, frameIndex: number, timestampSeconds: number, frameDurationSeconds: number): ExpectedVideoProbe {
  const sample = document.createElement('canvas');
  sample.width = DECODED_PROBE_SIZE.width;
  sample.height = DECODED_PROBE_SIZE.height;
  const context = sample.getContext('2d', { alpha: false, willReadFrequently: true });
  if (!context) throw new Error('Could not capture the lightweight export frame-validation sample.');
  context.drawImage(canvas, 0, 0, sample.width, sample.height);
  return {
    frameIndex,
    expectedTimestampSeconds: timestampSeconds,
    // Query halfway into the frame so a 1 ms WebM timecode rounding step cannot select the prior frame.
    queryTimestampSeconds: timestampSeconds + frameDurationSeconds / 2,
    pixels: context.getImageData(0, 0, sample.width, sample.height).data,
  };
}

function meanAbsolutePixelError(expected: Uint8ClampedArray, actualCanvas: HTMLCanvasElement | OffscreenCanvas): number {
  const sample = document.createElement('canvas');
  sample.width = DECODED_PROBE_SIZE.width;
  sample.height = DECODED_PROBE_SIZE.height;
  const context = sample.getContext('2d', { alpha: false, willReadFrequently: true });
  if (!context) throw new Error('Could not inspect a decoded export frame sample.');
  context.drawImage(actualCanvas, 0, 0, sample.width, sample.height);
  const actual = context.getImageData(0, 0, sample.width, sample.height).data;
  let totalError = 0;
  for (let index = 0; index < actual.length; index += 4) {
    totalError += Math.abs(expected[index] - actual[index]);
    totalError += Math.abs(expected[index + 1] - actual[index + 1]);
    totalError += Math.abs(expected[index + 2] - actual[index + 2]);
  }
  return totalError / (actual.length / 4 * 3);
}

export async function encodeDeterministicWebm(options: DeterministicWebmOptions): Promise<DeterministicWebmResult> {
  if (options.signal.aborted) throw new DOMException('Export cancelled.', 'AbortError');
  if (options.plan.frameCount < 1) throw new Error('Cannot encode a sequence with zero video frames.');
  if (typeof VideoEncoder === 'undefined') throw new Error('This browser does not support deterministic WebCodecs video encoding. Use an up-to-date Chromium-based browser.');
  if (options.includeAudio && !options.renderAudioChunk) throw new Error('Audio rendering was requested without a sequence audio renderer.');
  if (options.includeAudio && typeof AudioEncoder === 'undefined') throw new Error('This browser does not support deterministic WebCodecs audio encoding.');

  const target = new BufferTarget();
  const output = new Output({ format: new WebMOutputFormat(), target });
  let encoded = 0;
  const counts: FramePipelineCounts = { requested: 0, rendered: 0, submitted: 0 };
  const probeIndexes = new Set(getProbeIndexes(options.plan.frameCount));
  const expectedProbes: ExpectedVideoProbe[] = [];
  let validationStage = 'encoding and muxing WebM';
  let finalizedMeasurements: EncodedFileMeasurements | null = null;
  let videoEncoderConfiguration: VideoEncoderConfig | null = null;
  let audioEncoderConfiguration: AudioEncoderConfig | null = null;
  const videoSource = new CanvasSource(options.canvas, {
    codec: 'vp9',
    bitrate: options.videoBitrate,
    keyFrameInterval: 2,
    hardwareAcceleration: options.hardwareAcceleration,
    onEncoderConfig: (config) => { videoEncoderConfiguration = config; options.onEncoderConfig?.(config); },
    onEncodedPacket: () => {
      encoded += 1;
      options.onProgress?.({ requested: counts.requested, rendered: counts.rendered, submitted: counts.submitted, encoded });
    },
  });
  const frameRate = options.plan.frameRate.numerator / options.plan.frameRate.denominator;
  output.addVideoTrack(videoSource, { frameRate } satisfies VideoTrackMetadata);

  let audioSource: AudioBufferSource | null = null;
  if (options.includeAudio) {
    audioSource = new AudioBufferSource({ codec: 'opus', bitrate: options.audioBitrate, onEncoderConfig: (config) => { audioEncoderConfiguration = config; options.onAudioEncoderConfig?.(config); } });
    output.addAudioTrack(audioSource);
  }

  try {
    await output.start();
    const videoRun = runExactFramePipeline(
      options.plan,
      async (frameIndex, timestampSeconds) => {
        if (options.signal.aborted) throw new DOMException('Export cancelled.', 'AbortError');
        await options.drawFrame(frameIndex, timestampSeconds);
        if (probeIndexes.has(frameIndex)) {
          expectedProbes.push(captureCanvasProbe(options.canvas, frameIndex, timestampSeconds, options.plan.frameDurationAt(frameIndex)));
        }
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
    if (!target.buffer || target.buffer.byteLength === 0) throw new Error('The WebM muxer finalized without producing a non-empty output file.');

    validationStage = 'checking finalized WebM packets, timestamps, decoded samples, and required tracks';
    options.onValidationStage?.(validationStage);
    const measurements = await inspectEncodedWebm(target.buffer, {
      plan: options.plan,
      expectedVideoProbes: expectedProbes,
      requireAudioTrack: options.includeAudio,
    });
    finalizedMeasurements = measurements;
    validationStage = 'validating finalized WebM contents';
    options.onValidationStage?.(validationStage);
    const frameCountsMatch = areExportFrameCountsExact(options.plan.frameCount, {
      ...counts,
      encoded,
      outputFilePackets: measurements.outputVideoPackets,
    });
    if (!frameCountsMatch) {
      throw new Error(`Finalized WebM packet-count validation failed: requested=${counts.requested}, rendered=${counts.rendered}, submitted=${counts.submitted}, encoded=${encoded}, outputPackets=${measurements.outputVideoPackets}, expectedFrames=${options.plan.frameCount}.`);
    }
    if (!measurements.videoTimestampsMonotonic || measurements.firstVideoTimestampError) {
      const first = measurements.firstVideoTimestampError;
      throw new Error(`Finalized WebM video timestamps are not a valid frame sequence${first ? `: packet ${first.packetIndex} expected ${first.expectedSeconds.toFixed(6)}s, got ${first.actualSeconds.toFixed(6)}s (error ${first.errorSeconds.toFixed(6)}s)` : ''}.`);
    }
    const failedProbe = measurements.decodedVideoProbes.find((probe) => !probe.passed);
    if (failedProbe) {
      throw new Error(`Finalized WebM decoded frame ${failedProbe.frameIndex} did not match the rendered sample (mean pixel error ${failedProbe.meanAbsolutePixelError.toFixed(2)}, timestamp error ${failedProbe.timestampErrorSeconds.toFixed(6)}s).`);
    }
    if (measurements.decodedSampleFrames !== expectedProbes.length) {
      throw new Error(`Finalized WebM decoded ${measurements.decodedSampleFrames}/${expectedProbes.length} required video validation samples.`);
    }
    if (options.includeAudio && (measurements.outputAudioPackets === null || measurements.outputAudioDurationSeconds === null || measurements.decodedAudioSampleBuffers < 1)) {
      throw new Error('Audio was included in this export, but the finalized WebM is missing a readable audio track or decoded audio samples.');
    }
    return { buffer: target.buffer, counts: { ...counts, encoded }, measurements };
  } catch (error) {
    await output.cancel().catch(() => undefined);
    const isAbort = error instanceof DOMException && error.name === 'AbortError';
    if (!isAbort && error instanceof Error) {
      Object.assign(error, {
        exportDiagnostics: {
          stage: validationStage,
          counts: { ...counts, encoded },
          measurements: finalizedMeasurements,
          outputBytes: target.buffer?.byteLength ?? null,
          expectedFrames: options.plan.frameCount,
          expectedDurationSeconds: options.plan.durationSeconds,
          includeAudio: options.includeAudio,
          videoEncoderConfiguration,
          audioEncoderConfiguration,
          sourceMediaIncluded: false,
        },
      });
    }
    throw error;
  }
}

export async function inspectEncodedWebm(
  buffer: ArrayBuffer,
  options: { plan?: SequenceExportPlan; expectedVideoProbes?: ExpectedVideoProbe[]; requireAudioTrack?: boolean } = {},
): Promise<EncodedFileMeasurements> {
  if (buffer.byteLength === 0) throw new Error('The finalized WebM is empty.');
  const input = new Input({ source: new BufferSource(buffer), formats: ALL_FORMATS });
  try {
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) throw new Error('The finalized WebM file contains no readable video track.');
    const videoTimeResolution = await videoTrack.getTimeResolution();
    if (!Number.isFinite(videoTimeResolution) || videoTimeResolution <= 0) throw new Error('The finalized WebM video track reports an invalid timestamp resolution.');
    const packetSink = new EncodedPacketSink(videoTrack);
    let outputVideoPackets = 0;
    let previousTimestampSeconds = -Infinity;
    let videoTimestampsMonotonic = true;
    let firstVideoTimestampError: EncodedFileMeasurements['firstVideoTimestampError'] = null;
    const videoTimebaseSeconds = 1 / videoTimeResolution;
    if (options.plan && Math.abs(videoTimebaseSeconds - WEBM_TIMEBASE_SECONDS) > 1e-9) {
      // Timebase is reported below and used directly; do not assume every muxer revision keeps 1 ms ticks.
    }
    for await (const packet of packetSink.packets()) {
      const packetIndex = outputVideoPackets;
      const timestampSeconds = packet.timestamp;
      if (!Number.isFinite(timestampSeconds) || timestampSeconds <= previousTimestampSeconds) videoTimestampsMonotonic = false;
      previousTimestampSeconds = timestampSeconds;
      if (options.plan && !firstVideoTimestampError) {
        const packetIndexIsExtra = packetIndex >= options.plan.frameCount;
        const expectedSeconds = packetIndexIsExtra ? options.plan.durationSeconds : options.plan.timestampSeconds(packetIndex);
        const errorSeconds = timestampSeconds - expectedSeconds;
        const tolerance = videoTimestampToleranceSeconds(options.plan.frameDurationSeconds, videoTimebaseSeconds);
        if (packetIndexIsExtra || Math.abs(errorSeconds) > tolerance) {
          firstVideoTimestampError = { packetIndex, expectedSeconds, actualSeconds: timestampSeconds, errorSeconds };
        }
      }
      outputVideoPackets += 1;
    }
    const outputVideoDurationSeconds = await videoTrack.computeDuration();
    if (!Number.isFinite(outputVideoDurationSeconds) || outputVideoDurationSeconds <= 0) throw new Error('The finalized WebM video track has an invalid duration.');
    const audioTrack = await input.getPrimaryAudioTrack();
    if (options.requireAudioTrack && !audioTrack) throw new Error('The finalized WebM is missing its required audio track.');
    let outputAudioPackets: number | null = null;
    let outputAudioDurationSeconds: number | null = null;
    let audioTimeResolution: number | null = null;
    let outputAudioSampleRate: number | null = null;
    let decodedAudioSampleBuffers = 0;
    if (audioTrack) {
      audioTimeResolution = await audioTrack.getTimeResolution();
      outputAudioSampleRate = await audioTrack.getSampleRate();
      if (!Number.isFinite(audioTimeResolution) || audioTimeResolution <= 0) throw new Error('The finalized WebM audio track reports an invalid timestamp resolution.');
      if (!Number.isFinite(outputAudioSampleRate) || outputAudioSampleRate <= 0) throw new Error('The finalized WebM audio track reports an invalid sample rate.');
      const audioPacketSink = new EncodedPacketSink(audioTrack);
      outputAudioPackets = 0;
      for await (const _packet of audioPacketSink.packets()) outputAudioPackets += 1;
      if (outputAudioPackets < 1) throw new Error('The finalized WebM audio track contains no encoded audio packets.');
      outputAudioDurationSeconds = await audioTrack.computeDuration();
      if (!Number.isFinite(outputAudioDurationSeconds) || outputAudioDurationSeconds <= 0) throw new Error('The finalized WebM audio track has an invalid duration.');
      const firstTimestamp = await audioTrack.getFirstTimestamp();
      const sampleTimes = [...new Set([
        Math.max(0, firstTimestamp + 0.005),
        Math.max(0, firstTimestamp + outputAudioDurationSeconds / 2),
        Math.max(0, firstTimestamp + outputAudioDurationSeconds - Math.min(OPUS_PACKET_DURATION_SECONDS / 2, outputAudioDurationSeconds / 4)),
      ])].sort((left, right) => left - right);
      const audioSink = new AudioBufferSink(audioTrack);
      let sampleIndex = 0;
      for await (const decoded of audioSink.buffersAtTimestamps(sampleTimes)) {
        if (!decoded || decoded.buffer.length <= 0 || decoded.buffer.numberOfChannels <= 0) {
          throw new Error(`The finalized WebM audio track could not decode validation sample ${sampleIndex} at ${sampleTimes[sampleIndex]?.toFixed(6) ?? 'unknown'}s.`);
        }
        const data = decoded.buffer.getChannelData(0);
        if (data.length === 0 || !Number.isFinite(data[0])) throw new Error(`The finalized WebM audio validation sample ${sampleIndex} is empty or non-finite.`);
        decodedAudioSampleBuffers += 1;
        sampleIndex += 1;
      }
      if (decodedAudioSampleBuffers !== sampleTimes.length) throw new Error(`The finalized WebM decoded ${decodedAudioSampleBuffers}/${sampleTimes.length} requested audio validation samples.`);
    }

    const outputContainerDurationSeconds = await input.computeDuration();
    if (!Number.isFinite(outputContainerDurationSeconds) || outputContainerDurationSeconds <= 0) throw new Error('The finalized WebM container has an invalid duration.');
    const decodedVideoProbes: DecodedVideoProbe[] = [];
    const expectedVideoProbes = options.expectedVideoProbes ?? [];
    if (expectedVideoProbes.length) {
      const sink = new CanvasSink(videoTrack, { alpha: false, poolSize: 1 });
      const queryTimes = expectedVideoProbes.map((probe) => probe.queryTimestampSeconds);
      let probeIndex = 0;
      for await (const decoded of sink.canvasesAtTimestamps(queryTimes)) {
        const expected = expectedVideoProbes[probeIndex];
        if (!expected || !decoded) throw new Error(`The finalized WebM could not decode required video sample ${probeIndex} at ${queryTimes[probeIndex]?.toFixed(6) ?? 'unknown'}s.`);
        const timestampErrorSeconds = decoded.timestamp - expected.expectedTimestampSeconds;
        const meanAbsoluteError = meanAbsolutePixelError(expected.pixels, decoded.canvas);
        decodedVideoProbes.push({
          frameIndex: expected.frameIndex,
          expectedTimestampSeconds: expected.expectedTimestampSeconds,
          actualTimestampSeconds: decoded.timestamp,
          timestampErrorSeconds,
          meanAbsolutePixelError: meanAbsoluteError,
          passed: Math.abs(timestampErrorSeconds) <= videoTimestampToleranceSeconds(options.plan?.frameDurationSeconds ?? 1 / 24, videoTimebaseSeconds)
            && meanAbsoluteError <= MAX_DECODED_PROBE_MEAN_ABSOLUTE_ERROR,
        });
        probeIndex += 1;
      }
      if (probeIndex !== expectedVideoProbes.length) throw new Error(`The finalized WebM decoded ${probeIndex}/${expectedVideoProbes.length} required video samples.`);
    }
    return {
      outputVideoPackets,
      outputVideoPacketRate: outputVideoDurationSeconds > 0 ? outputVideoPackets / outputVideoDurationSeconds : 0,
      outputVideoDurationSeconds,
      outputAudioPackets,
      outputAudioDurationSeconds,
      outputContainerDurationSeconds,
      videoTimeResolution,
      audioTimeResolution,
      outputAudioSampleRate,
      videoTimestampsMonotonic,
      firstVideoTimestampError,
      decodedSampleFrames: decodedVideoProbes.length,
      decodedVideoProbes,
      decodedAudioSampleBuffers,
      mimeType: await input.getMimeType(),
    };
  } finally {
    input.dispose();
  }
}
