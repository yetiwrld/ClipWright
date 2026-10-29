import { ALL_FORMATS, AudioBufferSink, BufferSource, CanvasSink, Input } from 'mediabunny';
import { areExportFrameCountsExact, createSequenceExportPlan, encodeDeterministicWebm } from './deterministicWebmExport';
import { CANVAS_TIMESTAMP_EPSILON_SECONDS, drawLetterboxedVideoFrame, openVideoFrameReader, selectActiveVideoClip, sourceTimeForTimelineClip } from './timelineVideoFrames';
import { validateProjectDocument } from './projectDocument';
import type { MediaAsset, ProjectDocument, TimelineClip, Track } from './projectDocument';

const TEST_RATE = { numerator: 30, denominator: 1 };
const TEST_WIDTH = 320;
const TEST_HEIGHT = 180;
const IDENTITY_BIT_COUNT = 6;
type SmokeProgress = (stage: string) => void;
const reportNoop: SmokeProgress = () => undefined;

function drawIdentityFrame(context: CanvasRenderingContext2D, sourceId: 'A' | 'B', frameIndex: number) {
  context.fillStyle = '#202020';
  context.fillRect(0, 0, TEST_WIDTH, TEST_HEIGHT);
  context.fillStyle = sourceId === 'A' ? '#008cff' : '#ff7200';
  context.fillRect(0, 0, 42, TEST_HEIGHT);
  for (let bit = 0; bit < IDENTITY_BIT_COUNT; bit += 1) {
    context.fillStyle = (frameIndex >> bit) & 1 ? '#ffffff' : '#080808';
    context.fillRect(58 + bit * 36, 64, 28, 48);
  }
}

type FrameIdentity = { sourceId: 'A' | 'B' | null; frameIndex: number | null; isGap: boolean };
type TimedFrameIdentity = { timestampSeconds: number; identity: FrameIdentity };

function readIdentity(canvas: HTMLCanvasElement | OffscreenCanvas): FrameIdentity {
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not inspect a decoded frame identity canvas.');
  const sample = (x: number, y: number) => {
    const data = context.getImageData(x, y, 1, 1).data;
    return [data[0], data[1], data[2]] as const;
  };
  const [markerRed, markerGreen, markerBlue] = sample(18, 90);
  let sourceId: 'A' | 'B' | null = null;
  if (markerBlue > 150 && markerRed < 120 && markerGreen < 175) sourceId = 'A';
  if (markerRed > 170 && markerGreen > 65 && markerGreen < 165 && markerBlue < 130) sourceId = 'B';
  const [backgroundRed, backgroundGreen, backgroundBlue] = sample(306, 164);
  const isGap = !sourceId && Math.max(backgroundRed, backgroundGreen, backgroundBlue) < 20;
  if (isGap) return { sourceId: null, frameIndex: null, isGap: true };
  if (!sourceId) return { sourceId: null, frameIndex: null, isGap: false };
  let frameIndex = 0;
  for (let bit = 0; bit < IDENTITY_BIT_COUNT; bit += 1) {
    const [red, green, blue] = sample(72 + bit * 36, 88);
    if (Math.max(red, green, blue) > 150) frameIndex |= 1 << bit;
  }
  return { sourceId, frameIndex, isGap: false };
}

async function encodeIdentitySource(sourceId: 'A' | 'B', reportProgress: SmokeProgress) {
  reportProgress(`encoding source ${sourceId} identity footage`);
  const canvas = document.createElement('canvas');
  canvas.width = TEST_WIDTH;
  canvas.height = TEST_HEIGHT;
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('Could not create a frame-identity source canvas.');
  const plan = createSequenceExportPlan(30, TEST_RATE);
  const result = await encodeDeterministicWebm({
    canvas,
    plan,
    videoBitrate: 800_000,
    audioBitrate: 64_000,
    includeAudio: false,
    signal: new AbortController().signal,
    drawFrame: async (frameIndex) => drawIdentityFrame(context, sourceId, frameIndex),
  });
  if (!areExportFrameCountsExact(30, { ...result.counts, outputFile: result.measurements.outputVideoFrames })) {
    throw new Error(`The ${sourceId} frame-identity source did not encode exactly 30 frames.`);
  }
  return result.buffer;
}

