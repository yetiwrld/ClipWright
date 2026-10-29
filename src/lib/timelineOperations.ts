import type { ProjectDocument, Sequence, TimelineClip, Track } from './projectDocument';
import { frameCountForEndTime } from './frameTime';

type TimelineOptions = { modifiedAt?: string };

function getSequence(document: ProjectDocument, sequenceId: string) {
  const sequence = document.sequences.find((item) => item.id === sequenceId);
  if (!sequence) throw new Error('The selected sequence is not part of this project.');
  return sequence;
}

export function frameRateOf(sequence: Sequence) {
  return sequence.frameRate.numerator / sequence.frameRate.denominator;
}

export function quantizeTimelineTime(seconds: number, sequence: Sequence) {
  if (!Number.isFinite(seconds)) throw new Error('Timeline times must be finite.');
  const fps = frameRateOf(sequence);
  return Math.max(0, Math.round(seconds * fps) / fps);
}

export function clipDuration(clip: TimelineClip) {
  return clip.trimOut - clip.trimIn;
}

export function clipEnd(clip: TimelineClip) {
  return clip.start + clipDuration(clip);
}

export function sequenceDurationSeconds(sequence: Sequence) {
  return sequence.durationFrames * sequence.frameRate.denominator / sequence.frameRate.numerator;
}

export function sequenceDurationInFrames(sequence: Sequence) {
  const finalClipEnd = sequence.tracks.flatMap((track) => track.clips).reduce((end, clip) => Math.max(end, clipEnd(clip)), 0);
  return frameCountForEndTime(finalClipEnd, sequence.frameRate);
}

function withSequence(document: ProjectDocument, sequence: Sequence, modifiedAt?: string): ProjectDocument {
  const updatedSequence = { ...sequence, durationFrames: sequenceDurationInFrames(sequence) };
  return {
    ...document,
    metadata: { ...document.metadata, modifiedAt: modifiedAt ?? new Date().toISOString() },
    sequences: document.sequences.map((item) => item.id === sequence.id ? updatedSequence : item),
  };
}

function getSourceDuration(document: ProjectDocument, sourceId: string, kind: Track['kind']) {
  const asset = document.assets.find((item) => item.id === sourceId);
  if (!asset || asset.kind !== kind) throw new Error('The selected source does not match the destination track type.');
  const stream = asset.streams[kind];
  if (!stream) throw new Error('The selected source has no usable media stream.');
  return stream.durationTicks * stream.timeBase.numerator / stream.timeBase.denominator;
}

function getClip(sequence: Sequence, clipId: string) {
  for (const track of sequence.tracks) {
    const clip = track.clips.find((item) => item.id === clipId);
    if (clip) return { track, clip };
  }
  throw new Error('The selected timeline clip could not be found.');
}

function assertNoOverlap(clips: TimelineClip[]) {
  const ordered = [...clips].sort((a, b) => a.start - b.start);
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index].start < clipEnd(ordered[index - 1]) - 1e-7) {
      throw new Error('Clips on the same track cannot overlap.');
    }
  }
}

function normalizeTrack(track: Track, clips: TimelineClip[]) {
  const normalized = clips.map((clip) => ({ ...clip, trackId: track.id })).sort((a, b) => a.start - b.start);
  assertNoOverlap(normalized);
  return { ...track, clips: normalized };
}

export function addTimelineClip(
  document: ProjectDocument,
  sequenceId: string,
  sourceId: string,
  trackId: string,
  start: number,
  clipId: string = crypto.randomUUID(),
  options: TimelineOptions = {},
) {
  const sequence = getSequence(document, sequenceId);
  const track = sequence.tracks.find((item) => item.id === trackId);
  if (!track || track.locked) throw new Error('Choose an unlocked destination track.');
  const assetDuration = getSourceDuration(document, sourceId, track.kind);
  const trimOut = Math.floor(assetDuration * frameRateOf(sequence) + 1e-7) / frameRateOf(sequence);
  if (trimOut <= 0) throw new Error('The source is shorter than one sequence frame.');
  const clip: TimelineClip = {
    id: clipId,
    sourceId,
    trackId,
    start: quantizeTimelineTime(start, sequence),
    trimIn: 0,
    trimOut: Math.min(trimOut, assetDuration),
  };
  const updatedTrack = normalizeTrack(track, [...track.clips, clip]);
  const updatedSequence = { ...sequence, tracks: sequence.tracks.map((item) => item.id === trackId ? updatedTrack : item) };
  return withSequence(document, updatedSequence, options.modifiedAt);
}

