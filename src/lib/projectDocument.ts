import type { Project } from './projects';

export const PROJECT_SCHEMA_VERSION = 1;
export const PROJECT_DOCUMENTS_KEY = 'clipwright.project-documents.v1';

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
};
export type VideoClip = {
  id: string;
  assetId: string;
  kind: 'video';
  sourceInTick: number;
  sourceOutTick: number;
  timelineStartFrame: number;
  timelineDurationFrames: number;
  playbackRate: Rational;
};
export type AudioClip = {
  id: string;
  assetId: string;
  kind: 'audio';
  sourceInTick: number;
  sourceOutTick: number;
  timelineStartSample: number;
  timelineDurationSamples: number;
  sampleRate: number;
  playbackRate: Rational;
};
export type TimelineClip = VideoClip | AudioClip;
export type Track = {
  id: string;
  name: string;
  kind: 'video' | 'audio';
  muted: boolean;
  locked: boolean;
  clips: TimelineClip[];
};
export type Sequence = {
  id: string;
  name: string;
  width: number;
  height: number;
  frameRate: Rational;
  audioSampleRate: number;
  durationFrames: number;
  tracks: Track[];
};
export type ProjectDocument = {
  schemaVersion: 1;
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
        { id: makeId('video-track'), name: 'Video 1', kind: 'video', muted: false, locked: false, clips: [] },
        { id: makeId('audio-track'), name: 'Audio 1', kind: 'audio', muted: false, locked: false, clips: [] },
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
    if (!isString(asset.id)) errors.push(`${path}.id must be a non-empty string.`);
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
    if (asset.fingerprint !== undefined && !isString(asset.fingerprint)) errors.push(`${path}.fingerprint must be a non-empty string.`);
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
      if (!Array.isArray(track.clips)) { errors.push(`${trackPath}.clips must be an array.`); return; }

      track.clips.forEach((clip, clipIndex) => {
        const clipPath = `${trackPath}.clips[${clipIndex}]`;
        if (!isObject(clip)) { errors.push(`${clipPath} must be an object.`); return; }
        if (!isString(clip.id)) errors.push(`${clipPath}.id must be a non-empty string.`);
        else {
          if (allIds.has(clip.id)) errors.push(`${clipPath}.id duplicates another project entity.`);
          allIds.add(clip.id);
        }
        if (!isString(clip.assetId) || !assetIds.has(clip.assetId)) errors.push(`${clipPath}.assetId must reference an existing media asset.`);
        if (clip.kind !== track.kind) errors.push(`${clipPath}.kind must match its track kind.`);
        if (!isInteger(clip.sourceInTick) || !isInteger(clip.sourceOutTick, 1) || (isInteger(clip.sourceInTick) && isInteger(clip.sourceOutTick, 1) && clip.sourceOutTick <= clip.sourceInTick)) errors.push(`${clipPath} must have a valid, non-empty source range.`);
        if (!isRational(clip.playbackRate)) errors.push(`${clipPath}.playbackRate must be a positive rational.`);
        if (clip.kind === 'video') {
          if (!isInteger(clip.timelineStartFrame)) errors.push(`${clipPath}.timelineStartFrame must be a non-negative frame index.`);
          if (!isInteger(clip.timelineDurationFrames, 1)) errors.push(`${clipPath}.timelineDurationFrames must be a positive frame count.`);
          if (isInteger(clip.timelineStartFrame) && isInteger(clip.timelineDurationFrames, 1)) {
            const timelineEnd = clip.timelineStartFrame + clip.timelineDurationFrames;
            if (!Number.isSafeInteger(timelineEnd)) errors.push(`${clipPath} timeline end exceeds the safe integer range.`);
            else if (isInteger(sequence.durationFrames) && timelineEnd > sequence.durationFrames) errors.push(`${clipPath} extends beyond the sequence duration.`);
          }
        } else if (clip.kind === 'audio') {
          if (!isInteger(clip.timelineStartSample)) errors.push(`${clipPath}.timelineStartSample must be a non-negative sample index.`);
          if (!isInteger(clip.timelineDurationSamples, 1)) errors.push(`${clipPath}.timelineDurationSamples must be a positive sample count.`);
          if (isInteger(clip.timelineStartSample) && isInteger(clip.timelineDurationSamples, 1)) {
            const sampleEnd = clip.timelineStartSample + clip.timelineDurationSamples;
            if (!Number.isSafeInteger(sampleEnd)) errors.push(`${clipPath} timeline sample end exceeds the safe integer range.`);
            else if (isInteger(sequence.durationFrames) && isFrameRate(sequence.frameRate) && isSampleRate(sequence.audioSampleRate)
              && BigInt(sampleEnd) * BigInt(sequence.frameRate.numerator) > BigInt(sequence.durationFrames) * BigInt(sequence.frameRate.denominator) * BigInt(sequence.audioSampleRate)) {
              errors.push(`${clipPath} extends beyond the sequence duration.`);
            }
          }
          if (!isSampleRate(clip.sampleRate)) errors.push(`${clipPath}.sampleRate must be between 8000 and 384000 Hz.`);
          if (isSampleRate(clip.sampleRate) && isSampleRate(sequence.audioSampleRate) && clip.sampleRate !== sequence.audioSampleRate) errors.push(`${clipPath}.sampleRate must match its sequence audio sample rate.`);
        }
        if (isObject(clip) && isString(clip.assetId)) {
          const asset = assets.find((entry) => isObject(entry) && entry.id === clip.assetId);
          const streamKey = clip.kind === 'video' ? 'video' : clip.kind === 'audio' ? 'audio' : null;
          const stream = asset && isObject(asset) && isObject(asset.streams) && streamKey ? asset.streams[streamKey] : undefined;
          if (!streamKey || !stream) errors.push(`${clipPath} references an asset without the required ${clip.kind} stream.`);
          else if (isObject(stream) && isInteger(clip.sourceOutTick, 1) && isInteger(stream.durationTicks, 1) && clip.sourceOutTick > stream.durationTicks) errors.push(`${clipPath}.sourceOutTick exceeds the source stream duration.`);
        }
      });
    });
  });

  if (isObject(value.projectSettings) && isString(value.projectSettings.defaultSequenceId) && !sequenceIds.has(value.projectSettings.defaultSequenceId)) {
    errors.push('projectSettings.defaultSequenceId does not reference an existing sequence.');
  }
  if (errors.length) return { valid: false, errors };
  return { valid: true, value: value as unknown as ProjectDocument };
}

/** Convert the foundation's pre-document project-list record into an empty v1 project file. */
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

export function parseProjectDocument(text: string): ProjectDocument {
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { throw new Error('The project file is not valid JSON.'); }
  if (isObject(parsed) && parsed.schemaVersion === undefined) return migrateLegacyProjectEntry(parsed);
  const result = validateProjectDocument(parsed);
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
      const result = validateProjectDocument(entry);
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