function makeTimelineIdentityFixture() {
  const frame = (index: number) => index / TEST_RATE.numerator;
  const track: Track = { id: 'video-1', name: 'Video 1', kind: 'video', muted: false, locked: false, clips: [] };
  const clips: TimelineClip[] = [
    // The A1/A2 pair is a split of one source interval and is exactly adjacent at frame 10.
    { id: 'A1', sourceId: 'A', trackId: track.id, start: frame(0), trimIn: frame(5), trimOut: frame(15) },
    { id: 'A2', sourceId: 'A', trackId: track.id, start: frame(10), trimIn: frame(15), trimOut: frame(25) },
    // A cut to source B, then a second adjacent segment of B with a new source trim.
    { id: 'B1', sourceId: 'B', trackId: track.id, start: frame(20), trimIn: frame(0), trimOut: frame(12) },
    { id: 'B2', sourceId: 'B', trackId: track.id, start: frame(32), trimIn: frame(12), trimOut: frame(20) },
    // Frames 40–44 are intentionally a timeline gap and must stay black.
    // Frames 45–49 reference a valid but offline project asset and must also stay black.
    { id: 'offline-clip', sourceId: 'offline', trackId: track.id, start: frame(45), trimIn: frame(0), trimOut: frame(5) },
    { id: 'A3', sourceId: 'A', trackId: track.id, start: frame(50), trimIn: frame(10), trimOut: frame(25) },
  ];
  const assets: MediaAsset[] = ['A', 'B', 'offline'].map((id) => ({
    id,
    name: `Identity source ${id}`,
    sourcePath: `${id}.webm`,
    pathKind: 'browser-session',
    kind: 'video',
    streams: { video: { timeBase: { numerator: 1, denominator: 30 }, durationTicks: 30, frameRate: TEST_RATE, width: TEST_WIDTH, height: TEST_HEIGHT } },
  }));
  const project: ProjectDocument = {
    schemaVersion: 2,
    appVersion: 'smoke',
    id: 'frame-identity-project',
    metadata: { name: 'Frame identity fixture', createdAt: '2026-01-01T00:00:00.000Z', modifiedAt: '2026-01-01T00:00:00.000Z' },
    projectSettings: { defaultSequenceId: 'identity-sequence' },
    assets,
    sequences: [{
      id: 'identity-sequence', name: 'Identity sequence', width: TEST_WIDTH, height: TEST_HEIGHT,
      frameRate: TEST_RATE, audioSampleRate: 48_000, durationFrames: 65,
      tracks: [{ ...track, clips }],
    }],
  };
  const validation = validateProjectDocument(project);
  if (!validation.valid) throw new Error(`Synthetic frame-identity project is invalid: ${validation.errors.join(' ')}`);
  const sequence = validation.value.sequences.find((item) => item.id === validation.value.projectSettings.defaultSequenceId)!;
  return { project: validation.value, tracks: sequence.tracks, clips: sequence.tracks.flatMap((item) => item.clips), frameCount: sequence.durationFrames };
}