/** Append a source to the end of the first unlocked video track. */
export function appendVideoClip(document: ProjectDocument, sequenceId: string, sourceId: string, clipId: string = crypto.randomUUID(), options: TimelineOptions = {}) {
  const sequence = getSequence(document, sequenceId);
  const track = sequence.tracks.find((item) => item.kind === 'video' && !item.locked);
  if (!track) throw new Error('This sequence has no unlocked video track.');
  const start = track.clips.reduce((end, clip) => Math.max(end, clipEnd(clip)), 0);
  return addTimelineClip(document, sequenceId, sourceId, track.id, start, clipId, options);
}

export function moveTimelineClips(
  document: ProjectDocument,
  sequenceId: string,
  clipIds: string[],
  targetTrackId: string,
  targetStart: number,
  ripple = false,
  options: TimelineOptions = {},
) {
  const sequence = getSequence(document, sequenceId);
  const targetTrack = sequence.tracks.find((track) => track.id === targetTrackId);
  if (!targetTrack || targetTrack.locked) throw new Error('Choose an unlocked destination track.');
  const selected = sequence.tracks.flatMap((track) => track.clips.filter((clip) => clipIds.includes(clip.id)).map((clip) => ({ track, clip })));
  if (!selected.length || selected.some(({ track }) => track.locked || track.kind !== targetTrack.kind)) throw new Error('Clips can only move between unlocked tracks of the same type.');
  if (new Set(selected.map(({ clip }) => clip.id)).size !== clipIds.length) throw new Error('A selected clip is no longer available.');
  const firstStart = Math.min(...selected.map(({ clip }) => clip.start));
  const delta = quantizeTimelineTime(targetStart, sequence) - firstStart;
  if (Math.abs(delta) < 1e-9 && selected.every(({ track }) => track.id === targetTrackId)) return document;
  const movedIds = new Set(clipIds);
  const oldEndByTrack = new Map<string, number>();
  for (const { track, clip } of selected) oldEndByTrack.set(track.id, Math.max(oldEndByTrack.get(track.id) ?? 0, clipEnd(clip)));
  let tracks = sequence.tracks.map((track) => {
    if (track.locked && track.clips.some((clip) => movedIds.has(clip.id))) throw new Error('Unlock the source track before moving clips.');
    let clips = track.clips.filter((clip) => !movedIds.has(clip.id));
    if (ripple && oldEndByTrack.has(track.id)) {
      const oldEnd = oldEndByTrack.get(track.id)!;
      clips = clips.map((clip) => clip.start >= oldEnd - 1e-7 ? { ...clip, start: quantizeTimelineTime(clip.start + delta, sequence) } : clip);
    }
    return { ...track, clips };
  });
  const moved = selected.map(({ clip }) => ({ ...clip, trackId: targetTrackId, start: quantizeTimelineTime(clip.start + delta, sequence) }));
  tracks = tracks.map((track) => track.id === targetTrackId ? normalizeTrack(track, [...track.clips, ...moved]) : normalizeTrack(track, track.clips));
  return withSequence(document, { ...sequence, tracks }, options.modifiedAt);
}

export function moveVideoClip(document: ProjectDocument, sequenceId: string, clipId: string, start: number, options: TimelineOptions = {}) {
  const sequence = getSequence(document, sequenceId);
  const { clip } = getClip(sequence, clipId);
  return moveTimelineClips(document, sequenceId, [clipId], clip.trackId, start, false, options);
}

