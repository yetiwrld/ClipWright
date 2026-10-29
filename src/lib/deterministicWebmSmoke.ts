import { ALL_FORMATS, AudioBufferSink, BufferSource, CanvasSink, Input } from 'mediabunny';
import {
  OPUS_PACKET_DURATION_SECONDS,
  WEBM_TIMEBASE_SECONDS,
  areExportFrameCountsExact,
  audioDurationToleranceSeconds,
  audioOnsetToleranceSeconds,
  createSequenceExportPlan,
  encodeDeterministicWebm,
  videoTimestampToleranceSeconds,
} from './deterministicWebmExport';
import { exportTimelineProject } from './timelineExport';
import { parseProjectDocument, serializeProjectDocument, validateProjectDocument } from './projectDocument';
import type { MediaAsset, ProjectDocument, TimelineClip, Track } from './projectDocument';

const TEST_RATE = { numerator: 30, denominator: 1 };
const TEST_WIDTH = 320;
const TEST_HEIGHT = 180;
const IDENTITY_BIT_COUNT = 6;
const IDENTITY_AUDIO_PULSES = {
  A: [{ frameIndex: 6, frequencyHz: 440 }, { frameIndex: 15, frequencyHz: 440 }, { frameIndex: 22, frequencyHz: 440 }],
  B: [{ frameIndex: 4, frequencyHz: 660 }, { frameIndex: 13, frequencyHz: 660 }],
} as const;
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
  const sourcePulseFrames: readonly number[] = IDENTITY_AUDIO_PULSES[sourceId].map((pulse) => pulse.frameIndex);
  if (sourcePulseFrames.includes(frameIndex)) {
    context.fillStyle = '#ffffff';
    context.fillRect(274, 8, 40, 40);
  }
}

type FrameIdentity = { sourceId: 'A' | 'B' | null; frameIndex: number | null; isGap: boolean; hasSyncFlash: boolean };
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
  if (isGap) return { sourceId: null, frameIndex: null, isGap: true, hasSyncFlash: false };
  const [flashRed, flashGreen, flashBlue] = sample(294, 28);
  const hasSyncFlash = flashRed > 190 && flashGreen > 190 && flashBlue > 190;
  if (!sourceId) return { sourceId: null, frameIndex: null, isGap: false, hasSyncFlash };
  let frameIndex = 0;
  for (let bit = 0; bit < IDENTITY_BIT_COUNT; bit += 1) {
    const [red, green, blue] = sample(72 + bit * 36, 88);
    if (Math.max(red, green, blue) > 150) frameIndex |= 1 << bit;
  }
  return { sourceId, frameIndex, isGap: false, hasSyncFlash };
}

