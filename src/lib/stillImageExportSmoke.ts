import { ALL_FORMATS, BufferSource, CanvasSink, Input } from 'mediabunny';
import { createSequenceExportPlan, videoTimestampToleranceSeconds } from './deterministicWebmExport';
import { exportTimelineProject } from './timelineExport';
import type { ExportOutputStream } from './deterministicWebmExport';
import type { ProjectDocument } from './projectDocument';

const WIDTH = 320;
const HEIGHT = 180;
const FRAME_RATE = { numerator: 30, denominator: 1 };
const FRAME_COUNT = 12;
const IMAGE_ASSET_ID = 'still-image-smoke-asset';
type StillImageOutputSummary = {
  passed: boolean;
  expected: { width: number; height: number; frames: number; durationSeconds: number; centerColor: string };
  actual: {
    width: number;
    height: number;
    frames: number;
    durationSeconds: number;
    timestamps: number[];
    centerPixels: number[][];
    videoCodec: string | null;
    mimeType: string;
  };
};

function memoryOutputStream(): ExportOutputStream & { getBuffer(): ArrayBuffer } {
  const chunks: Array<{ position: number; data: Uint8Array }> = [];
  let output: Uint8Array | null = null;
  return {
    writable: new WritableStream({ write: ({ position, data }) => { chunks.push({ position, data: new Uint8Array(data) }); } }),
    prepare: async () => {
      const size = chunks.reduce((maximum, chunk) => Math.max(maximum, chunk.position + chunk.data.byteLength), 0);
      output = new Uint8Array(size);
      for (const chunk of chunks) output.set(chunk.data, chunk.position);
      chunks.length = 0;
      return size;
    },
    read: async (start, end) => {
      if (!output || start < 0 || end <= start || end > output.byteLength) throw new Error('Still-image smoke read range is invalid.');
      return output.slice(start, end);
    },
    getBuffer: () => {
      if (!output) throw new Error('Still-image smoke output has not been prepared.');
      return output.buffer;
    },
  };
}

async function createSyntheticImage() {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 36;
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('Could not create the still-image smoke fixture.');
  context.fillStyle = '#d020e0';
  context.fillRect(0, 0, canvas.width, canvas.height);
  return new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Could not encode the still-image smoke PNG.')), 'image/png'));
}

function createStillImageProject(image: Blob): ProjectDocument {
  const clipDuration = FRAME_COUNT / (FRAME_RATE.numerator / FRAME_RATE.denominator);
  return {
    schemaVersion: 2,
    appVersion: 'still-image-smoke',
    id: 'still-image-smoke-project',
    metadata: { name: 'Still image export smoke', createdAt: '2026-01-01T00:00:00.000Z', modifiedAt: '2026-01-01T00:00:00.000Z' },
    projectSettings: { defaultSequenceId: 'still-image-smoke-sequence' },
    assets: [{
      id: IMAGE_ASSET_ID, name: 'smoke-still.png', sourcePath: 'smoke-still.png', pathKind: 'browser-session', kind: 'image',
      streams: {}, fileSizeBytes: image.size, imageDimensions: { width: 64, height: 36 },
    }],
    sequences: [{
      id: 'still-image-smoke-sequence', name: 'Still image smoke', width: WIDTH, height: HEIGHT,
      frameRate: FRAME_RATE, audioSampleRate: 48_000, durationFrames: FRAME_COUNT,
      tracks: [
        { id: 'still-image-video-track', name: 'Video 1', kind: 'video', muted: false, locked: false, clips: [{
          id: 'still-image-smoke-clip', sourceId: IMAGE_ASSET_ID, trackId: 'still-image-video-track', start: 0, trimIn: 0, trimOut: clipDuration,
        }] },
        { id: 'still-image-audio-track', name: 'Audio 1', kind: 'audio', muted: false, locked: false, clips: [] },
      ],
    }],
  };
}

