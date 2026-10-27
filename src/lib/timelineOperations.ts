import type { ProjectDocument, Sequence, VideoClip } from './projectDocument';

type TimelineOptions = { modifiedAt?: string };

function getSequence(document: ProjectDocument, sequenceId: string) {
  const sequence = document.sequences.find((item) => item.id === sequenceId);
  if (!sequence) throw new Error('The selected sequence is not part of this project.');
  return sequence;
}

function safeNumber(value: bigint, label: string) {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${label} exceeds the supported safe integer range.`);
  return Number(value);
}

function roundedRatio(numerator: bigint, denominator: bigint) {
  if (numerator < 0n || denominator <= 0n) throw new Error('Timeline time conversion received invalid values.');
  return (numerator + denominator / 2n) / denominator;
}

function sourceRangeDurationFrames(sequence: Sequence, timeBase: { numerator: number; denominator: number }, sourceDurationTicks: number, playbackRate: { numerator: number; denominator: number }) {
  const numerator = BigInt(sourceDurationTicks)
    * BigInt(timeBase.numerator)
    * BigInt(sequence.frameRate.numerator)
    * BigInt(playbackRate.denominator);
  const denominator = BigInt(timeBase.denominator)
    * BigInt(sequence.frameRate.denominator)
    * BigInt(playbackRate.numerator);
  return Math.max(1, safeNumber(roundedRatio(numerator, denominator), 'Video duration in frames'));
}

function sequenceEndFrame(sequence: Sequence) {
  let endFrame = 0;
  for (const track of sequence.tracks) {
    for (const clip of track.clips) {
      if (clip.kind === 'video') {
        const end = clip.timelineStartFrame + clip.timelineDurationFrames;
        if (!Number.isSafeInteger(end)) throw new Error('A video clip end exceeds the supported safe integer range.');
        endFrame = Math.max(endFrame, end);
      } else {
        const sampleEnd = BigInt(clip.timelineStartSample) + BigInt(clip.timelineDurationSamples);
        const numerator = sampleEnd * BigInt(sequence.frameRate.numerator);
        const denominator = BigInt(clip.sampleRate) * BigInt(sequence.frameRate.denominator);
        const audioEndFrame = safeNumber((numerator + denominator - 1n) / denominator, 'Audio duration in frames');
        endFrame = Math.max(endFrame, audioEndFrame);
      }
    }
  }
  return endFrame;
}

function withSequence(document: ProjectDocument, sequence: Sequence, modifiedAt?: string): ProjectDocument {
  return {
    ...document,
    metadata: { ...document.metadata, modifiedAt: modifiedAt ?? new Date().toISOString() },
    sequences: document.sequences.map((item) => item.id === sequence.id ? sequence : item),
  };
}

/** Append a full-length video source to the end of the first unlocked video track. */
export function appendVideoClip(
  document: ProjectDocument,
  sequenceId: string,
  assetId: string,
  clipId: string = crypto.randomUUID(),
  options: TimelineOptions = {},
): ProjectDocument {
  const sequence = getSequence(document, sequenceId);
  const asset = document.assets.find((item) => item.id === assetId && item.kind === 'video' && item.streams.video);
  if (!asset?.streams.video) throw new Error('The selected project media has no video stream metadata.');
  const track = sequence.tracks.find((item) => item.kind === 'video' && !item.locked);
  if (!track) throw new Error('This sequence has no unlocked video track.');
  if (track.clips.some((clip) => clip.id === clipId)) throw new Error('The new clip ID already exists on this track.');

  const stream = asset.streams.video;
  const playbackRate = { numerator: 1, denominator: 1 };
  const timelineDurationFrames = sourceRangeDurationFrames(sequence, stream.timeBase, stream.durationTicks, playbackRate);
  const timelineStartFrame = track.clips.reduce((end, clip) => clip.kind === 'video'
    ? Math.max(end, clip.timelineStartFrame + clip.timelineDurationFrames)
    : end, 0);
  if (!Number.isSafeInteger(timelineStartFrame + timelineDurationFrames)) throw new Error('The new clip would exceed the supported timeline range.');

  const clip: VideoClip = {
    id: clipId,
    assetId,
    kind: 'video',
    sourceInTick: 0,
    sourceOutTick: stream.durationTicks,
    timelineStartFrame,
    timelineDurationFrames,
    playbackRate,
  };
  const updatedTrack = { ...track, clips: [...track.clips, clip] };
  const updatedSequence = {
    ...sequence,
    tracks: sequence.tracks.map((item) => item.id === track.id ? updatedTrack : item),
  };
  updatedSequence.durationFrames = Math.max(sequenceEndFrame(updatedSequence), timelineStartFrame + timelineDurationFrames);
  return withSequence(document, updatedSequence, options.modifiedAt);
}

/** Trim a video clip to a non-empty source-tick range and recalculate its frame length. */
export function trimVideoClip(
  document: ProjectDocument,
  sequenceId: string,
  clipId: string,
  sourceInTick: number,
  sourceOutTick: number,
  options: TimelineOptions = {},
): ProjectDocument {
  const sequence = getSequence(document, sequenceId);
  const track = sequence.tracks.find((item) => item.kind === 'video' && item.clips.some((clip) => clip.id === clipId));
  if (!track || track.locked) throw new Error('The selected video clip is not on an editable video track.');
  const clip = track.clips.find((item): item is VideoClip => item.id === clipId && item.kind === 'video');
  if (!clip) throw new Error('The selected video clip could not be found.');
  const asset = document.assets.find((item) => item.id === clip.assetId && item.kind === 'video' && item.streams.video);
  if (!asset?.streams.video) throw new Error('The selected clip has no video stream metadata.');
  const stream = asset.streams.video;
  if (!Number.isSafeInteger(sourceInTick) || !Number.isSafeInteger(sourceOutTick)
    || sourceInTick < 0 || sourceOutTick <= sourceInTick || sourceOutTick > stream.durationTicks) {
    throw new Error(`Source trim must be a non-empty range within 0–${stream.durationTicks} ticks.`);
  }
  const timelineDurationFrames = sourceRangeDurationFrames(sequence, stream.timeBase, sourceOutTick - sourceInTick, clip.playbackRate);
  const nextEnd = clip.timelineStartFrame + timelineDurationFrames;
  if (!Number.isSafeInteger(nextEnd)) throw new Error('The trimmed clip end exceeds the supported timeline range.');
  const overlaps = track.clips.some((item) => item.kind === 'video' && item.id !== clipId
    && clip.timelineStartFrame < item.timelineStartFrame + item.timelineDurationFrames
    && item.timelineStartFrame < nextEnd);
  if (overlaps) throw new Error('This source trim would overlap another video clip on the same track.');

  const updatedTrack = {
    ...track,
    clips: track.clips.map((item) => item.id === clipId && item.kind === 'video'
      ? { ...item, sourceInTick, sourceOutTick, timelineDurationFrames }
      : item),
  };
  const updatedSequence = { ...sequence, tracks: sequence.tracks.map((item) => item.id === track.id ? updatedTrack : item) };
  updatedSequence.durationFrames = sequenceEndFrame(updatedSequence);
  return withSequence(document, updatedSequence, options.modifiedAt);
}

/** Move a video clip to an exact sequence frame, rejecting overlaps on its track. */
export function moveVideoClip(
  document: ProjectDocument,
  sequenceId: string,
  clipId: string,
  timelineStartFrame: number,
  options: TimelineOptions = {},
): ProjectDocument {
  if (!Number.isSafeInteger(timelineStartFrame) || timelineStartFrame < 0) throw new Error('Clip start must be a non-negative whole frame number.');
  const sequence = getSequence(document, sequenceId);
  const track = sequence.tracks.find((item) => item.kind === 'video' && item.clips.some((clip) => clip.id === clipId));
  if (!track || track.locked) throw new Error('The selected video clip is not on an editable video track.');
  const clip = track.clips.find((item): item is VideoClip => item.id === clipId && item.kind === 'video');
  if (!clip) throw new Error('The selected video clip could not be found.');
  const nextEnd = timelineStartFrame + clip.timelineDurationFrames;
  if (!Number.isSafeInteger(nextEnd)) throw new Error('The requested clip end exceeds the supported timeline range.');
  const overlaps = track.clips.some((item) => item.kind === 'video' && item.id !== clipId
    && timelineStartFrame < item.timelineStartFrame + item.timelineDurationFrames
    && item.timelineStartFrame < nextEnd);
  if (overlaps) throw new Error('Video clips cannot overlap on this track in the current timeline foundation.');

  const updatedTrack = {
    ...track,
    clips: track.clips.map((item) => item.id === clipId && item.kind === 'video' ? { ...item, timelineStartFrame } : item),
  };
  const updatedSequence = { ...sequence, tracks: sequence.tracks.map((item) => item.id === track.id ? updatedTrack : item) };
  updatedSequence.durationFrames = sequenceEndFrame(updatedSequence);
  return withSequence(document, updatedSequence, options.modifiedAt);
}

/** Remove a video clip and recompute the sequence end from its remaining clips. */
export function removeVideoClip(
  document: ProjectDocument,
  sequenceId: string,
  clipId: string,
  options: TimelineOptions = {},
): ProjectDocument {
  const sequence = getSequence(document, sequenceId);
  const track = sequence.tracks.find((item) => item.kind === 'video' && item.clips.some((clip) => clip.id === clipId));
  if (!track || track.locked) throw new Error('The selected video clip is not on an editable video track.');
  const updatedTrack = { ...track, clips: track.clips.filter((clip) => clip.id !== clipId) };
  const updatedSequence = { ...sequence, tracks: sequence.tracks.map((item) => item.id === track.id ? updatedTrack : item) };
  updatedSequence.durationFrames = sequenceEndFrame(updatedSequence);
  return withSequence(document, updatedSequence, options.modifiedAt);
}

export function sequenceDurationInFrames(sequence: Sequence) {
  return sequenceEndFrame(sequence);
}
