import type { Project } from './projects';
import { frameCountForEndTime } from './frameTime';

export const PROJECT_SCHEMA_VERSION = 2;
export const PROJECT_DOCUMENTS_KEY = 'clipwright.project-documents.v1';
export const DEFAULT_STILL_IMAGE_CLIP_DURATION_SECONDS = 5;
export const MAX_STILL_IMAGE_CLIP_DURATION_SECONDS = 3600;

export type Rational = { numerator: number; denominator: number };
export type StreamInfo = {
  timeBase: Rational;
  durationTicks: number;
  frameRate?: Rational;
  width?: number;
  height?: number;
  sampleRate?: number;
  metadataSource?: 'browser' | 'container';
  channels?: number;
};
export type MediaAsset = {
  id: string;
  name: string;
  sourcePath: string;
  pathKind: 'absolute' | 'project-relative' | 'browser-session';
  kind: 'video' | 'audio' | 'image';
  streams: { video?: StreamInfo; audio?: StreamInfo };
  fileSizeBytes?: number;
  fingerprint?: string;
  imageDimensions?: { width: number; height: number };
};
export type TimelineClip = {
  id: string;
  sourceId: string;
  trackId: string;
  /** Timeline start, in seconds, frame-quantized at the sequence frame rate. */
  start: number;
  /** Source in/out points, in seconds, frame-quantized at the sequence frame rate. */
  trimIn: number;
  trimOut: number;
};
export type VideoClip = TimelineClip;
export type AudioClip = TimelineClip;

export type Track = {
  id: string;
  name: string;
  kind: 'video' | 'audio';
  muted: boolean;
  locked: boolean;
  /** Optional schema-v2 track visibility state. Omitted by older documents and treated as visible. */
  hidden?: boolean;
  /** Optional schema-v2 audio solo state. Omitted by older documents and treated as off. */
  solo?: boolean;
  /** Linear audio gain, where 1 is unity. Older schema-v2 tracks omit this and default to 1. */
  gain?: number;
  /** Stereo pan from -1 (left) to 1 (right). Older schema-v2 tracks omit this and default to center. */
  pan?: number;
  clips: TimelineClip[];
};
export type Sequence = {
  id: string;
  name: string;
  width: number;
  height: number;
  /** Optional schema-v2 canvas composition; older project files default to fit on black. */
  canvasFit?: 'fit' | 'fill' | 'stretch';
  canvasBackground?: string;
  frameRate: Rational;
  audioSampleRate: number;
  durationFrames: number;
  tracks: Track[];
};
export type ProjectDocument = {
  schemaVersion: 2;
  appVersion: string;
  id: string;
  metadata: { name: string; createdAt: string; modifiedAt: string };
  projectSettings: { defaultSequenceId: string };
  assets: MediaAsset[];
  sequences: Sequence[];
};

export type ValidationResult = { valid: true; value: ProjectDocument } | { valid: false; errors: string[] };
export type DocumentStoreResult = { documents: ProjectDocument[]; issue: 'invalid-data' | 'storage-unavailable' | null };

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const isStableId = (value: unknown): value is string => isString(value) && /^[A-Za-z0-9_-]{1,160}$/.test(value);
const isSha256Fingerprint = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const isInteger = (value: unknown, min = 0): value is number => Number.isSafeInteger(value) && (value as number) >= min;
const isRational = (value: unknown): value is Rational => isObject(value)
  && isInteger(value.numerator, 1) && isInteger(value.denominator, 1);
const isFrameRate = (value: unknown): value is Rational => isRational(value)
  && value.numerator / value.denominator >= 1 && value.numerator / value.denominator <= 240;
const isDate = (value: unknown): value is string => isString(value) && Number.isFinite(Date.parse(value));
const isSampleRate = (value: unknown): value is number => isInteger(value, 8000) && (value as number) <= 384000;
const isDimension = (value: unknown): value is number => isInteger(value, 16) && (value as number) <= 16384;

function reduceRational(numerator: number, denominator: number): Rational {
  const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a;
  const divisor = gcd(Math.abs(numerator), Math.abs(denominator));
  return { numerator: numerator / divisor, denominator: denominator / divisor };
}

