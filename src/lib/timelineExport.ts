import { ALL_FORMATS, AudioBufferSink, BlobSource, Input } from 'mediabunny';
import type { WrappedAudioBuffer } from 'mediabunny';
import { getExportBitrates, getExportDimensions } from './exportResolution';
import type { ExportQualityPreset, ExportResolutionPreset } from './exportResolution';
import { validateProjectDocument } from './projectDocument';
import type { ProjectDocument, Sequence, TimelineClip, Track } from './projectDocument';
import { mapAudioPartToTimelineChunk } from './timelineAudioFrames';
import { shouldInspectAudioStream } from './timelineAudioSources';
import {
  areExportFrameCountsExact,
  encoderConfigDiagnostic,
  OPUS_PACKET_DURATION_SECONDS,
  aacPacketDurationSeconds,
  audioDurationToleranceSeconds,
  createSequenceExportPlan,
  encodeDeterministicMp4,
  encodeDeterministicWebm,
  videoTimestampToleranceSeconds,
} from './deterministicWebmExport';
import type { DeterministicWebmResult, EncoderConfigDiagnostic, ExportOutputStream, FramePipelineCounts } from './deterministicWebmExport';
import { drawLetterboxedVideoFrame, openVideoFrameReader, selectActiveVideoClip, sourceTimeForTimelineClip } from './timelineVideoFrames';
import type { TimelineCanvas } from './timelineVideoFrames';

export type TimelineExportStage = string;

export interface TimelineExportRequest {
  /** A schema-v2 project snapshot. The object is validated again at the export boundary. */
  projectSnapshot: unknown;
  /** Session-local media blobs keyed by asset/source id; media bytes are never copied into the project. */
  sourceBlobs: ReadonlyMap<string, Blob>;
  sequenceId?: string;
  resolution?: ExportResolutionPreset;
  quality?: ExportQualityPreset;
  container?: 'webm' | 'mp4';
  hiddenTrackIds?: Readonly<Record<string, boolean>>;
  soloTrackIds?: readonly string[];
  signal: AbortSignal;
  outputStream?: ExportOutputStream;
  onProgress?: (counts: FramePipelineCounts & { encoded: number }) => void;
  onStage?: (stage: TimelineExportStage) => void;
  onVideoEncoderConfig?(config: EncoderConfigDiagnostic): void;
  onAudioEncoderConfig?(config: EncoderConfigDiagnostic): void;
}

export interface TimelineExportResult extends DeterministicWebmResult {
  projectId: string;
  sequenceId: string;
  expectedAudioTrack: boolean;
  outputDimensions: { width: number; height: number };
  outputComposition: { fit: NonNullable<Sequence['canvasFit']>; background: string };
  encoderConfiguration: { video: EncoderConfigDiagnostic | null; audio: EncoderConfigDiagnostic | null };
  durationValidation: {
    expectedSeconds: number;
    videoDeltaSeconds: number;
    videoToleranceSeconds: number;
    audioDeltaSeconds: number | null;
    audioToleranceSeconds: number;
    containerDeltaSeconds: number;
    containerToleranceSeconds: number;
  };
}

type AudioReader = {
  clip: TimelineClip;
  track: Track;
  iterator: AsyncGenerator<WrappedAudioBuffer, void, unknown>;
  input: Input;
  pending: WrappedAudioBuffer[];
  exhausted: boolean;
};

function assertNotAborted(signal: AbortSignal) {
  if (signal.aborted) throw new DOMException('Export cancelled.', 'AbortError');
}

function findSequence(document: ProjectDocument, sequenceId?: string): Sequence {
  const targetId = sequenceId ?? document.projectSettings.defaultSequenceId;
  const sequence = document.sequences.find((item) => item.id === targetId);
  if (!sequence) throw new Error('The selected project snapshot does not contain the active export sequence.');
  return sequence;
}

/**
 * Production deterministic timeline export shared by the editor and packaged synthetic end-to-end tests.
 * The snapshot is revalidated, clips are interpreted against its sequence, and every output frame is
 * decoded from the supplied local source blob at the clip's mapped source timestamp.
 */
