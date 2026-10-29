export type TimelineMediaKind = 'video' | 'audio' | 'image';
export type TimelineTrackKind = 'video' | 'audio';

/**
 * Video files may carry an embedded audio stream even when older project documents
 * have no audio metadata. Inspect those sources at export time rather than silently
 * omitting their sound.
 */
export function shouldInspectAudioStream(trackKind: TimelineTrackKind, assetKind: TimelineMediaKind, hasDeclaredAudioStream: boolean): boolean {
  return trackKind === 'audio' || assetKind === 'video' || hasDeclaredAudioStream;
}