export function resizeTimelineClip(
  document: ProjectDocument,
  sequenceId: string,
  clipId: string,
  start: number,
  trimIn: number,
  trimOut: number,
  ripple = false,
  options: TimelineOptions = {},
) {
  const sequence = getSequence(document, sequenceId);
  const { track, clip } = getClip(sequence, clipId);
  if (track.locked) throw new Error('Unlock the source track before trimming clips.');
  const sourceDuration = getSourceDuration(document, clip.sourceId, track.kind);
  const nextTrimIn = quantizeTimelineTime(trimIn, sequence);
  const maxTrimOut = Math.floor(sourceDuration * frameRateOf(sequence) + 1e-7) / frameRateOf(sequence);
  const nextTrimOut = Math.min(maxTrimOut, quantizeTimelineTime(trimOut, sequence));
  if (nextTrimIn < 0 || nextTrimOut - nextTrimIn < 1 / frameRateOf(sequence) - 1e-7 || nextTrimOut > sourceDuration + 1e-7) {
    throw new Error('Trim edges must keep at least one frame and stay within the source media.');
  }
  const nextStart = quantizeTimelineTime(start, sequence);
  const nextClip = { ...clip, start: nextStart, trimIn: nextTrimIn, trimOut: nextTrimOut };
  const endDelta = clipEnd(nextClip) - clipEnd(clip);
  let clips = track.clips.map((item) => item.id === clipId ? nextClip : item);
  if (ripple && Math.abs(endDelta) > 1e-9) {
    const oldEnd = clipEnd(clip);
    clips = clips.map((item) => item.id !== clipId && item.start >= oldEnd - 1e-7
      ? { ...item, start: quantizeTimelineTime(item.start + endDelta, sequence) }
      : item);
  }
  const updatedTrack = normalizeTrack(track, clips);
  const tracks = sequence.tracks.map((item) => item.id === track.id ? updatedTrack : item);
  return withSequence(document, { ...sequence, tracks }, options.modifiedAt);
}

export function trimTimelineClip(document: ProjectDocument, sequenceId: string, clipId: string, trimIn: number, trimOut: number, ripple = false, options: TimelineOptions = {}) {
  const sequence = getSequence(document, sequenceId);
  const { clip } = getClip(sequence, clipId);
  return resizeTimelineClip(document, sequenceId, clipId, clip.start, trimIn, trimOut, ripple, options);
}

export function trimVideoClip(document: ProjectDocument, sequenceId: string, clipId: string, trimIn: number, trimOut: number, options: TimelineOptions = {}) {
  return trimTimelineClip(document, sequenceId, clipId, trimIn, trimOut, false, options);
}

export function splitTimelineClip(document: ProjectDocument, sequenceId: string, clipId: string, at: number, newClipId: string = crypto.randomUUID(), options: TimelineOptions = {}) {
  const sequence = getSequence(document, sequenceId);
  const { track, clip } = getClip(sequence, clipId);
  if (track.locked) throw new Error('Unlock the source track before splitting clips.');
  const cut = quantizeTimelineTime(at, sequence);
  if (cut <= clip.start + 1e-7 || cut >= clipEnd(clip) - 1e-7) throw new Error('Place the playhead inside the selected clip to split it.');
  const splitSourceTime = quantizeTimelineTime(clip.trimIn + cut - clip.start, sequence);
  const left = { ...clip, trimOut: splitSourceTime };
  const right: TimelineClip = { ...clip, id: newClipId, start: cut, trimIn: splitSourceTime };
  const updatedTrack = normalizeTrack(track, track.clips.flatMap((item) => item.id === clipId ? [left, right] : [item]));
  const tracks = sequence.tracks.map((item) => item.id === track.id ? updatedTrack : item);
  return withSequence(document, { ...sequence, tracks }, options.modifiedAt);
}