function decimalToRational(value: number): Rational {
  const exactPresets: Array<[number, Rational]> = [
    [23.976, { numerator: 24_000, denominator: 1_001 }],
    [29.97, { numerator: 30_000, denominator: 1_001 }],
    [59.94, { numerator: 60_000, denominator: 1_001 }],
  ];
  const exactPreset = exactPresets.find(([displayRate]) => Math.abs(value - displayRate) < 1e-9);
  if (exactPreset) return { ...exactPreset[1] };
  const places = Math.min((String(value).split('.')[1] ?? '').length, 6);
  const denominator = 10 ** places;
  return reduceRational(Math.round(value * denominator), denominator);
}

export function createProjectDocument(project: Project, appVersion = '0.1.0', makeId: (entity: 'sequence' | 'video-track' | 'audio-track') => string = () => crypto.randomUUID()): ProjectDocument {
  const ratioParts = project.aspectRatio.split(':').map(Number);
  const ratioWidth = ratioParts[0] || 16;
  const ratioHeight = ratioParts[1] || 9;
  let width: number;
  let height: number;
  if (project.aspectRatio === '16:9') { width = 1920; height = 1080; }
  else if (project.aspectRatio === '9:16') { width = 1080; height = 1920; }
  else if (project.aspectRatio === '1:1') { width = 1080; height = 1080; }
  else {
    const scale = Math.max(16 / ratioWidth, 16 / ratioHeight, Math.min(1080 / ratioHeight, 16384 / ratioWidth, 16384 / ratioHeight));
    width = Math.round(ratioWidth * scale);
    height = Math.round(ratioHeight * scale);
  }
  const sequenceId = makeId('sequence');
  const createdAt = isDate(project.createdAt) ? project.createdAt : new Date().toISOString();
  const modifiedAt = isDate(project.updatedAt) ? project.updatedAt : createdAt;
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    appVersion,
    id: project.id,
    metadata: { name: project.name.trim(), createdAt, modifiedAt },
    projectSettings: { defaultSequenceId: sequenceId },
    assets: [],
    sequences: [{
      id: sequenceId,
      name: 'Sequence 01',
      width,
      height,
      frameRate: decimalToRational(project.frameRate),
      audioSampleRate: 48000,
      durationFrames: 0,
      tracks: [
        { id: makeId('video-track'), name: 'Video 1', kind: 'video', muted: false, locked: false, hidden: false, solo: false, gain: 1, pan: 0, clips: [] },
        { id: makeId('audio-track'), name: 'Audio 1', kind: 'audio', muted: false, locked: false, hidden: false, solo: false, gain: 1, pan: 0, clips: [] },
      ],
    }],
  };
}

function validateStream(value: unknown, path: string, errors: string[]): value is StreamInfo {
  if (!isObject(value)) { errors.push(`${path} must be an object.`); return false; }
  if (!isRational(value.timeBase)) errors.push(`${path}.timeBase must be a positive rational.`);
  if (!isInteger(value.durationTicks, 1)) errors.push(`${path}.durationTicks must be a positive safe integer.`);
  if (value.frameRate !== undefined && !isFrameRate(value.frameRate)) errors.push(`${path}.frameRate must be a rational from 1 to 240 fps.`);
  if (value.width !== undefined && !isDimension(value.width)) errors.push(`${path}.width must be between 16 and 16384.`);
  if (value.height !== undefined && !isDimension(value.height)) errors.push(`${path}.height must be between 16 and 16384.`);
  if (value.sampleRate !== undefined && !isSampleRate(value.sampleRate)) errors.push(`${path}.sampleRate must be between 8000 and 384000 Hz.`);
  if (value.channels !== undefined && (!isInteger(value.channels, 1) || value.channels > 128)) errors.push(`${path}.channels must be between 1 and 128.`);
  if (value.metadataSource !== undefined && !['browser', 'container'].includes(String(value.metadataSource))) errors.push(`${path}.metadataSource is unsupported.`);
  return true;
}