export async function exportTimelineProject(request: TimelineExportRequest): Promise<TimelineExportResult> {
  assertNotAborted(request.signal);
  request.onStage?.('validating project snapshot');
  const validation = validateProjectDocument(request.projectSnapshot);
  if (!validation.valid) throw new Error(`Cannot export an invalid project snapshot: ${validation.errors.join(' ')}`);
  const project = validation.value;
  const sequence = findSequence(project, request.sequenceId);
  const container = request.container ?? 'webm';
  if (sequence.durationFrames < 1) throw new Error('The active sequence has no output frames.');
  const outputDimensions = getExportDimensions(sequence.width, sequence.height, request.resolution ?? 'sequence');
  if (outputDimensions.width * outputDimensions.height > 33_177_600) {
    throw new Error('This export resolution is too large for browser export. Choose a smaller export size and retry.');
  }
  const plan = createSequenceExportPlan(sequence.durationFrames, sequence.frameRate);
  const tracks = sequence.tracks;
  const clips = tracks.flatMap((track) => track.clips);
  const videoClips = tracks.filter((track) => track.kind === 'video').flatMap((track) => track.clips);
  const hiddenTrackIds = Object.fromEntries(tracks.filter((track) => track.hidden).map((track) => [track.id, true]));
  Object.assign(hiddenTrackIds, request.hiddenTrackIds ?? {});
  const soloTrackIds = request.soloTrackIds ?? tracks.filter((track) => track.solo).map((track) => track.id);
  const trackById = new Map(tracks.map((track) => [track.id, track]));
  const assetById = new Map(project.assets.map((asset) => [asset.id, asset]));
  const canvas = document.createElement('canvas');
  canvas.width = outputDimensions.width;
  canvas.height = outputDimensions.height;
  const canvasContext = canvas.getContext('2d', { alpha: false });
  if (!canvasContext) throw new Error('This browser could not create the export canvas.');

  const audioReaders: AudioReader[] = [];
  const videoFrameReaders = new Map<string, Awaited<ReturnType<typeof openVideoFrameReader>>>();
  const activeImageBitmapRef: { current: { assetId: string; bitmap: ImageBitmap } | null } = { current: null };
  // Resolve candidates directly from each clip's asset id so audio-only and embedded audio share one path.
  const availableAudioCandidates = clips
    .map((clip) => ({ clip, track: trackById.get(clip.trackId)!, asset: assetById.get(clip.sourceId), blob: request.sourceBlobs.get(clip.sourceId) }))
    .filter(({ track, asset, blob }) => Boolean(track && blob && asset)
      && !track!.muted
      && !hiddenTrackIds[track!.id]
      && (!soloTrackIds.length || soloTrackIds.includes(track!.id))
      && shouldInspectAudioStream(track!.kind, asset!.kind, Boolean(asset!.streams.audio)));
  let stage: TimelineExportStage = 'preparing audio sources';
  request.onStage?.(stage);
  try {
    for (const { clip, track, asset, blob } of availableAudioCandidates) {
      assertNotAborted(request.signal);
      if (!blob || !asset) continue;
      const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
      try {
        const inputAudioTrack = (await input.getAudioTracks())[0];
        if (!inputAudioTrack) {
          input.dispose();
          if (track.kind === 'audio' || asset.streams.audio) {
            throw new Error(`Audio expected for “${asset.name}” on ${track.name}, but its source has no readable audio track.`);
          }
          continue;
        }
        const sink = new AudioBufferSink(inputAudioTrack);
        const iterator = sink.buffers(clip.trimIn, clip.trimIn + (clip.trimOut - clip.trimIn));
        audioReaders.push({ clip, track, input, iterator, pending: [], exhausted: false });
      } catch (error) {
        input.dispose();
        throw error;
      }
    }

    const renderAudioChunk = async (startSeconds: number, durationSeconds: number) => {
      assertNotAborted(request.signal);
      const sampleRate = sequence.audioSampleRate;
      const samples = Math.max(1, Math.round(durationSeconds * sampleRate));
      const OfflineContext = window.OfflineAudioContext;
      if (!OfflineContext) throw new Error('Offline audio mixing is unavailable in this browser.');
      const context = new OfflineContext(2, samples, sampleRate);
      const chunkEnd = startSeconds + durationSeconds;
      for (const reader of audioReaders) {
        assertNotAborted(request.signal);
        const clip = reader.clip;
        const clipTimelineEnd = clip.start + clip.trimOut - clip.trimIn;
        const activeTimelineStart = Math.max(startSeconds, clip.start);
        const activeTimelineEnd = Math.min(chunkEnd, clipTimelineEnd);
        if (activeTimelineEnd <= activeTimelineStart) continue;
        const sourceEndNeeded = clip.trimIn + activeTimelineEnd - clip.start;
        while (!reader.exhausted && (!reader.pending.length || reader.pending[reader.pending.length - 1].timestamp + reader.pending[reader.pending.length - 1].duration < sourceEndNeeded - 1e-7)) {
          const next = await reader.iterator.next();
          if (next.done) reader.exhausted = true;
          else reader.pending.push(next.value);
        }
        const sourceStartNeeded = clip.trimIn + activeTimelineStart - clip.start;
        reader.pending = reader.pending.filter((part) => part.timestamp + part.duration > sourceStartNeeded - 1e-7);
        for (const part of reader.pending) {
          const mixWindow = mapAudioPartToTimelineChunk(
            clip,
            { timestamp: part.timestamp, duration: part.duration, bufferDuration: part.buffer.duration },
            startSeconds,
            durationSeconds,
          );
          if (!mixWindow) continue;
          const sourceNode = context.createBufferSource();
          sourceNode.buffer = part.buffer;
          const gainNode = context.createGain();
          gainNode.gain.value = reader.track.gain ?? 1;
          sourceNode.connect(gainNode);
          const pannerFactory = context.createStereoPanner?.bind(context);
          if (pannerFactory) {
            const panner = pannerFactory();
            panner.pan.value = reader.track.pan ?? 0;
            gainNode.connect(panner);
            panner.connect(context.destination);
          } else gainNode.connect(context.destination);
          sourceNode.start(mixWindow.timelineOffset, mixWindow.sourceOffset, mixWindow.duration);
        }
      }
      assertNotAborted(request.signal);
      return context.startRendering();
    };

    stage = 'decoding and composing timeline frames';
    request.onStage?.(stage);
    const drawFrame = async (_frameIndex: number, timestampSeconds: number) => {
      assertNotAborted(request.signal);
      const clip = selectActiveVideoClip(videoClips, tracks, timestampSeconds, hiddenTrackIds);
      let sourceCanvas: TimelineCanvas | null = null;
      if (clip) {
        const blob = request.sourceBlobs.get(clip.sourceId);
        const asset = assetById.get(clip.sourceId);
        if (blob && asset?.kind === 'image') {
          if (activeImageBitmapRef.current?.assetId !== clip.sourceId) {
            activeImageBitmapRef.current?.bitmap.close();
            request.onStage?.(`Opening still image ${asset.name}`);
            activeImageBitmapRef.current = { assetId: clip.sourceId, bitmap: await createImageBitmap(blob) };
          }
          sourceCanvas = activeImageBitmapRef.current.bitmap;
        } else if (blob && asset?.kind === 'video') {
          activeImageBitmapRef.current?.bitmap.close();
          activeImageBitmapRef.current = null;
          let reader = videoFrameReaders.get(clip.sourceId);
          if (!reader) {
            request.onStage?.(`Opening video source ${asset.name}`);
            reader = await openVideoFrameReader(blob);
            videoFrameReaders.set(clip.sourceId, reader);
          }
          const decoded = await reader.getCanvasAt(sourceTimeForTimelineClip(clip, timestampSeconds));
          sourceCanvas = decoded?.canvas ?? null;
        }
      } else {
        activeImageBitmapRef.current?.bitmap.close();
        activeImageBitmapRef.current = null;
      }
      assertNotAborted(request.signal);
      drawLetterboxedVideoFrame(canvasContext, canvas.width, canvas.height, sourceCanvas, {
        fit: sequence.canvasFit ?? 'fit',
        background: sequence.canvasBackground ?? '#000000',
      });
    };

    stage = `encoding and muxing ${container.toUpperCase()}`;
    request.onStage?.(stage);
    const bitrates = getExportBitrates(outputDimensions.width, outputDimensions.height, sequence.frameRate.numerator / sequence.frameRate.denominator, request.quality ?? 'standard');
    let videoEncoderConfig: EncoderConfigDiagnostic | null = null;
    let audioEncoderConfig: EncoderConfigDiagnostic | null = null;
    const encode = container === 'mp4' ? encodeDeterministicMp4 : encodeDeterministicWebm;
    const result = await encode({
      canvas,
      plan,
      videoBitrate: bitrates.videoBitsPerSecond,
      audioBitrate: bitrates.audioBitsPerSecond,
      audioSampleRate: sequence.audioSampleRate,
      includeAudio: audioReaders.length > 0,
      signal: request.signal,
      outputStream: request.outputStream,
      drawFrame,
      renderAudioChunk: audioReaders.length ? renderAudioChunk : undefined,
      onProgress: request.onProgress,
      onValidationStage: request.onStage,
      onEncoderConfig: (config) => {
        const diagnostic = encoderConfigDiagnostic(config);
        videoEncoderConfig = diagnostic;
        request.onVideoEncoderConfig?.(diagnostic);
      },
      onAudioEncoderConfig: (config) => {
        const diagnostic = encoderConfigDiagnostic(config);
        audioEncoderConfig = diagnostic;
        request.onAudioEncoderConfig?.(diagnostic);
      },
    });
    assertNotAborted(request.signal);
    const expectedFrames = plan.frameCount;
    const expectedDuration = plan.durationSeconds;
    const measurements = result.measurements;
    const videoDelta = measurements.outputVideoDurationSeconds - expectedDuration;
    const audioDelta = measurements.outputAudioDurationSeconds === null ? null : measurements.outputAudioDurationSeconds - expectedDuration;
    const containerDelta = measurements.outputContainerDurationSeconds - expectedDuration;
    const expectedAudioTrack = audioReaders.length > 0;
    const frameCountsMatch = areExportFrameCountsExact(expectedFrames, {
      ...result.counts,
      outputFilePackets: measurements.outputVideoPackets,
    });
    const videoToleranceSeconds = videoTimestampToleranceSeconds(plan.frameDurationSeconds, 1 / measurements.videoTimeResolution);
    const outputAudioSampleRate = measurements.outputAudioSampleRate ?? sequence.audioSampleRate;
    const audioPacketSeconds = measurements.audioCodec === 'aac' ? aacPacketDurationSeconds(outputAudioSampleRate) : OPUS_PACKET_DURATION_SECONDS;
    const audioToleranceSeconds = measurements.audioTimeResolution
      ? audioDurationToleranceSeconds(outputAudioSampleRate, audioPacketSeconds, 1 / measurements.audioTimeResolution)
      : audioDurationToleranceSeconds(outputAudioSampleRate, audioPacketSeconds);
    const containerToleranceSeconds = Math.max(videoToleranceSeconds, expectedAudioTrack ? audioToleranceSeconds : videoToleranceSeconds);
    const durationValidation = {
      expectedSeconds: expectedDuration,
      videoDeltaSeconds: videoDelta,
      videoToleranceSeconds,
      audioDeltaSeconds: audioDelta,
      audioToleranceSeconds,
      containerDeltaSeconds: containerDelta,
      containerToleranceSeconds,
    };
    const encoderConfiguration = { video: videoEncoderConfig, audio: audioEncoderConfig };
    const localValidationDiagnostics = {
      stage: `validating finalized ${container.toUpperCase()}`,
      counts: result.counts,
      measurements,
      expectedAudioTrack,
      outputDimensions,
      outputComposition: { fit: sequence.canvasFit ?? 'fit', background: sequence.canvasBackground ?? '#000000' },
      encoderConfiguration,
      durationValidation,
      sourceMediaIncluded: false,
    };
    const durationsMatch = Math.abs(videoDelta) <= videoToleranceSeconds
      && (!expectedAudioTrack || (audioDelta !== null && Math.abs(audioDelta) <= audioToleranceSeconds))
      && Math.abs(containerDelta) <= containerToleranceSeconds;
    if (!frameCountsMatch || !durationsMatch) {
      stage = `validating finalized ${container.toUpperCase()}`;
      request.onStage?.(stage);
      const error = new Error(`Export validation failed: requested ${result.counts.requested}, rendered ${result.counts.rendered}, submitted ${result.counts.submitted}, encoded ${result.counts.encoded}, output video packets ${measurements.outputVideoPackets} (expected ${expectedFrames}); video duration ${measurements.outputVideoDurationSeconds.toFixed(6)}s (delta ${videoDelta.toFixed(6)}s; tolerance ${videoToleranceSeconds.toFixed(6)}s), audio ${measurements.outputAudioDurationSeconds === null ? 'missing' : `${measurements.outputAudioDurationSeconds.toFixed(6)}s (delta ${audioDelta?.toFixed(6)}s; tolerance ${audioToleranceSeconds.toFixed(6)}s)`}, container ${measurements.outputContainerDurationSeconds.toFixed(6)}s (delta ${containerDelta.toFixed(6)}s; tolerance ${containerToleranceSeconds.toFixed(6)}s).`);
      Object.assign(error, { exportDiagnostics: localValidationDiagnostics });
      throw error;
    }
    if (!videoEncoderConfig || (expectedAudioTrack && !audioEncoderConfig)) {
      stage = 'validating encoder configuration';
      request.onStage?.(stage);
      const error = new Error(`Export completed without reporting the configured ${!videoEncoderConfig ? 'video' : 'audio'} encoder parameters; the output will not be declared successful without local encoder diagnostics.`);
      Object.assign(error, { exportDiagnostics: localValidationDiagnostics });
      throw error;
    }
    stage = 'complete';
    request.onStage?.(stage);
    return {
      ...result,
      projectId: project.id,
      sequenceId: sequence.id,
      expectedAudioTrack,
      outputDimensions,
      outputComposition: { fit: sequence.canvasFit ?? 'fit', background: sequence.canvasBackground ?? '#000000' },
      encoderConfiguration,
      durationValidation,
    };
  } finally {
    for (const reader of audioReaders) {
      try { await reader.iterator.return?.(); } catch { /* Release source decoders on success, failure, or cancellation. */ }
      reader.input.dispose();
    }
    for (const reader of videoFrameReaders.values()) {
      try { await reader.dispose(); } catch { /* Preserve the export result or primary diagnostic if a decoder fails during disposal. */ }
    }
    videoFrameReaders.clear();
    activeImageBitmapRef.current?.bitmap.close();
    activeImageBitmapRef.current = null;
  }
}