export function removeTimelineClips(document: ProjectDocument, sequenceId: string, clipIds: string[], ripple = false, options: TimelineOptions = {}) {
  const sequence = getSequence(document, sequenceId);
  const requested = new Set(clipIds);
  let found = 0;
  const tracks = sequence.tracks.map((track) => {
    const deleted = track.clips.filter((clip) => requested.has(clip.id));
    if (!deleted.length) return track;
    if (track.locked) throw new Error('Unlock selected tracks before deleting their clips.');
    found += deleted.length;
    const deletedIds = new Set(deleted.map((clip) => clip.id));
    let clips = track.clips.filter((clip) => !deletedIds.has(clip.id));
    if (ripple) {
      const orderedDeleted = [...deleted].sort((a, b) => a.start - b.start);
      clips = clips.map((clip) => {
        const shift = orderedDeleted.filter((removed) => clipEnd(removed) <= clip.start + 1e-7).reduce((total, removed) => total + clipDuration(removed), 0);
        return shift ? { ...clip, start: quantizeTimelineTime(clip.start - shift, sequence) } : clip;
      });
    }
    return normalizeTrack(track, clips);
  });
  if (!found) throw new Error('No selected timeline clips were found.');
  return withSequence(document, { ...sequence, tracks }, options.modifiedAt);
}

export function removeVideoClip(document: ProjectDocument, sequenceId: string, clipId: string, options: TimelineOptions = {}) {
  return removeTimelineClips(document, sequenceId, [clipId], false, options);
}

export function duplicateTimelineClips(document: ProjectDocument, sequenceId: string, clipIds: string[], newIds: string[], at?: number, options: TimelineOptions = {}) {
  const sequence = getSequence(document, sequenceId);
  const copies = sequence.tracks.flatMap((track) => track.clips.filter((clip) => clipIds.includes(clip.id)).map((clip) => ({ track, clip })));
  if (!copies.length || newIds.length !== copies.length) throw new Error('The selected clips could not be duplicated.');
  const earliestStart = Math.min(...copies.map(({ clip }) => clip.start));
  const adjacentStart = Math.max(...copies.map(({ clip }) => clipEnd(clip)));
  const duplicateStart = at === undefined ? adjacentStart : quantizeTimelineTime(at, sequence);
  const newByTrack = new Map<string, TimelineClip[]>();
  copies.forEach(({ track, clip }, index) => {
    if (track.locked) throw new Error('Unlock selected tracks before duplicating clips.');
    const clone = { ...clip, id: newIds[index], start: quantizeTimelineTime(duplicateStart + clip.start - earliestStart, sequence) };
    newByTrack.set(track.id, [...(newByTrack.get(track.id) ?? []), clone]);
  });
  const tracks = sequence.tracks.map((track) => newByTrack.has(track.id)
    ? normalizeTrack(track, [...track.clips, ...newByTrack.get(track.id)!])
    : track);
  return withSequence(document, { ...sequence, tracks }, options.modifiedAt);
}

export function pasteTimelineClips(document: ProjectDocument, sequenceId: string, templates: TimelineClip[], at: number, newIds: string[], options: TimelineOptions = {}) {
  const sequence = getSequence(document, sequenceId);
  if (!templates.length || templates.length !== newIds.length) throw new Error('The clipboard has no timeline clips.');
  const earliestStart = Math.min(...templates.map((clip) => clip.start));
  const pasteAt = quantizeTimelineTime(at, sequence);
  const added = templates.map((clip, index) => ({ ...clip, id: newIds[index], start: quantizeTimelineTime(pasteAt + clip.start - earliestStart, sequence) }));
  let tracks = sequence.tracks;
  for (const clip of added) {
    const track = tracks.find((item) => item.id === clip.trackId);
    if (!track || track.locked) throw new Error('The clipboard destination track is unavailable or locked.');
    const updated = normalizeTrack(track, [...track.clips, clip]);
    tracks = tracks.map((item) => item.id === track.id ? updated : item);
  }
  return withSequence(document, { ...sequence, tracks }, options.modifiedAt);
}
