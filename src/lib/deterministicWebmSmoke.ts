import { areExportFrameCountsExact, createSequenceExportPlan, encodeDeterministicWebm } from './deterministicWebmExport';

export async function runDeterministicWebmSmoke() {
  const frameRate = { numerator: 30, denominator: 1 };
  const plan = createSequenceExportPlan(30, frameRate);
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 180;
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('The packaged renderer could not create a WebM smoke-test canvas.');
  const offlineAudio = new OfflineAudioContext(2, 24_000, 48_000);
  const audioBuffer = offlineAudio.createBuffer(2, 24_000, 48_000);
  const controller = new AbortController();
  const result = await encodeDeterministicWebm({
    canvas,
    plan,
    videoBitrate: 300_000,
    audioBitrate: 64_000,
    includeAudio: true,
    signal: controller.signal,
    drawFrame: async (frameIndex) => {
      context.fillStyle = frameIndex % 2 === 0 ? '#ff7418' : '#1769aa';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = '#fff';
      context.fillRect(frameIndex * 8 % canvas.width, 64, 24, 24);
    },
    renderAudioChunk: async () => audioBuffer,
  });
  const expectedDuration = plan.durationSeconds;
  const tolerance = plan.frameDurationSeconds;
  const videoDelta = result.measurements.outputVideoDurationSeconds - expectedDuration;
  const audioDelta = result.measurements.outputAudioDurationSeconds === null ? null : result.measurements.outputAudioDurationSeconds - expectedDuration;
  const containerDelta = result.measurements.outputContainerDurationSeconds - expectedDuration;
  const countsMatch = areExportFrameCountsExact(plan.frameCount, {
    ...result.counts,
    outputFile: result.measurements.outputVideoFrames,
  });
  const durationsMatch = Math.abs(videoDelta) <= tolerance
    && audioDelta !== null && Math.abs(audioDelta) <= tolerance
    && Math.abs(containerDelta) <= tolerance;
  return {
    pass: countsMatch && durationsMatch,
    expected: {
      frameRate,
      frameCount: plan.frameCount,
      frameAlignedVideoDurationSeconds: expectedDuration,
      oneFrameToleranceSeconds: tolerance,
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
      videoDimensions: { width: canvas.width, height: canvas.height },
    },
  };
}
