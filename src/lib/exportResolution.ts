export type ExportResolutionPreset = 'sequence' | '720p' | '540p' | '360p';
export type ExportQualityPreset = 'compact' | 'standard' | 'high';

const QUALITY_FACTORS: Record<ExportQualityPreset, { video: number; audio: number }> = {
  compact: { video: 0.035, audio: 96_000 },
  standard: { video: 0.065, audio: 160_000 },
  high: { video: 0.12, audio: 192_000 },
};

const MAX_LONG_EDGE: Record<Exclude<ExportResolutionPreset, 'sequence'>, number> = {
  '720p': 1280,
  '540p': 960,
  '360p': 640,
};

function evenDimension(value: number): number {
  return Math.max(2, Math.floor(value / 2) * 2);
}

/** Keeps sequence dimensions exact; downscaled presets use even sizes and preserve aspect ratio as closely as possible. */
export function getExportDimensions(width: number, height: number, preset: ExportResolutionPreset): { width: number; height: number } {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 16 || height < 16) {
    throw new RangeError('Sequence dimensions must be finite and at least 16 pixels.');
  }
  if (preset === 'sequence') return { width, height };
  const scale = Math.min(1, MAX_LONG_EDGE[preset] / Math.max(width, height));
  return {
    width: evenDimension(width * scale),
    height: evenDimension(height * scale),
  };
}

export function getExportBitrates(width: number, height: number, frameRate: number, quality: ExportQualityPreset): { videoBitsPerSecond: number; audioBitsPerSecond: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || !Number.isFinite(frameRate) || width < 16 || height < 16 || frameRate <= 0) {
    throw new RangeError('Export dimensions and frame rate must be finite and positive.');
  }
  const videoBitsPerSecond = Math.round(width * height * frameRate * QUALITY_FACTORS[quality].video);
  return {
    videoBitsPerSecond: Math.max(300_000, Math.min(50_000_000, videoBitsPerSecond)),
    audioBitsPerSecond: QUALITY_FACTORS[quality].audio,
  };
}

export function exportResolutionLabel(width: number, height: number, preset: ExportResolutionPreset): string {
  if (preset === 'sequence') return `Sequence (${width} × ${height})`;
  const dimensions = getExportDimensions(width, height, preset);
  return `${preset} (${dimensions.width} × ${dimensions.height})`;
}
