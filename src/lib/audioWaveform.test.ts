import { describe, expect, it } from 'vitest';
import { calculateWaveformPeaks } from './audioWaveform';

describe('audio waveform peak envelope', () => {
  it('combines channels and normalizes each time bucket', () => {
    const left = new Float32Array([0.1, -0.2, 0.8, 0.1]);
    const right = new Float32Array([0.3, 0.1, -1.4, 0.2]);
    const peaks = calculateWaveformPeaks([left, right], 2);
    expect(peaks[0]).toBeCloseTo(0.3, 5);
    expect(peaks[1]).toBe(1);
  });

  it('returns silence for silent channels and an empty envelope for no samples', () => {
    expect(calculateWaveformPeaks([new Float32Array(8)], 4)).toEqual([0, 0, 0, 0]);
    expect(calculateWaveformPeaks([], 4)).toEqual([]);
  });

  it('caps output complexity and rejects an unreasonable bucket request', () => {
    expect(calculateWaveformPeaks([new Float32Array([0.5])], 512)).toHaveLength(512);
    expect(() => calculateWaveformPeaks([], 513)).toThrow(RangeError);
  });
});