export function validateProjectDocument(value: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isObject(value)) return { valid: false, errors: ['Project document must be a JSON object.'] };
  if (value.schemaVersion !== PROJECT_SCHEMA_VERSION) errors.push(`Unsupported project schema version: ${String(value.schemaVersion)}.`);
  if (!isString(value.appVersion)) errors.push('appVersion must be a non-empty string.');
  if (!isString(value.id)) errors.push('id must be a non-empty stable identifier.');
  if (!isObject(value.metadata)) errors.push('metadata must be an object.');
  else {
    if (!isString(value.metadata.name)) errors.push('metadata.name must be a non-empty string.');
    if (!isDate(value.metadata.createdAt)) errors.push('metadata.createdAt must be a valid date.');
    if (!isDate(value.metadata.modifiedAt)) errors.push('metadata.modifiedAt must be a valid date.');
  }
  if (!isObject(value.projectSettings) || !isString(value.projectSettings.defaultSequenceId)) errors.push('projectSettings.defaultSequenceId must reference a sequence.');
  if (!Array.isArray(value.assets)) errors.push('assets must be an array.');
  if (!Array.isArray(value.sequences) || value.sequences.length === 0) errors.push('sequences must contain at least one sequence.');

  const assets = Array.isArray(value.assets) ? value.assets : [];
  const sequences = Array.isArray(value.sequences) ? value.sequences : [];
  const assetIds = new Set<string>();
  const sequenceIds = new Set<string>();
  const allIds = new Set<string>();
  if (isString(value.id)) allIds.add(value.id);

  assets.forEach((asset, index) => {
    const path = `assets[${index}]`;
    if (!isObject(asset)) { errors.push(`${path} must be an object.`); return; }
    if (!isStableId(asset.id)) errors.push(`${path}.id must be a safe stable identifier.`);
    else {
      if (allIds.has(asset.id)) errors.push(`${path}.id duplicates another project entity.`);
      allIds.add(asset.id); assetIds.add(asset.id);
    }
    if (!isString(asset.name)) errors.push(`${path}.name must be a non-empty string.`);
    if (!isString(asset.sourcePath) || asset.sourcePath.includes('\0')) errors.push(`${path}.sourcePath must be a non-empty local path without NUL bytes.`);
    if (!['absolute', 'project-relative', 'browser-session'].includes(String(asset.pathKind))) errors.push(`${path}.pathKind is unsupported.`);
    if (isString(asset.sourcePath)) {
      const driveAbsolute = /^[A-Za-z]:[\\/]/.test(asset.sourcePath);
      const isAbsolute = driveAbsolute || asset.sourcePath.startsWith('/') || asset.sourcePath.startsWith('\\\\');
      const hasUriScheme = /^[A-Za-z][A-Za-z0-9+.-]*:/.test(asset.sourcePath) && !driveAbsolute;
      if (hasUriScheme) errors.push(`${path}.sourcePath must be a local path, not a URI.`);
      if (asset.pathKind === 'absolute' && !isAbsolute) errors.push(`${path}.sourcePath must be absolute when pathKind is absolute.`);
      if (asset.pathKind === 'project-relative' && isAbsolute) errors.push(`${path}.sourcePath must be relative when pathKind is project-relative.`);
      if (asset.pathKind === 'browser-session' && (isAbsolute || asset.sourcePath.includes('/') || asset.sourcePath.includes('\\'))) errors.push(`${path}.sourcePath must be a filename for a browser-session reference.`);
    }
    if (!['video', 'audio', 'image'].includes(String(asset.kind))) errors.push(`${path}.kind is unsupported.`);
    if (!isObject(asset.streams)) { errors.push(`${path}.streams must be an object.`); return; }
    if (asset.streams.video !== undefined) validateStream(asset.streams.video, `${path}.streams.video`, errors);
    if (asset.streams.audio !== undefined) validateStream(asset.streams.audio, `${path}.streams.audio`, errors);
    if (!asset.streams.video && !asset.streams.audio && asset.kind !== 'image') errors.push(`${path} must describe at least one media stream.`);
    if (asset.kind === 'video' && !asset.streams.video) errors.push(`${path} video assets must include a video stream.`);
    if (asset.kind === 'audio' && !asset.streams.audio) errors.push(`${path} audio assets must include an audio stream.`);
    if (asset.fileSizeBytes !== undefined && !isInteger(asset.fileSizeBytes)) errors.push(`${path}.fileSizeBytes must be a non-negative integer.`);
    if (asset.fingerprint !== undefined && !isSha256Fingerprint(asset.fingerprint)) errors.push(`${path}.fingerprint must be a 64-character lowercase SHA-256 hex digest.`);
    if (asset.imageDimensions !== undefined && (!isObject(asset.imageDimensions) || !isInteger(asset.imageDimensions.width, 1) || asset.imageDimensions.width > 16384 || !isInteger(asset.imageDimensions.height, 1) || asset.imageDimensions.height > 16384)) errors.push(`${path}.imageDimensions must contain whole pixel dimensions from 1 to 16384.`);
    if (asset.imageDimensions !== undefined && asset.kind !== 'image') errors.push(`${path}.imageDimensions is only valid for image assets.`);
  });

  sequences.forEach((sequence, index) => {
    const path = `sequences[${index}]`;
    if (!isObject(sequence)) { errors.push(`${path} must be an object.`); return; }
    if (!isString(sequence.id)) errors.push(`${path}.id must be a non-empty string.`);
    else {
      if (allIds.has(sequence.id)) errors.push(`${path}.id duplicates another project entity.`);
      allIds.add(sequence.id); sequenceIds.add(sequence.id);
    }
    if (!isString(sequence.name)) errors.push(`${path}.name must be a non-empty string.`);
    if (!isDimension(sequence.width)) errors.push(`${path}.width must be between 16 and 16384.`);
    if (!isDimension(sequence.height)) errors.push(`${path}.height must be between 16 and 16384.`);
    if (sequence.canvasFit !== undefined && !['fit', 'fill', 'stretch'].includes(String(sequence.canvasFit))) errors.push(`${path}.canvasFit must be fit, fill, or stretch.`);
    if (sequence.canvasBackground !== undefined && (typeof sequence.canvasBackground !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(sequence.canvasBackground))) errors.push(`${path}.canvasBackground must be a six-digit hex color.`);
    if (!isFrameRate(sequence.frameRate)) errors.push(`${path}.frameRate must be a rational from 1 to 240 fps.`);
    if (!isSampleRate(sequence.audioSampleRate)) errors.push(`${path}.audioSampleRate must be between 8000 and 384000 Hz.`);
    if (!isInteger(sequence.durationFrames)) errors.push(`${path}.durationFrames must be a non-negative safe integer.`);
    if (!Array.isArray(sequence.tracks)) { errors.push(`${path}.tracks must be an array.`); return; }

    sequence.tracks.forEach((track, trackIndex) => {
      const trackPath = `${path}.tracks[${trackIndex}]`;
      if (!isObject(track)) { errors.push(`${trackPath} must be an object.`); return; }
      if (!isString(track.id)) errors.push(`${trackPath}.id must be a non-empty string.`);
      else {
        if (allIds.has(track.id)) errors.push(`${trackPath}.id duplicates another project entity.`);
        allIds.add(track.id);
      }
      if (!isString(track.name)) errors.push(`${trackPath}.name must be a non-empty string.`);
      if (!['video', 'audio'].includes(String(track.kind))) errors.push(`${trackPath}.kind is unsupported.`);
      if (typeof track.muted !== 'boolean') errors.push(`${trackPath}.muted must be a boolean.`);
      if (typeof track.locked !== 'boolean') errors.push(`${trackPath}.locked must be a boolean.`);
      if (track.hidden !== undefined && typeof track.hidden !== 'boolean') errors.push(`${trackPath}.hidden must be a boolean when present.`);
      if (track.solo !== undefined && typeof track.solo !== 'boolean') errors.push(`${trackPath}.solo must be a boolean when present.`);
      if (track.gain !== undefined && (typeof track.gain !== 'number' || !Number.isFinite(track.gain) || track.gain < 0 || track.gain > 2)) errors.push(`${trackPath}.gain must be a finite value between 0 and 2.`);
      if (track.pan !== undefined && (typeof track.pan !== 'number' || !Number.isFinite(track.pan) || track.pan < -1 || track.pan > 1)) errors.push(`${trackPath}.pan must be a finite value between -1 and 1.`);
      if (!Array.isArray(track.clips)) { errors.push(`${trackPath}.clips must be an array.`); return; }

      track.clips.forEach((clip, clipIndex) => {
        const clipPath = `${trackPath}.clips[${clipIndex}]`;
        if (!isObject(clip)) { errors.push(`${clipPath} must be an object.`); return; }
        if (!isString(clip.id)) errors.push(`${clipPath}.id must be a non-empty string.`);
        else {
          if (allIds.has(clip.id)) errors.push(`${clipPath}.id duplicates another project entity.`);
          allIds.add(clip.id);
        }
        if (!isString(clip.sourceId) || !assetIds.has(clip.sourceId)) errors.push(`${clipPath}.sourceId must reference an existing media asset.`);
        if (clip.trackId !== track.id) errors.push(`${clipPath}.trackId must match its containing track.`);
        if (typeof clip.start !== 'number' || !Number.isFinite(clip.start) || clip.start < 0) errors.push(`${clipPath}.start must be a finite non-negative time in seconds.`);
        if (typeof clip.trimIn !== 'number' || !Number.isFinite(clip.trimIn) || clip.trimIn < 0) errors.push(`${clipPath}.trimIn must be a finite non-negative source time in seconds.`);
        if (typeof clip.trimOut !== 'number' || !Number.isFinite(clip.trimOut) || clip.trimOut <= (typeof clip.trimIn === 'number' ? clip.trimIn : 0)) errors.push(`${clipPath}.trimOut must be greater than trimIn.`);
        if (isFrameRate(sequence.frameRate)) {
          const fps = sequence.frameRate.numerator / sequence.frameRate.denominator;
          for (const [field, time] of [['start', clip.start], ['trimIn', clip.trimIn], ['trimOut', clip.trimOut]] as const) {
            if (typeof time === 'number' && Number.isFinite(time) && Math.abs(time * fps - Math.round(time * fps)) > 1e-5) errors.push(`${clipPath}.${field} must align to a sequence frame.`);
          }
        }
        if (typeof clip.start === 'number' && Number.isFinite(clip.start) && typeof clip.trimIn === 'number' && typeof clip.trimOut === 'number' && Number.isFinite(clip.trimOut)) {
          const endTime = clip.start + clip.trimOut - clip.trimIn;
          if (!Number.isFinite(endTime) || endTime > Number.MAX_SAFE_INTEGER) errors.push(`${clipPath} timeline end exceeds the safe range.`);
        }
        if (isString(clip.sourceId)) {
          const asset = assets.find((entry) => isObject(entry) && entry.id === clip.sourceId);
          if (!asset || !isObject(asset)) return;
          const stillImageOnVideoTrack = asset.kind === 'image' && track.kind === 'video';
          if (asset.kind !== track.kind && !stillImageOnVideoTrack) errors.push(`${clipPath} source media kind must match its track kind.`);
          if (stillImageOnVideoTrack) {
            if (typeof clip.trimOut === 'number' && Number.isFinite(clip.trimOut) && clip.trimOut > MAX_STILL_IMAGE_CLIP_DURATION_SECONDS + 1e-7) {
              errors.push(`${clipPath}.trimOut exceeds the still-image clip duration limit.`);
            }
          } else {
            const streamKey = track.kind === 'video' ? 'video' : 'audio';
            const stream = isObject(asset.streams) ? asset.streams[streamKey] : undefined;
            if (!isObject(stream)) errors.push(`${clipPath} references an asset without the required ${streamKey} stream.`);
            else if (typeof clip.trimOut === 'number' && Number.isFinite(clip.trimOut)
              && isRational(stream.timeBase) && isInteger(stream.durationTicks, 1)
              && clip.trimOut > stream.durationTicks * stream.timeBase.numerator / stream.timeBase.denominator + 1e-7) {
              errors.push(`${clipPath}.trimOut exceeds the source stream duration.`);
            }
          }
        }
      });
    });
    const allClips = sequence.tracks.flatMap((track) => isObject(track) && Array.isArray(track.clips) ? track.clips : []);
    if (isFrameRate(sequence.frameRate)) {
      for (const track of sequence.tracks) {
        if (!isObject(track) || !Array.isArray(track.clips)) continue;
        const clips = track.clips.filter(isObject).slice().sort((a, b) => Number(a.start) - Number(b.start));
        for (let index = 1; index < clips.length; index += 1) {
          const previous = clips[index - 1];
          const current = clips[index];
          if (typeof previous.start === 'number' && typeof previous.trimIn === 'number' && typeof previous.trimOut === 'number' && typeof current.start === 'number'
            && current.start < previous.start + previous.trimOut - previous.trimIn - 1e-7) {
            errors.push(`${path}.tracks clips cannot overlap on the same track.`);
          }
        }
      }
      const endSeconds = allClips.reduce((end, clip) => isObject(clip) && typeof clip.start === 'number' && typeof clip.trimIn === 'number' && typeof clip.trimOut === 'number'
        ? Math.max(end, clip.start + clip.trimOut - clip.trimIn) : end, 0);
      const expectedDurationFrames = frameCountForEndTime(endSeconds, sequence.frameRate);
      if (isInteger(sequence.durationFrames) && sequence.durationFrames !== expectedDurationFrames) errors.push(`${path}.durationFrames must match the end of the last clip.`);
    }
  });

  if (isObject(value.projectSettings) && isString(value.projectSettings.defaultSequenceId) && !sequenceIds.has(value.projectSettings.defaultSequenceId)) {
    errors.push('projectSettings.defaultSequenceId does not reference an existing sequence.');
  }
  if (errors.length) return { valid: false, errors };
  return { valid: true, value: value as unknown as ProjectDocument };
}

