/** Downsample channel audio to a compact, normalized peak envelope for timeline display. */
export function calculateWaveformPeaks(channels: readonly Float32Array[], bucketCount = 120): number[] {
  if (!Number.isInteger(bucketCount) || bucketCount < 1 || bucketCount > 512) {
    throw new RangeError('Waveform bucket count must be between 1 and 512.');
  }
  const sampleCount = channels.reduce((largest, channel) => Math.max(largest, channel.length), 0);
  if (!channels.length || sampleCount === 0) return [];

  return Array.from({ length: bucketCount }, (_, bucket) => {
    const start = Math.floor(bucket * sampleCount / bucketCount);
    const end = Math.max(start + 1, Math.ceil((bucket + 1) * sampleCount / bucketCount));
    let peak = 0;
    for (const channel of channels) {
      const channelEnd = Math.min(channel.length, end);
      for (let sample = Math.min(start, channel.length); sample < channelEnd; sample += 1) {
        const value = channel[sample];
        if (Number.isFinite(value)) peak = Math.max(peak, Math.abs(value));
      }
    }
    return Math.min(1, peak);
  });
}