async function encodeIdentitySource(sourceId: 'A' | 'B', reportProgress: SmokeProgress) {
  reportProgress(`encoding source ${sourceId} identity footage`);
  const canvas = document.createElement('canvas');
  canvas.width = TEST_WIDTH;
  canvas.height = TEST_HEIGHT;
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('Could not create a frame-identity source canvas.');
  const plan = createSequenceExportPlan(30, TEST_RATE);
  const sampleRate = 48_000;
  const audioContext = new OfflineAudioContext(2, 24_000, sampleRate);
  const sourcePulses = IDENTITY_AUDIO_PULSES[sourceId].map((pulse) => ({
    startSeconds: pulse.frameIndex / TEST_RATE.numerator,
    endSeconds: (pulse.frameIndex + 2) / TEST_RATE.numerator,
    frequencyHz: pulse.frequencyHz,
  }));
  const result = await encodeDeterministicWebm({
    canvas,
    plan,
    videoBitrate: 800_000,
    audioBitrate: 64_000,
    includeAudio: true,
    signal: new AbortController().signal,
    drawFrame: async (frameIndex) => drawIdentityFrame(context, sourceId, frameIndex),
    renderAudioChunk: async (startSeconds, durationSeconds) => {
      const sampleCount = Math.max(1, Math.round(durationSeconds * sampleRate));
      const audioBuffer = audioContext.createBuffer(2, sampleCount, sampleRate);
      const left = audioBuffer.getChannelData(0);
      const right = audioBuffer.getChannelData(1);
      for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
        const timestamp = startSeconds + sampleIndex / sampleRate;
        const pulse = sourcePulses.find((item) => timestamp >= item.startSeconds && timestamp < item.endSeconds);
        if (!pulse) continue;
        const value = 0.65 * Math.sin(2 * Math.PI * pulse.frequencyHz * (timestamp - pulse.startSeconds));
        left[sampleIndex] = value;
        right[sampleIndex] = value;
      }
      return audioBuffer;
    },
  });
  if (!areExportFrameCountsExact(30, { ...result.counts, outputFilePackets: result.measurements.outputVideoPackets })) {
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
    streams: {
      video: { timeBase: { numerator: 1, denominator: 30 }, durationTicks: 30, frameRate: TEST_RATE, width: TEST_WIDTH, height: TEST_HEIGHT },
      ...(id === 'offline' ? {} : { audio: { timeBase: { numerator: 1, denominator: 48_000 }, durationTicks: 48_000, sampleRate: 48_000, channels: 2 } }),
    },
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

const EXPECTED_IDENTITY_PLACEMENTS = [
  { startFrame: 0, endFrame: 10, sourceId: 'A' as const, sourceFrameStart: 5 },
  { startFrame: 10, endFrame: 20, sourceId: 'A' as const, sourceFrameStart: 15 },
  { startFrame: 20, endFrame: 32, sourceId: 'B' as const, sourceFrameStart: 0 },
  { startFrame: 32, endFrame: 40, sourceId: 'B' as const, sourceFrameStart: 12 },
  { startFrame: 50, endFrame: 65, sourceId: 'A' as const, sourceFrameStart: 10 },
];
const EXPECTED_AUDIO_PULSE_FRAME_INDEXES = [1, 10, 17, 24, 33, 55, 62];
const EXPECTED_TIMELINE_AUDIO_PULSES_SECONDS = EXPECTED_AUDIO_PULSE_FRAME_INDEXES.map((frameIndex) => frameIndex / 30);
const AUDIO_ACTIVITY_THRESHOLD = 0.18;
const AUDIO_ACTIVITY_GAP_SECONDS = 0.025;

function buildExpectedFrameIdentities(frameCount: number, sourceFrames: ReadonlyMap<'A' | 'B', TimedFrameIdentity[]>): FrameIdentity[] {
  return Array.from({ length: frameCount }, (_, frameIndex) => {
    const placement = EXPECTED_IDENTITY_PLACEMENTS.find(({ startFrame, endFrame }) => frameIndex >= startFrame && frameIndex < endFrame);
    if (!placement) return { sourceId: null, frameIndex: null, isGap: true, hasSyncFlash: false };
    const requestedSourceTime = placement.sourceFrameStart / TEST_RATE.numerator
      + (frameIndex - placement.startFrame) / TEST_RATE.numerator;
    const decodedSource = sourceFrames.get(placement.sourceId) ?? [];
    let expectedSourceFrame: TimedFrameIdentity | undefined;
    for (const sourceFrame of decodedSource) {
      if (sourceFrame.timestampSeconds > requestedSourceTime + 1 / 1_000_000) break;
      expectedSourceFrame = sourceFrame;
    }
    return expectedSourceFrame?.identity ?? { sourceId: null, frameIndex: null, isGap: true, hasSyncFlash: false };
  });
}

function arrayBufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
  }
  return btoa(binary);
}

function stringToBase64(text: string) {
  return arrayBufferToBase64(new TextEncoder().encode(text).buffer);
}

async function measureTimelineAudioOnsets(buffer: ArrayBuffer) {
  const input = new Input({ source: new BufferSource(buffer), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) throw new Error('The production timeline export has no audio track for its embedded-audio fixture.');
    const sink = new AudioBufferSink(track);
    const onsets: number[] = [];
    let sampleRate: number | null = null;
    let lastActiveTimestamp = -Infinity;
    for await (const part of sink.buffers()) {
      sampleRate = part.buffer.sampleRate;
      const channel = part.buffer.getChannelData(0);
      for (let sampleIndex = 0; sampleIndex < channel.length; sampleIndex += 1) {
        if (Math.abs(channel[sampleIndex]) <= AUDIO_ACTIVITY_THRESHOLD) continue;
        const timestamp = part.timestamp + sampleIndex / part.buffer.sampleRate;
        if (timestamp - lastActiveTimestamp > AUDIO_ACTIVITY_GAP_SECONDS) onsets.push(timestamp);
        lastActiveTimestamp = timestamp;
      }
    }
    if (!sampleRate) throw new Error('The production timeline export audio track could not be decoded.');
    return { sampleRate, onsetsSeconds: onsets };
  } finally {
    input.dispose();
  }
}

