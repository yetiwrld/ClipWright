import { ALL_FORMATS, BlobSource, EncodedPacketSink, Input, VideoSampleSink } from 'mediabunny';

export interface SequenceExpectation {
  projectId: string | null;
  projectName: string | null;
  sequenceId: string;
  sequenceName: string;
  width: number;
  height: number;
  frameRate: { numerator: number; denominator: number; value: number };
  frameCount: number;
  durationSeconds: number;
}

export interface WebmFileInspection {
  mimeType: string;
  video: {
    frames: number;
    durationSeconds: number;
    frameRate: number;
    width: number;
    height: number;
    codec: string | null;
    decodedFrames: number | null;
    decodeError: string | null;
  };
  audio: { durationSeconds: number; codec: string | null } | null;
  containerDurationSeconds: number;
}

export interface ExportFileChecks {
  expectedDurationSeconds: number;
  durationToleranceSeconds: number;
  actualVideoFrames: number;
  missingExportFrames: number;
  extraOutputFrames: number;
  frameCoveragePercent: number;
  videoDurationDifferenceSeconds: number;
  videoDurationWithinOneFrame: boolean;
  audioDurationDifferenceSeconds: number | null;
  audioDurationWithinOneFrame: boolean | null;
  containerDurationDifferenceSeconds: number;
  containerDurationWithinOneFrame: boolean;
  frameCountExact: boolean;
}

export function readActiveSequenceExpectationFromJson(json: string): SequenceExpectation {
  let projectDocument: unknown;
  try { projectDocument = JSON.parse(json); }
  catch { throw new Error('Selected project file is not valid JSON.'); }
  return readActiveSequenceExpectation(projectDocument);
}

export function measureExportFile(expectation: SequenceExpectation, inspection: WebmFileInspection): ExportFileChecks {
  const actualVideoFrames = inspection.video.frames;
  const videoDurationDifferenceSeconds = inspection.video.durationSeconds - expectation.durationSeconds;
  const audioDurationDifferenceSeconds = inspection.audio ? inspection.audio.durationSeconds - expectation.durationSeconds : null;
  const containerDurationDifferenceSeconds = inspection.containerDurationSeconds - expectation.durationSeconds;
  const durationToleranceSeconds = expectation.frameRate.denominator / expectation.frameRate.numerator;
  return {
    expectedDurationSeconds: expectation.durationSeconds,
    durationToleranceSeconds,
    actualVideoFrames,
    missingExportFrames: Math.max(0, expectation.frameCount - actualVideoFrames),
    extraOutputFrames: Math.max(0, actualVideoFrames - expectation.frameCount),
    frameCoveragePercent: actualVideoFrames / expectation.frameCount * 100,
    videoDurationDifferenceSeconds,
    videoDurationWithinOneFrame: Math.abs(videoDurationDifferenceSeconds) <= durationToleranceSeconds,
    audioDurationDifferenceSeconds,
    audioDurationWithinOneFrame: audioDurationDifferenceSeconds === null ? null : Math.abs(audioDurationDifferenceSeconds) <= durationToleranceSeconds,
    containerDurationDifferenceSeconds,
    containerDurationWithinOneFrame: Math.abs(containerDurationDifferenceSeconds) <= durationToleranceSeconds,
    frameCountExact: actualVideoFrames === expectation.frameCount,
  };
}

export function readActiveSequenceExpectation(projectDocument: unknown): SequenceExpectation {
  if (!projectDocument || typeof projectDocument !== 'object') throw new Error('Selected sequence file is not a project document.');
  const document = projectDocument as Record<string, unknown>;
  const settings = document.projectSettings as Record<string, unknown> | undefined;
  const sequences = document.sequences as Array<Record<string, unknown>> | undefined;
  const sequenceId = settings?.defaultSequenceId;
  const sequence = sequences?.find((item) => item.id === sequenceId) ?? (sequences?.length === 1 ? sequences[0] : undefined);
  if (!sequence) throw new Error('The selected project document does not contain its active default sequence.');
  const frameRate = sequence.frameRate as { numerator?: unknown; denominator?: unknown } | undefined;
  const numerator = frameRate?.numerator;
  const denominator = frameRate?.denominator;
  const frameCount = sequence.durationFrames;
  const width = sequence.width;
  const height = sequence.height;
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || Number(numerator) <= 0 || Number(denominator) <= 0) throw new Error('The active sequence has an invalid rational frame rate.');
  if (!Number.isSafeInteger(frameCount) || Number(frameCount) <= 0) throw new Error('The active sequence has no valid export frame count. Save the project after adding or changing timeline clips.');
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || Number(width) <= 0 || Number(height) <= 0) throw new Error('The active sequence has invalid dimensions.');
  const fpsNumerator = Number(numerator);
  const fpsDenominator = Number(denominator);
  return {
    projectId: typeof document.id === 'string' ? document.id : null,
    projectName: typeof (document.metadata as Record<string, unknown> | undefined)?.name === 'string' ? String((document.metadata as Record<string, unknown>).name) : null,
    sequenceId: String(sequence.id),
    sequenceName: typeof sequence.name === 'string' ? sequence.name : String(sequence.id),
    width: Number(width),
    height: Number(height),
    frameRate: { numerator: fpsNumerator, denominator: fpsDenominator, value: fpsNumerator / fpsDenominator },
    frameCount: Number(frameCount),
    durationSeconds: Number(frameCount) * fpsDenominator / fpsNumerator,
  };
}

export async function inspectWebmFile(file: Blob): Promise<WebmFileInspection> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) throw new Error('The selected file has no readable video track.');
    const packetSink = new EncodedPacketSink(videoTrack);
    let frames = 0;
    for await (const _packet of packetSink.packets()) frames += 1;
    const durationSeconds = await videoTrack.computeDuration();
    const width = await videoTrack.getDisplayWidth();
    const height = await videoTrack.getDisplayHeight();
    const codec = await videoTrack.getCodec();
    let decodedFrames: number | null = null;
    let decodeError: string | null = null;
    try {
      const sampleSink = new VideoSampleSink(videoTrack);
      decodedFrames = 0;
      for await (const sample of sampleSink.samples()) {
        decodedFrames += 1;
        sample.close();
      }
    } catch (error) {
      decodeError = error instanceof Error ? error.message : 'The file decoder failed without a diagnostic.';
      decodedFrames = null;
    }
    const audioTrack = await input.getPrimaryAudioTrack();
    const audio = audioTrack ? {
      durationSeconds: await audioTrack.computeDuration(),
      codec: await audioTrack.getCodec(),
    } : null;
    return {
      mimeType: await input.getMimeType(),
      video: {
        frames,
        durationSeconds,
        frameRate: durationSeconds > 0 ? frames / durationSeconds : 0,
        width,
        height,
        codec,
        decodedFrames,
        decodeError,
      },
      audio,
      containerDurationSeconds: await input.computeDuration(),
    };
  } finally {
    input.dispose();
  }
}