/** Convert the foundation's pre-document project-list record into an empty v2 project file. */
export function migrateLegacyProjectEntry(value: unknown): ProjectDocument {
  const ratioMatch = isObject(value) && typeof value.aspectRatio === 'string' ? /^(\d{1,5}):(\d{1,5})$/.exec(value.aspectRatio) : null;
  if (!isObject(value)
    || !isString(value.id)
    || !isString(value.name)
    || !isDate(value.createdAt)
    || !isDate(value.updatedAt)
    || !ratioMatch || Number(ratioMatch[1]) < 1 || Number(ratioMatch[2]) < 1 || Number(ratioMatch[1]) > 16384 || Number(ratioMatch[2]) > 16384 || Number(ratioMatch[1]) / Number(ratioMatch[2]) < 1 / 1024 || Number(ratioMatch[1]) / Number(ratioMatch[2]) > 1024
    || !Number.isFinite(value.frameRate) || Number(value.frameRate) < 1 || Number(value.frameRate) > 240) {
    throw new Error('This legacy project entry is incomplete and cannot be migrated safely.');
  }
  const project: Project = {
    id: value.id,
    name: value.name,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    aspectRatio: value.aspectRatio as Project['aspectRatio'],
    frameRate: Number(value.frameRate) as Project['frameRate'],
    archived: typeof value.archived === 'boolean' ? value.archived : false,
    favorite: typeof value.favorite === 'boolean' ? value.favorite : false,
  };
  return createProjectDocument(project, '0.1.0', (entity) => `legacy-${project.id}-${entity}`);
}

