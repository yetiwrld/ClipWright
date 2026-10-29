import { describe, expect, it } from 'vitest';
import { exportResolutionLabel, getExportBitrates, getExportDimensions } from './exportResolution';

describe('export resolution presets', () => {
  it('keeps sequence dimensions as the default', () => {
    expect(getExportDimensions(1920, 1080, 'sequence')).toEqual({ width: 1920, height: 1080 });
  });

  it('keeps custom project-canvas dimensions exact for both landscape and portrait selections', () => {
    expect(getExportDimensions(234, 146, 'sequence')).toEqual({ width: 234, height: 146 });
    expect(getExportDimensions(180, 320, 'sequence')).toEqual({ width: 180, height: 320 });
  });

  it('scales landscape sequences down to even long-edge presets', () => {
    expect(getExportDimensions(1920, 1080, '720p')).toEqual({ width: 1280, height: 720 });
    expect(getExportDimensions(1920, 1080, '540p')).toEqual({ width: 960, height: 540 });
    expect(getExportDimensions(1920, 1080, '360p')).toEqual({ width: 640, height: 360 });
  });

  it('preserves portrait orientation and avoids upscaling', () => {
    expect(getExportDimensions(1080, 1920, '720p')).toEqual({ width: 720, height: 1280 });
    expect(getExportDimensions(360, 640, '720p')).toEqual({ width: 360, height: 640 });
    expect(getExportDimensions(20, 16384, '720p')).toEqual({ width: 2, height: 1280 });
  });

  it('rounds odd custom dimensions down to even output dimensions', () => {
    expect(getExportDimensions(1001, 751, 'sequence')).toEqual({ width: 1001, height: 751 });
    const output = getExportDimensions(1001, 751, '360p');
    expect(output.width % 2).toBe(0);
    expect(output.height % 2).toBe(0);
    expect(output.width).toBeLessThanOrEqual(640);
  });

  it('maps quality presets to bounded browser encoder targets', () => {
    const compact = getExportBitrates(1280, 720, 30, 'compact');
    const standard = getExportBitrates(1280, 720, 30, 'standard');
    const high = getExportBitrates(1280, 720, 30, 'high');
    expect(compact.videoBitsPerSecond).toBeLessThan(standard.videoBitsPerSecond);
    expect(standard.videoBitsPerSecond).toBeLessThan(high.videoBitsPerSecond);
    expect(high.audioBitsPerSecond).toBe(192_000);
    expect(getExportBitrates(16384, 16384, 240, 'high').videoBitsPerSecond).toBe(50_000_000);
  });

  it('rejects invalid dimensions and describes the actual selected output size', () => {
    expect(() => getExportDimensions(0, 1080, '360p')).toThrow(RangeError);
    expect(exportResolutionLabel(1920, 1080, '540p')).toBe('540p (960 × 540)');
  });
});
