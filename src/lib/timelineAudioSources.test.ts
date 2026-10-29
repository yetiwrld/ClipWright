import { describe, expect, it } from 'vitest';
import { shouldInspectAudioStream } from './timelineAudioSources';

describe('timeline export audio-source selection', () => {
  it('inspects video clips for embedded audio even when older project metadata has no audio stream', () => {
    expect(shouldInspectAudioStream('video', 'video', false)).toBe(true);
  });

  it('keeps dedicated audio clips and declared audio streams eligible', () => {
    expect(shouldInspectAudioStream('audio', 'audio', false)).toBe(true);
    expect(shouldInspectAudioStream('video', 'video', true)).toBe(true);
  });

  it('does not inspect still images as audio sources', () => {
    expect(shouldInspectAudioStream('video', 'image', false)).toBe(false);
  });
});