/** Convert version-1 frame/sample-and-tick clips into the frame-based seconds model. */
export function migrateProjectDocumentV1(value: unknown): ProjectDocument {
  if (!isObject(value) || value.schemaVersion !== 1 || !Array.isArray(value.assets) || !Array.isArray(value.sequences)) {
    throw new Error('The version-1 project document cannot be migrated safely.');
  }
  const assets = value.assets as unknown as MediaAsset[];
  const sequences = (value.sequences as unknown[]).map((rawSequence) => {
    if (!isObject(rawSequence) || !Array.isArray(rawSequence.tracks) || !isRational(rawSequence.frameRate)) throw new Error('A legacy sequence cannot be migrated safely.');
    const fps = rawSequence.frameRate.numerator / rawSequence.frameRate.denominator;
    const tracks = rawSequence.tracks.map((rawTrack) => {
      if (!isObject(rawTrack) || !Array.isArray(rawTrack.clips) || !isString(rawTrack.id)) throw new Error('A legacy track cannot be migrated safely.');
      const trackId = String(rawTrack.id);
      const clips = rawTrack.clips.map((rawClip) => {
        if (!isObject(rawClip) || !isString(rawClip.id) || !isString(rawClip.assetId)) throw new Error('A legacy clip cannot be migrated safely.');
        const sourceId: string = rawClip.assetId;
        const asset = assets.find((item) => item.id === sourceId);
        const stream = asset?.streams[rawClip.kind === 'video' ? 'video' : 'audio'];
        if (!stream || !isRational(stream.timeBase)) throw new Error('A legacy clip source has no valid timebase.');
        if (rawClip.kind !== 'video' && rawClip.kind !== 'audio') throw new Error('A legacy clip has an unsupported media kind.');
        const sourceDuration = stream.durationTicks * stream.timeBase.numerator / stream.timeBase.denominator;
        const trimIn = Number(rawClip.sourceInTick) * stream.timeBase.numerator / stream.timeBase.denominator;
        const trimOut = Number(rawClip.sourceOutTick) * stream.timeBase.numerator / stream.timeBase.denominator;
        const start = rawClip.kind === 'video'
          ? Number(rawClip.timelineStartFrame) / fps
          : Number(rawClip.timelineStartSample) / Number(rawClip.sampleRate);
        const migratedTrimIn = Math.max(0, Math.round(trimIn * fps) / fps);
        const maxTrimOut = Math.floor(sourceDuration * fps + 1e-7) / fps;
        const migratedTrimOut = Math.min(maxTrimOut, Math.round(trimOut * fps) / fps);
        if (!Number.isFinite(start) || !Number.isFinite(migratedTrimIn) || !Number.isFinite(migratedTrimOut) || migratedTrimOut - migratedTrimIn < 1 / fps - 1e-7) {
          throw new Error('A legacy clip trim falls outside the valid source duration.');
        }
        return {
          id: rawClip.id,
          sourceId,
          trackId,
          start: Math.max(0, Math.round(start * fps) / fps),
          trimIn: migratedTrimIn,
          trimOut: migratedTrimOut,
        } satisfies TimelineClip;
      });
      return { ...rawTrack, clips };
    });
    const endSeconds = tracks.flatMap((track) => track.clips).reduce((end, clip) => Math.max(end, clip.start + clip.trimOut - clip.trimIn), 0);
    return { ...rawSequence, tracks, durationFrames: frameCountForEndTime(endSeconds, rawSequence.frameRate) };
  });
  return { ...value, schemaVersion: PROJECT_SCHEMA_VERSION, sequences } as unknown as ProjectDocument;
}