async function runFrameIdentitySmoke(reportProgress: SmokeProgress) {
  let sourceA: ArrayBuffer | null = null;
  let sourceB: ArrayBuffer | null = null;
  let projectSnapshot = '';
  let fixtureMetadata: Record<string, unknown> | null = null;
  let outputBuffer: ArrayBuffer | null = null;
  let stage = 'encoding synthetic source media';
  let projectId = 'frame-identity-project';
  try {
    sourceA = await encodeIdentitySource('A', reportProgress);
    sourceB = await encodeIdentitySource('B', reportProgress);
    const sourceBuffers = new Map<'A' | 'B', ArrayBuffer>([['A', sourceA], ['B', sourceB]]);
    const decodedSourceFrames = new Map<'A' | 'B', TimedFrameIdentity[]>();
    for (const [sourceId, sourceBuffer] of sourceBuffers) {
      const decoded = await inspectFrameIdentities(sourceBuffer, reportProgress, `synthetic source ${sourceId}`);
      const sourcePulses = IDENTITY_AUDIO_PULSES[sourceId];
      const invalidSourceFrame = decoded.find((frame, index) => frame.identity.sourceId !== sourceId
        || frame.identity.frameIndex !== index
        || frame.identity.hasSyncFlash !== sourcePulses.some((pulse) => pulse.frameIndex === index));
      if (decoded.length !== 30 || invalidSourceFrame) {
        throw new Error(`Synthetic source ${sourceId} is not a complete 30-frame video/audio fixture; decoded=${decoded.length}, firstBad=${JSON.stringify(invalidSourceFrame ?? null)}.`);
      }
      decodedSourceFrames.set(sourceId, decoded);
    }

    const expectedFrameIdentities = buildExpectedFrameIdentities(65, decodedSourceFrames);
    const expectedFlashFrameIndexes = expectedFrameIdentities.flatMap((frame, index) => frame.hasSyncFlash ? [index] : []);

    stage = 'serializing and validating saved project snapshot';
    reportProgress(stage);
    const fixture = makeTimelineIdentityFixture();
    projectId = fixture.project.id;
    projectSnapshot = serializeProjectDocument(fixture.project);
    const savedProject = parseProjectDocument(projectSnapshot);
    const sourceBlobs = new Map<string, Blob>([
      ['A', new Blob([sourceA], { type: 'video/webm' })],
      ['B', new Blob([sourceB], { type: 'video/webm' })],
    ]);
    const plan = createSequenceExportPlan(savedProject.sequences[0].durationFrames, savedProject.sequences[0].frameRate);
    fixtureMetadata = {
      fixtureVersion: 1,
      projectSnapshotFile: 'saved-project.json',
      sourceFiles: ['source-A.webm', 'source-B.webm'],
      outputFile: 'timeline-export.webm',
      frameRate: TEST_RATE,
      width: TEST_WIDTH,
      height: TEST_HEIGHT,
      expectedFrameCount: 65,
      expectedDurationSeconds: plan.durationSeconds,
      expectedPlacements: EXPECTED_IDENTITY_PLACEMENTS,
      expectedGapFrames: Array.from({ length: 5 }, (_, offset) => 40 + offset),
      expectedOfflineFrames: Array.from({ length: 5 }, (_, offset) => 45 + offset),
      expectedAudioPulseFrameIndexes: EXPECTED_AUDIO_PULSE_FRAME_INDEXES,
      expectedAudioPulseOnsetsSeconds: EXPECTED_TIMELINE_AUDIO_PULSES_SECONDS,
      expectedFlashFrameIndexes,
      timingPolicy: {
        matroskaTimecodeScaleNanoseconds: 1_000_000,
        videoTimestampToleranceSeconds: videoTimestampToleranceSeconds(plan.frameDurationSeconds, WEBM_TIMEBASE_SECONDS),
        opusPacketDurationSeconds: OPUS_PACKET_DURATION_SECONDS,
        audioOnsetToleranceSeconds: audioOnsetToleranceSeconds(48_000, OPUS_PACKET_DURATION_SECONDS, WEBM_TIMEBASE_SECONDS),
      },
    };

    stage = 'executing production saved-project timeline export';
    reportProgress(stage);
    const result = await exportTimelineProject({
      projectSnapshot: savedProject,
      sourceBlobs,
      sequenceId: savedProject.projectSettings.defaultSequenceId,
      resolution: 'sequence',
      quality: 'standard',
      signal: new AbortController().signal,
      onStage: (nextStage) => { stage = nextStage; reportProgress(nextStage); },
      onProgress: (counts) => {
        if (counts.submitted && (counts.submitted % 10 === 0 || counts.submitted === plan.frameCount)) {
          reportProgress(`production export submitted frame ${counts.submitted}/${plan.frameCount}`);
        }
      },
    });
    outputBuffer = result.buffer;

    stage = 'independently checking decoded production export';
    reportProgress(stage);
    const fileFrameIdentities = await inspectFrameIdentities(result.buffer, reportProgress, 'production saved-project output');
    const timestampToleranceSeconds = videoTimestampToleranceSeconds(plan.frameDurationSeconds, 1 / result.measurements.videoTimeResolution);
    const mismatches = expectedFrameIdentities.flatMap((expected, index) => {
      const actual = fileFrameIdentities[index]?.identity;
      const actualTimestampSeconds = fileFrameIdentities[index]?.timestampSeconds;
      const expectedTimestampSeconds = plan.timestampSeconds(index);
      const timestampErrorSeconds = actualTimestampSeconds === undefined ? null : actualTimestampSeconds - expectedTimestampSeconds;
      if (actual && actual.isGap === expected.isGap && actual.sourceId === expected.sourceId && actual.frameIndex === expected.frameIndex
        && actual.hasSyncFlash === expected.hasSyncFlash
        && timestampErrorSeconds !== null && Math.abs(timestampErrorSeconds) <= timestampToleranceSeconds) return [];
      return [{ outputFrame: index, expectedTimestampSeconds, actualTimestampSeconds: actualTimestampSeconds ?? null, timestampErrorSeconds, expected, actual: actual ?? null }];
    });
    const countsMatch = areExportFrameCountsExact(plan.frameCount, {
      ...result.counts,
      outputFilePackets: result.measurements.outputVideoPackets,
    });
    const videoDurationDeltaSeconds = result.measurements.outputVideoDurationSeconds - plan.durationSeconds;
    const containerDurationDeltaSeconds = result.measurements.outputContainerDurationSeconds - plan.durationSeconds;
    const videoDurationToleranceSeconds = videoTimestampToleranceSeconds(plan.frameDurationSeconds, 1 / result.measurements.videoTimeResolution);
    const audioDurationDeltaSeconds = result.measurements.outputAudioDurationSeconds === null
      ? null
      : result.measurements.outputAudioDurationSeconds - plan.durationSeconds;
    const audioDurationTolSeconds = audioDurationToleranceSeconds(48_000, OPUS_PACKET_DURATION_SECONDS, result.measurements.audioTimeResolution ? 1 / result.measurements.audioTimeResolution : WEBM_TIMEBASE_SECONDS);
    const containerDurationToleranceSeconds = Math.max(videoDurationToleranceSeconds, audioDurationTolSeconds);
    const audioAnalysis = await measureTimelineAudioOnsets(result.buffer);
    const audioOnsetTolerance = audioOnsetToleranceSeconds(audioAnalysis.sampleRate, OPUS_PACKET_DURATION_SECONDS, result.measurements.audioTimeResolution ? 1 / result.measurements.audioTimeResolution : WEBM_TIMEBASE_SECONDS);
    const audioOnsetMatches = EXPECTED_TIMELINE_AUDIO_PULSES_SECONDS.map((expectedSeconds, index) => {
      const actualSeconds = audioAnalysis.onsetsSeconds[index] ?? null;
      const errorSeconds = actualSeconds === null ? null : actualSeconds - expectedSeconds;
      return { index, expectedSeconds, actualSeconds, errorSeconds, passed: errorSeconds !== null && Math.abs(errorSeconds) <= audioOnsetTolerance };
    });
    const actualFlashFrames = fileFrameIdentities.flatMap((frame, index) => frame.identity.hasSyncFlash ? [{ frameIndex: index, timestampSeconds: frame.timestampSeconds }] : []);
    const avSyncChecks = EXPECTED_AUDIO_PULSE_FRAME_INDEXES.map((frameIndex, index) => {
      const videoFrame = fileFrameIdentities[frameIndex];
      const actualAudio = audioAnalysis.onsetsSeconds[index];
      const expectedVideoSeconds = plan.timestampSeconds(frameIndex);
      const actualVideoSeconds = videoFrame?.timestampSeconds ?? null;
      const measuredOffsetSeconds = actualVideoSeconds !== null && actualAudio !== undefined ? actualAudio - actualVideoSeconds : null;
      return {
        frameIndex,
        expectedVideoSeconds,
        actualVideoSeconds,
        videoFlashPresent: videoFrame?.identity.hasSyncFlash ?? false,
        actualAudioSeconds: actualAudio ?? null,
        audioMinusVideoSeconds: measuredOffsetSeconds,
        passed: videoFrame?.identity.hasSyncFlash === true
          && measuredOffsetSeconds !== null
          && Math.abs(measuredOffsetSeconds) <= audioOnsetTolerance,
      };
    });
    const audioPass = result.expectedAudioTrack
      && (result.measurements.outputAudioPackets ?? 0) > 0
      && audioAnalysis.onsetsSeconds.length === EXPECTED_TIMELINE_AUDIO_PULSES_SECONDS.length
      && audioOnsetMatches.every(({ passed }) => passed)
      && avSyncChecks.every(({ passed }) => passed);
    const videoPass = countsMatch
      && fileFrameIdentities.length === plan.frameCount
      && mismatches.length === 0
      && result.measurements.videoTimestampsMonotonic
      && result.measurements.firstVideoTimestampError === null
      && Math.abs(videoDurationDeltaSeconds) <= videoDurationToleranceSeconds
      && Math.abs(containerDurationDeltaSeconds) <= containerDurationToleranceSeconds;
    const report = {
      pass: videoPass && audioPass,
      stage,
      fixture: 'saved-project-timeline-audio-video-identity',
      projectId: result.projectId,
      sequenceId: result.sequenceId,
      expected: {
        frames: plan.frameCount,
        frameRate: TEST_RATE,
        durationSeconds: plan.durationSeconds,
        videoTimestampToleranceSeconds,
        audioDurationToleranceSeconds: audioDurationTolSeconds,
        audioOnsetToleranceSeconds: audioOnsetTolerance,
        expectedAudioPulseFrameIndexes: EXPECTED_AUDIO_PULSE_FRAME_INDEXES,
        expectedAudioPulseOnsetsSeconds: EXPECTED_TIMELINE_AUDIO_PULSES_SECONDS,
        expectedFlashFrameIndexes,
      },
      counts: { ...result.counts, outputVideoPackets: result.measurements.outputVideoPackets, decodedVideoFrames: fileFrameIdentities.length },
      actual: {
        videoDurationSeconds: result.measurements.outputVideoDurationSeconds,
        videoDurationDeltaSeconds,
        containerDurationSeconds: result.measurements.outputContainerDurationSeconds,
        containerDurationDeltaSeconds,
        expectedAudioTrack: result.expectedAudioTrack,
        audioDurationSeconds: result.measurements.outputAudioDurationSeconds,
        audioDurationDeltaSeconds,
        outputAudioPackets: result.measurements.outputAudioPackets,
        videoTimeResolution: result.measurements.videoTimeResolution,
        audioTimeResolution: result.measurements.audioTimeResolution,
        outputAudioSampleRate: result.measurements.outputAudioSampleRate,
        videoTimestampsMonotonic: result.measurements.videoTimestampsMonotonic,
        firstVideoTimestampError: result.measurements.firstVideoTimestampError,
        decodedSampleFrames: result.measurements.decodedSampleFrames,
        audioSampleRate: audioAnalysis.sampleRate,
        audioSignalOnsetsSeconds: audioAnalysis.onsetsSeconds,
        videoSyncFlashFrames: actualFlashFrames,
        audioOnsetMatches,
        avSyncChecks,
        encoderConfiguration: result.encoderConfiguration,
        outputDimensions: result.outputDimensions,
      },
      mismatchCount: mismatches.length,
      mismatches: mismatches.slice(0, 12),
      firstIncorrectFrame: mismatches[0] ?? null,
      gapFrameIndexes: [40, 41, 42, 43, 44],
      offlineFrameIndexes: [45, 46, 47, 48, 49],
    };
    const sourceBase64 = { A: arrayBufferToBase64(sourceA), B: arrayBufferToBase64(sourceB) };
    const artifacts = {
      'source-A.webm': sourceBase64.A,
      'source-B.webm': sourceBase64.B,
      'saved-project.json': stringToBase64(projectSnapshot),
      'fixture.json': stringToBase64(JSON.stringify(fixtureMetadata, null, 2)),
      'timeline-export.webm': arrayBufferToBase64(result.buffer),
    };
    return { report, artifacts };
  } catch (error) {
    const artifacts: Record<string, string> = {};
    if (sourceA) artifacts['source-A.webm'] = arrayBufferToBase64(sourceA);
    if (sourceB) artifacts['source-B.webm'] = arrayBufferToBase64(sourceB);
    if (projectSnapshot) artifacts['saved-project.json'] = stringToBase64(projectSnapshot);
    if (fixtureMetadata) artifacts['fixture.json'] = stringToBase64(JSON.stringify(fixtureMetadata, null, 2));
    if (outputBuffer) artifacts['timeline-export.webm'] = arrayBufferToBase64(outputBuffer);
    return {
      report: {
        pass: false,
        fixture: 'saved-project-timeline-audio-video-identity',
        stage,
        projectId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : null,
        localValidationDiagnostics: error && typeof error === 'object' && 'exportDiagnostics' in error
          ? (error as Error & { exportDiagnostics?: unknown }).exportDiagnostics ?? null
          : null,
      },
      artifacts,
    };
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
  const videoFlashFrameIndex = 8;
  const videoFlashTimestampSeconds = plan.timestampSeconds(videoFlashFrameIndex);
  const audioPulseStartSeconds = videoFlashTimestampSeconds;
  const audioPulseEndSeconds = audioPulseStartSeconds + 0.05;
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
  const videoToleranceSeconds = videoTimestampToleranceSeconds(plan.frameDurationSeconds, 1 / result.measurements.videoTimeResolution);
  const audioToleranceSeconds = audioDurationToleranceSeconds(sampleRate, OPUS_PACKET_DURATION_SECONDS, result.measurements.audioTimeResolution ? 1 / result.measurements.audioTimeResolution : WEBM_TIMEBASE_SECONDS);
  const containerToleranceSeconds = Math.max(videoToleranceSeconds, audioToleranceSeconds);
  const avOffsetToleranceSeconds = audioOnsetToleranceSeconds(sampleRate, OPUS_PACKET_DURATION_SECONDS, result.measurements.audioTimeResolution ? 1 / result.measurements.audioTimeResolution : WEBM_TIMEBASE_SECONDS);
  const videoDelta = result.measurements.outputVideoDurationSeconds - expectedDuration;
  const audioDelta = result.measurements.outputAudioDurationSeconds === null ? null : result.measurements.outputAudioDurationSeconds - expectedDuration;
  const containerDelta = result.measurements.outputContainerDurationSeconds - expectedDuration;
  const avOffset = await measureDecodedAvOffset(result.buffer);
  const expectedAvOffsetSeconds = audioPulseStartSeconds - videoFlashTimestampSeconds;
  const avOffsetErrorSeconds = avOffset.audioMinusVideoOffsetSeconds - expectedAvOffsetSeconds;
  const countsMatch = areExportFrameCountsExact(plan.frameCount, {
    ...result.counts,
    outputFilePackets: result.measurements.outputVideoPackets,
  });
  const durationsMatch = Math.abs(videoDelta) <= videoToleranceSeconds
    && audioDelta !== null && Math.abs(audioDelta) <= audioToleranceSeconds
    && Math.abs(containerDelta) <= containerToleranceSeconds;
  const avOffsetMatch = Math.abs(avOffsetErrorSeconds) <= avOffsetToleranceSeconds;
  return {
    pass: countsMatch && durationsMatch && avOffsetMatch,
    expected: {
      frameRate,
      frameCount: plan.frameCount,
      frameAlignedVideoDurationSeconds: expectedDuration,
      videoTimestampToleranceSeconds,
      audioDurationToleranceSeconds: audioToleranceSeconds,
      containerDurationToleranceSeconds: containerToleranceSeconds,
      audioVideoSignalOffsetToleranceSeconds: avOffsetToleranceSeconds,
      audioPulseStartSeconds,
      videoFlashTimestampSeconds,
      audioMinusVideoOffsetSeconds: expectedAvOffsetSeconds,
    },
    counts: {
      requested: result.counts.requested,
      rendered: result.counts.rendered,
      submitted: result.counts.submitted,
      encoded: result.counts.encoded,
      outputFilePackets: result.measurements.outputVideoPackets,
    },
    actual: {
      mimeType: result.measurements.mimeType,
      measuredVideoPacketRate: result.measurements.outputVideoPacketRate,
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
    audioDurationSmokePass: audio.pass,
    pass: audio.pass && frameIdentity.report.pass,
    frameIdentity: frameIdentity.report,
    artifacts: frameIdentity.artifacts,
  };
}