async function inspectEncodedStill(buffer: ArrayBuffer) {
  const input = new Input({ source: new BufferSource(buffer), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('Still-image export has no video track.');
    const sink = new CanvasSink(track, { alpha: false, poolSize: 1 });
    const frames: Array<{ timestampSeconds: number; color: number[] }> = [];
    for await (const frame of sink.canvases()) {
      const context = frame.canvas.getContext('2d');
      if (!context) throw new Error('Could not inspect an encoded still-image frame.');
      const x = Math.floor(frame.canvas.width / 2);
      const y = Math.floor(frame.canvas.height / 2);
      frames.push({ timestampSeconds: frame.timestamp, color: [...context.getImageData(x, y, 1, 1).data].slice(0, 3) });
    }
    return frames;
  } finally {
    input.dispose();
  }
}

/** Packaged-runtime smoke: validate still-image composition in actual WebM and MP4 frame decodes. */
export async function runStillImageExportSmoke(onStage: (stage: string) => void = () => undefined) {
  const image = await createSyntheticImage();
  const project = createStillImageProject(image);
  const plan = createSequenceExportPlan(FRAME_COUNT, FRAME_RATE);
  const outputs: Partial<Record<'webm' | 'mp4', StillImageOutputSummary>> = {};
  const artifacts: Record<string, string> = {};
  for (const container of ['webm', 'mp4'] as const) {
    onStage(`encoding and independently decoding still-image ${container.toUpperCase()}`);
    const stream = memoryOutputStream();
    const result = await exportTimelineProject({
      projectSnapshot: project,
      sourceBlobs: new Map([[IMAGE_ASSET_ID, image]]),
      sequenceId: project.projectSettings.defaultSequenceId,
      resolution: 'sequence',
      quality: 'standard',
      container,
      signal: new AbortController().signal,
      outputStream: stream,
    });
    if (result.buffer !== null) throw new Error(`Still-image ${container.toUpperCase()} smoke retained a full export buffer.`);
    const encodedBuffer = stream.getBuffer();
    const bytes = new Uint8Array(encodedBuffer);
    let binary = '';
    for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    artifacts[`timeline-still-image.${container}`] = btoa(binary);
    const frames = await inspectEncodedStill(encodedBuffer);
    const timestampTolerance = videoTimestampToleranceSeconds(plan.frameDurationSeconds, 1 / result.measurements.videoTimeResolution);
    const frameCountMatches = frames.length === FRAME_COUNT && result.measurements.outputVideoPackets === FRAME_COUNT;
    const timestampsMatch = frames.every((frame, index) => Math.abs(frame.timestampSeconds - plan.timestampSeconds(index)) <= timestampTolerance);
    const centerPixelsMatch = frames.length === FRAME_COUNT && frames.every(({ color: [red, green, blue] }) => red > 130 && green < 110 && blue > 130);
    const dimensionsMatch = result.measurements.width === WIDTH && result.measurements.height === HEIGHT;
    const durationMatches = Math.abs(result.measurements.outputVideoDurationSeconds - plan.durationSeconds) <= timestampTolerance;
    const passed = frameCountMatches && timestampsMatch && centerPixelsMatch && dimensionsMatch && durationMatches;
    outputs[container] = {
      passed,
      expected: { width: WIDTH, height: HEIGHT, frames: FRAME_COUNT, durationSeconds: plan.durationSeconds, centerColor: 'magenta' },
      actual: {
        width: result.measurements.width,
        height: result.measurements.height,
        frames: frames.length,
        durationSeconds: result.measurements.outputVideoDurationSeconds,
        timestamps: frames.map((frame) => frame.timestampSeconds),
        centerPixels: frames.map((frame) => frame.color),
        videoCodec: result.measurements.videoCodec,
        mimeType: result.measurements.mimeType,
      },
    };
    if (!passed) throw new Error(`Still-image ${container.toUpperCase()} smoke failed: ${JSON.stringify(outputs[container])}`);
  }
  if (!outputs.webm || !outputs.mp4) throw new Error('Still-image smoke did not produce both encoded containers.');
  return { pass: true, fixture: 'single-image-clip', outputs: { webm: outputs.webm, mp4: outputs.mp4 }, artifacts };
}