export function parseProjectDocument(text: string): ProjectDocument {
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { throw new Error('The project file is not valid JSON.'); }
  if (isObject(parsed) && parsed.schemaVersion === undefined) return migrateLegacyProjectEntry(parsed);
  const migrated = isObject(parsed) && parsed.schemaVersion === 1 ? migrateProjectDocumentV1(parsed) : parsed;
  const result = validateProjectDocument(migrated);
  if (!result.valid) throw new Error(`Project file validation failed:\n${result.errors.join('\n')}`);
  return result.value;
}

export function serializeProjectDocument(document: ProjectDocument): string {
  const result = validateProjectDocument(document);
  if (!result.valid) throw new Error(`Cannot save an invalid project:\n${result.errors.join('\n')}`);
  return `${JSON.stringify(result.value, null, 2)}\n`;
}

export function readProjectDocuments(storage: Pick<Storage, 'getItem'>): DocumentStoreResult {
  let raw: string | null;
  try { raw = storage.getItem(PROJECT_DOCUMENTS_KEY); }
  catch { return { documents: [], issue: 'storage-unavailable' }; }
  if (!raw) return { documents: [], issue: null };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return { documents: [], issue: 'invalid-data' };
    const documents: ProjectDocument[] = [];
    const ids = new Set<string>();
    for (const entry of parsed) {
      const migrated = isObject(entry) && entry.schemaVersion === 1 ? migrateProjectDocumentV1(entry) : entry;
      const result = validateProjectDocument(migrated);
      if (!result.valid || ids.has(result.value?.id ?? '')) return { documents: [], issue: 'invalid-data' };
      documents.push(result.value);
      ids.add(result.value.id);
    }
    return { documents, issue: null };
  } catch {
    return { documents: [], issue: 'invalid-data' };
  }
}

export function writeProjectDocuments(storage: Pick<Storage, 'setItem'>, documents: ProjectDocument[]): void {
  const ids = new Set<string>();
  for (const document of documents) {
    const result = validateProjectDocument(document);
    if (!result.valid) throw new Error(`Cannot persist invalid project document: ${result.errors.join(' ')}`);
    if (ids.has(document.id)) throw new Error(`Duplicate project document id: ${document.id}`);
    ids.add(document.id);
  }
  storage.setItem(PROJECT_DOCUMENTS_KEY, JSON.stringify(documents));
}
