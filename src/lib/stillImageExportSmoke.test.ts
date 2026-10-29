import { afterEach, describe, expect, it, vi } from 'vitest';

const exportTimelineProject = vi.hoisted(() => vi.fn());
const canvasSinkFrames = vi.hoisted(() => vi.fn(() => [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]));
const greenPixel = vi.hoisted(() => ({ value: 32 }));

vi.mock('mediabunny', () => ({
  ALL_FORMATS: [],
  BufferSource: class { constructor(readonly buffer: ArrayBuffer) {} },
  Input: class {
    constructor() {}
    async getPrimaryVideoTrack() { return {}; }
    dispose() {}
  },
  CanvasSink: class {
    constructor() {}
    async *canvases() {
      for (const timestampSeconds of canvasSinkFrames()) {
        yield {
          timestamp: timestampSeconds / 30,
          canvas: {
            width: 320,
            height: 180,
            getContext: () => ({ getImageData: () => ({ data: [210, greenPixel.value, 224, 255] }) }),
          },
        };
      }
    }
  },
}));

vi.mock('./deterministicWebmExport', () => ({
  createSequenceExportPlan: (frameCount: number, frameRate: { numerator: number; denominator: number }) => ({
    frameCount,
    durationSeconds: frameCount / (frameRate.numerator / frameRate.denominator),
    frameDurationSeconds: frameRate.denominator / frameRate.numerator,
    timestampSeconds: (index: number) => index * frameRate.denominator / frameRate.numerator,
  }),
  videoTimestampToleranceSeconds: () => 0.001,
}));

vi.mock('./timelineExport', () => ({ exportTimelineProject }));

import { runStillImageExportSmoke } from './stillImageExportSmoke';

describe('still-image streamed export smoke', () => {
  afterEach(() => {
    exportTimelineProject.mockReset();
    canvasSinkFrames.mockReset();
    canvasSinkFrames.mockImplementation(() => [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    greenPixel.value = 32;
    vi.unstubAllGlobals();
  });

  function installCanvasFixture() {
    const context = { fillStyle: '', fillRect: vi.fn() };
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => context,
      toBlob: (callback: (blob: Blob | null) => void) => callback(new Blob(['synthetic-png'], { type: 'image/png' })),
    };
    vi.stubGlobal('document', { createElement: () => canvas });
    exportTimelineProject.mockImplementation(async (request) => {
      const writer = request.outputStream.writable.getWriter();
      await writer.write({ position: 0, data: new Uint8Array([1, 2, 3, 4]) });
      await writer.close();
      await request.outputStream.prepare();
      return {
        buffer: null,
        measurements: {
          outputVideoPackets: 12,
          outputVideoDurationSeconds: 0.4,
          videoTimeResolution: 1_000_000,
          width: 320,
          height: 180,
          videoCodec: request.container === 'mp4' ? 'h264' : 'vp9',
          mimeType: request.container === 'mp4' ? 'video/mp4' : 'video/webm',
        },
      };
    });
  }

  it('streams WebM and MP4 and independently checks all decoded still-image pixels and timing', async () => {
    installCanvasFixture();
    const stages: string[] = [];

    const result = await runStillImageExportSmoke((stage) => stages.push(stage));

    expect(result.pass).toBe(true);
    expect(Object.keys(result.outputs)).toEqual(['webm', 'mp4']);
    expect(result.artifacts['timeline-still-image.webm']).toBeTruthy();
    expect(result.artifacts['timeline-still-image.mp4']).toBeTruthy();
    expect(exportTimelineProject).toHaveBeenCalledTimes(2);
    for (const [index, container] of (['webm', 'mp4'] as const).entries()) {
      const request = exportTimelineProject.mock.calls[index][0];
      expect(request.container).toBe(container);
      expect(request.outputStream).toBeDefined();
      expect(request.sourceBlobs.get('still-image-smoke-asset').type).toBe('image/png');
      const output = result.outputs[container];
      expect(output.actual.frames).toBe(12);
      expect(output.actual.centerPixels).toEqual(Array.from({ length: 12 }, () => [210, 32, 224]));
    }
    expect(stages).toContain('encoding and independently decoding still-image WEBM');
    expect(stages).toContain('encoding and independently decoding still-image MP4');
  });

  it('fails instead of accepting decoded output whose center pixels are not the still image', async () => {
    installCanvasFixture();
    greenPixel.value = 140;

    await expect(runStillImageExportSmoke()).rejects.toThrow(/Still-image WEBM smoke failed/);
  });
});