async function inspectFrameIdentities(
  buffer: ArrayBuffer,
  reportProgress: SmokeProgress,
  description: string,
): Promise<TimedFrameIdentity[]> {
  reportProgress(`opening ${description} for frame-identity decode`);
  const input = new Input({ source: new BufferSource(buffer), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('The identity-test output has no video track.');
    const sink = new CanvasSink(track, { alpha: false, poolSize: 1 });
    const identities: TimedFrameIdentity[] = [];
    for await (const frame of sink.canvases()) {
      identities.push({ timestampSeconds: frame.timestamp, identity: readIdentity(frame.canvas) });
      if (identities.length % 10 === 0 || identities.length === 1) reportProgress(`decoded ${identities.length} ${description} frame identities`);
    }
    return identities;
  } finally {
    input.dispose();
  }
}

async function runFrameIdentitySmoke(reportProgress: SmokeProgress) {
  const sourceA = await encodeIdentitySource('A', reportProgress);
  const sourceB = await encodeIdentitySource('B', reportProgress);
  const sourceBuffers = new Map<string, ArrayBuffer>([['A', sourceA], ['B', sourceB]]);
  const sourceFrameIdentities = new Map<string, TimedFrameIdentity[]>();
  for (const [sourceId, sourceBuffer] of sourceBuffers) {
    sourceFrameIdentities.set(sourceId, await inspectFrameIdentities(sourceBuffer, reportProgress, `synthetic source ${sourceId}`));
  }
  const readers = new Map<string, Awaited<ReturnType<typeof openVideoFrameReader>>>();
  const { tracks, clips, frameCount } = makeTimelineIdentityFixture();
  const plan = createSequenceExportPlan(frameCount, TEST_RATE);
  const canvas = document.createElement('canvas');
  canvas.width = TEST_WIDTH;
  canvas.height = TEST_HEIGHT;
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('Could not create the frame-identity export canvas.');
  try {
    reportProgress('encoding 65-frame timeline identity output');
    const result = await encodeDeterministicWebm({
      canvas,
      plan,
      videoBitrate: 800_000,
      audioBitrate: 64_000,
      includeAudio: false,
      signal: new AbortController().signal,
      drawFrame: async (frameIndex, timelineTimestamp) => {
        if (frameIndex % 10 === 0 || frameIndex === frameCount - 1) reportProgress(`composing timeline identity frame ${frameIndex + 1}/${frameCount}`);
        const clip = selectActiveVideoClip(clips, tracks, timelineTimestamp);
        let sourceCanvas: HTMLCanvasElement | OffscreenCanvas | null = null;
        if (clip && sourceBuffers.has(clip.sourceId)) {
          let reader = readers.get(clip.sourceId);
          if (!reader) {
            reportProgress(`opening source ${clip.sourceId} frame reader`);
            const bytes = sourceBuffers.get(clip.sourceId)!;
            reader = await openVideoFrameReader(new Blob([bytes], { type: 'video/webm' }));
            readers.set(clip.sourceId, reader);
          }
          reportProgress(`requesting source ${clip.sourceId} frame at ${sourceTimeForTimelineClip(clip, timelineTimestamp).toFixed(6)}s`);
          const decoded = await reader.getCanvasAt(sourceTimeForTimelineClip(clip, timelineTimestamp));
          reportProgress(`decoded source ${clip.sourceId} frame for timeline frame ${frameIndex + 1}`);
          sourceCanvas = decoded?.canvas ?? null;
        }
        drawLetterboxedVideoFrame(context, canvas.width, canvas.height, sourceCanvas);
      },
    });
    reportProgress('finalized timeline output; decoding frame identities');
    const fileFrameIdentities = await inspectFrameIdentities(result.buffer, reportProgress, 'finalized timeline output');
    const expectedFrameIdentities: FrameIdentity[] = Array.from({ length: frameCount }, (_, frameIndex) => {
      const timestamp = plan.timestampSeconds(frameIndex);
      const clip = selectActiveVideoClip(clips, tracks, timestamp);
      if (!clip || !sourceBuffers.has(clip.sourceId)) return { sourceId: null, frameIndex: null, isGap: true };
      const sourceTimestamp = sourceTimeForTimelineClip(clip, timestamp);
      const sourceFrames = sourceFrameIdentities.get(clip.sourceId) ?? [];
      let selectedSourceFrame: TimedFrameIdentity | null = null;
      for (const sourceFrame of sourceFrames) {
        if (sourceFrame.timestampSeconds <= sourceTimestamp + CANVAS_TIMESTAMP_EPSILON_SECONDS) selectedSourceFrame = sourceFrame;
        else break;
      }
      return selectedSourceFrame?.identity ?? { sourceId: null, frameIndex: null, isGap: true };
    });
    const mismatches = expectedFrameIdentities.flatMap((expected, index) => {
      const actual = fileFrameIdentities[index]?.identity;
      if (actual && actual.isGap === expected.isGap && actual.sourceId === expected.sourceId && actual.frameIndex === expected.frameIndex) return [];
      return [{ outputFrame: index, expected, actual: actual ?? null }];
    });
    const countsMatch = areExportFrameCountsExact(frameCount, {
      ...result.counts,
      outputFile: result.measurements.outputVideoFrames,
    });
    const videoDurationDeltaSeconds = result.measurements.outputVideoDurationSeconds - plan.durationSeconds;
    const containerDurationDeltaSeconds = result.measurements.outputContainerDurationSeconds - plan.durationSeconds;
    const durationToleranceSeconds = plan.frameDurationSeconds;
    return {
      pass: countsMatch
        && fileFrameIdentities.length === frameCount
        && mismatches.length === 0
        && Math.abs(videoDurationDeltaSeconds) <= durationToleranceSeconds
        && Math.abs(containerDurationDeltaSeconds) <= durationToleranceSeconds,
      expected: { frames: frameCount, frameRate: TEST_RATE, durationSeconds: plan.durationSeconds, durationToleranceSeconds },
      actual: {
        decodedFileFrames: fileFrameIdentities.length,
        videoDurationSeconds: result.measurements.outputVideoDurationSeconds,
        videoDurationDeltaSeconds,
        containerDurationSeconds: result.measurements.outputContainerDurationSeconds,
        containerDurationDeltaSeconds,
      },
      mismatchCount: mismatches.length,
      mismatches: mismatches.slice(0, 12),
      gapFrameIndexes: Array.from({ length: frameCount }, (_, index) => index).filter((index) => !selectActiveVideoClip(clips, tracks, plan.timestampSeconds(index))),
      offlineFrameIndexes: Array.from({ length: frameCount }, (_, index) => index).filter((index) => {
        const clip = selectActiveVideoClip(clips, tracks, plan.timestampSeconds(index));
        return Boolean(clip && !sourceBuffers.has(clip.sourceId));
      }),
    };
  } finally {
    for (const reader of readers.values()) await reader.dispose();
  }
}

async function measureDecodedAvOffset(buffer: ArrayBuffer) {
  const input = new Input({ source: new BufferSource(buffer), formats: ALL_FORMATS });
  try {
    const videoTrack = await input.getPrimaryVideoTrack();
    const audioTrack = await input.getPrimaryAudioTrack();
    if (!videoTrack || !audioTrack) throw new Error('The A/V offset smoke could not find both finalized WebM tracks.');

    let videoFlashTimestampSeconds: number | null = null;
    const videoSink = new CanvasSink(videoTrack);
    for await (const frame of videoSink.canvases()) {
      const context = frame.canvas.getContext('2d');
      if (!context) throw new Error('The A/V offset smoke could not inspect a decoded video frame.');
      const [red, green, blue] = context.getImageData(24, 24, 1, 1).data;
      if (red > 190 && green > 190 && blue > 190) {
        videoFlashTimestampSeconds = frame.timestamp;
        break;
      }
    }

    let audioPulseTimestampSeconds: number | null = null;
    const audioSink = new AudioBufferSink(audioTrack);
    for await (const part of audioSink.buffers()) {
      const channel = part.buffer.getChannelData(0);
      for (let sampleIndex = 0; sampleIndex < channel.length; sampleIndex += 1) {
        if (Math.abs(channel[sampleIndex]) > 0.04) {
          audioPulseTimestampSeconds = part.timestamp + sampleIndex / part.buffer.sampleRate;
          break;
        }
      }
      if (audioPulseTimestampSeconds !== null) break;
    }
    if (videoFlashTimestampSeconds === null || audioPulseTimestampSeconds === null) {
      throw new Error('The finalized WebM A/V offset smoke could not find its decoded video flash and audio pulse.');
    }
    return {
      videoFlashTimestampSeconds,
      audioPulseTimestampSeconds,
      audioMinusVideoOffsetSeconds: audioPulseTimestampSeconds - videoFlashTimestampSeconds,
    };
  } finally {
    input.dispose();
  }
}

async function runAudioDurationSmoke(reportProgress: SmokeProgress) {
  reportProgress('encoding one-second duration and decoded A/V-offset smoke');
  const frameRate = TEST_RATE;
  const plan = createSequenceExportPlan(30, frameRate);
  const canvas = document.createElement('canvas');
  canvas.width = TEST_WIDTH;
  canvas.height = TEST_HEIGHT;
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('The packaged renderer could not create a WebM smoke-test canvas.');
  const sampleRate = 48_000;
  const offlineAudio = new OfflineAudioContext(2, sampleRate, sampleRate);
  const audioPulseStartSeconds = 0.25;
  const audioPulseEndSeconds = 0.30;
  const videoFlashFrameIndex = 8;
  const videoFlashTimestampSeconds = plan.timestampSeconds(videoFlashFrameIndex);
  const result = await encodeDeterministicWebm({
    canvas,
    plan,
    videoBitrate: 300_000,
    audioBitrate: 64_000,
    includeAudio: true,
    signal: new AbortController().signal,
    drawFrame: async (frameIndex) => {
      if (frameIndex % 10 === 0 || frameIndex === plan.frameCount - 1) reportProgress(`composing audio smoke frame ${frameIndex + 1}/${plan.frameCount}`);
      context.fillStyle = '#202020';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = '#1769aa';
      context.fillRect(frameIndex * 8 % canvas.width, 100, 24, 24);
      if (frameIndex === videoFlashFrameIndex || frameIndex === videoFlashFrameIndex + 1) {
        context.fillStyle = '#ffffff';
        context.fillRect(8, 8, 48, 48);
      }
    },
    renderAudioChunk: async (startSeconds, durationSeconds) => {
      const samples = Math.max(1, Math.round(durationSeconds * sampleRate));
      const audioBuffer = offlineAudio.createBuffer(2, samples, sampleRate);
      const left = audioBuffer.getChannelData(0);
      const right = audioBuffer.getChannelData(1);
      for (let sampleIndex = 0; sampleIndex < samples; sampleIndex += 1) {
        const timestamp = startSeconds + sampleIndex / sampleRate;
        if (timestamp >= audioPulseStartSeconds && timestamp < audioPulseEndSeconds) {
          const value = 0.65 * Math.sin(2 * Math.PI * 1_000 * (timestamp - audioPulseStartSeconds));
          left[sampleIndex] = value;
          right[sampleIndex] = value;
        }
      }
      return audioBuffer;
    },
  });
  const expectedDuration = plan.durationSeconds;
  const tolerance = plan.frameDurationSeconds;
  const videoDelta = result.measurements.outputVideoDurationSeconds - expectedDuration;
  const audioDelta = result.measurements.outputAudioDurationSeconds === null ? null : result.measurements.outputAudioDurationSeconds - expectedDuration;
  const containerDelta = result.measurements.outputContainerDurationSeconds - expectedDuration;
  const avOffset = await measureDecodedAvOffset(result.buffer);
  const expectedAvOffsetSeconds = audioPulseStartSeconds - videoFlashTimestampSeconds;
  const avOffsetErrorSeconds = avOffset.audioMinusVideoOffsetSeconds - expectedAvOffsetSeconds;
  const countsMatch = areExportFrameCountsExact(plan.frameCount, {
    ...result.counts,
    outputFile: result.measurements.outputVideoFrames,
  });
  const durationsMatch = Math.abs(videoDelta) <= tolerance
    && audioDelta !== null && Math.abs(audioDelta) <= tolerance
    && Math.abs(containerDelta) <= tolerance;
  const avOffsetMatch = Math.abs(avOffsetErrorSeconds) <= tolerance;
  return {
    pass: countsMatch && durationsMatch && avOffsetMatch,
    expected: {
      frameRate,
      frameCount: plan.frameCount,
      frameAlignedVideoDurationSeconds: expectedDuration,
      oneFrameToleranceSeconds: tolerance,
      audioPulseStartSeconds,
      videoFlashTimestampSeconds,
      audioMinusVideoOffsetSeconds: expectedAvOffsetSeconds,
    },
    counts: {
      requested: result.counts.requested,
      rendered: result.counts.rendered,
      submitted: result.counts.submitted,
      encoded: result.counts.encoded,
      outputFile: result.measurements.outputVideoFrames,
    },
    actual: {
      mimeType: result.measurements.mimeType,
      measuredVideoFrameRate: result.measurements.outputVideoFrameRate,
      videoDurationSeconds: result.measurements.outputVideoDurationSeconds,
      videoDurationDeltaSeconds: videoDelta,
      audioDurationSeconds: result.measurements.outputAudioDurationSeconds,
      audioDurationDeltaSeconds: audioDelta,
      containerDurationSeconds: result.measurements.outputContainerDurationSeconds,
      containerDurationDeltaSeconds: containerDelta,
      decodedAvOffset: avOffset,
      avOffsetErrorSeconds,
      videoDimensions: { width: canvas.width, height: canvas.height },
    },
  };
}

export async function runDeterministicWebmSmoke(reportProgress: SmokeProgress = reportNoop) {
  const audio = await runAudioDurationSmoke(reportProgress);
  reportProgress('audio duration smoke complete; starting frame identity fixture');
  const frameIdentity = await runFrameIdentitySmoke(reportProgress);
  reportProgress('all packaged WebM smoke checks complete');
  return {
    ...audio,
    pass: audio.pass && frameIdentity.pass,
    frameIdentity,
  };
}
