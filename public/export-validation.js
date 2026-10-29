    const fileInput = document.querySelector('#file');
    const sequenceFileInput = document.querySelector('#sequence-file');
    const runButton = document.querySelector('#run');
    const downloadButton = document.querySelector('#download');
    const status = document.querySelector('#status');
    const video = document.querySelector('#video');
    const reportView = document.querySelector('#report');
    const sequenceName = document.querySelector('#sequence-name');
    const expectedFps = document.querySelector('#expected-fps');
    const expectedFrames = document.querySelector('#expected-frames');
    const expectedDuration = document.querySelector('#expected-duration');
    const output = Object.fromEntries([
      'file-frames', 'frame-delta', 'file-fps', 'video-duration', 'audio-duration', 'container-duration', 'file-decode',
      'playback-decoded', 'playback-dropped', 'playback-corrupted', 'playback-cadence', 'playback-waiting',
    ].map((id) => [id, document.getElementById(id)]));
    let file = null;
    let sequenceFile = null;
    let objectUrl = null;
    let report = null;
    let measuring = false;
    let presentedFrames = 0;
    let lastMediaTime = -1;
    let waitingEvents = 0;
    let playbackStartedAt = null;
    let accumulatedPlaybackMs = 0;
    let frameCallbackId = null;
    let qualityBaseline = { totalVideoFrames: 0, droppedVideoFrames: 0, corruptedVideoFrames: 0 };
    let activeExpectation = null;
    let fileInspection = null;
    let exportChecks = null;
    let playbackFailure = null;
    let mediaToolsPromise = null;

    function seconds(value) { return Number.isFinite(value) ? `${value.toFixed(6)} s` : 'Unavailable'; }
    function deltaText(value) { return Number.isFinite(value) ? `${value >= 0 ? '+' : ''}${value.toFixed(6)} s` : 'Unavailable'; }
    function counter(value) { return Number.isFinite(value) ? value : 0; }
    function playbackQuality() {
      try { return typeof video.getVideoPlaybackQuality === 'function' ? video.getVideoPlaybackQuality() : null; }
      catch { return null; }
    }
    function qualityDelta() {
      const quality = playbackQuality();
      if (!quality) return null;
      return {
        totalVideoFrames: Number.isFinite(quality.totalVideoFrames) ? Math.max(0, quality.totalVideoFrames - qualityBaseline.totalVideoFrames) : null,
        droppedVideoFrames: Number.isFinite(quality.droppedVideoFrames) ? Math.max(0, quality.droppedVideoFrames - qualityBaseline.droppedVideoFrames) : null,
        corruptedVideoFrames: Number.isFinite(quality.corruptedVideoFrames) ? Math.max(0, quality.corruptedVideoFrames - qualityBaseline.corruptedVideoFrames) : null,
      };
    }
    function schedulePresentedFrame() {
      if (!measuring || video.paused || video.ended || typeof video.requestVideoFrameCallback !== 'function' || frameCallbackId !== null) return;
      frameCallbackId = video.requestVideoFrameCallback((now, metadata) => {
        frameCallbackId = null;
        recordPresentedFrame(now, metadata);
      });
    }
    function cancelPendingFrameCallback() {
      if (frameCallbackId !== null && typeof video.cancelVideoFrameCallback === 'function') video.cancelVideoFrameCallback(frameCallbackId);
      frameCallbackId = null;
    }
    function updateMetadata() {
      const canRun = Boolean(file && sequenceFile && Number.isFinite(video.duration) && !measuring);
      runButton.disabled = !canRun;
    }
    function recordPresentedFrame(_now, metadata) {
      if (!measuring || video.paused || video.ended) return;
      if (Number.isFinite(metadata.mediaTime) && metadata.mediaTime > lastMediaTime + 1e-5) {
        presentedFrames += 1;
        lastMediaTime = metadata.mediaTime;
        output['playback-cadence'].textContent = `${(presentedFrames / Math.max(0.001, (accumulatedPlaybackMs + (playbackStartedAt === null ? 0 : performance.now() - playbackStartedAt)) / 1000)).toFixed(1)} fps`;
      }
      schedulePresentedFrame();
    }
    async function loadMediaTools() {
      if (!mediaToolsPromise) {
        mediaToolsPromise = import('./export-validation-media.js').catch(() => import('/src/lib/exportValidationMedia.ts'));
      }
      return mediaToolsPromise;
    }
    async function readFreshSequenceExpectation() {
      if (!sequenceFile) throw new Error('Choose the latest saved ClipWright project JSON before running validation.');
      const { readActiveSequenceExpectationFromJson } = await loadMediaTools();
      return readActiveSequenceExpectationFromJson(await sequenceFile.text());
    }
    function displayExpectation(expectation) {
      sequenceName.value = `${expectation.sequenceName} · ${expectation.width} × ${expectation.height}`;
      expectedFps.value = `${expectation.frameRate.numerator}/${expectation.frameRate.denominator} (${expectation.frameRate.value.toFixed(9)} fps)`;
      expectedFrames.value = String(expectation.frameCount);
      expectedDuration.value = `${expectation.durationSeconds.toFixed(9)} s (${expectation.frameCount} ÷ ${expectation.frameRate.value.toFixed(9)} fps)`;
    }
    async function beginRun() {
      if (!file || !sequenceFile || measuring) return;
      cancelPendingFrameCallback();
      measuring = true;
      runButton.disabled = true;
      downloadButton.disabled = true;
      report = null;
      playbackFailure = null;
      reportView.textContent = 'Inspecting the selected WebM and refreshing active sequence expectations…';
      status.textContent = 'Reading the selected project JSON again, then inspecting the encoded WebM file. This can take a while for long exports.';
      try {
        const expectation = await readFreshSequenceExpectation();
        displayExpectation(expectation);
        const { inspectWebmFile, measureExportFile } = await loadMediaTools();
        const inspection = await inspectWebmFile(file);
        activeExpectation = expectation;
        fileInspection = inspection;
        exportChecks = measureExportFile(expectation, inspection);
        presentedFrames = 0;
        lastMediaTime = -1;
        waitingEvents = 0;
        accumulatedPlaybackMs = 0;
        playbackStartedAt = null;
        const quality = playbackQuality();
        qualityBaseline = {
          totalVideoFrames: counter(quality?.totalVideoFrames),
          droppedVideoFrames: counter(quality?.droppedVideoFrames),
          corruptedVideoFrames: counter(quality?.corruptedVideoFrames),
        };
        for (const element of Object.values(output)) element.textContent = '—';
        video.pause();
        if (video.currentTime !== 0) video.currentTime = 0;
        status.textContent = 'Encoded-file inspection complete. Playback check running; let the file reach the end and then review the picture and sound manually.';
        await video.play();
      } catch (error) {
        measuring = false;
        cancelPendingFrameCallback();
        if (fileInspection && activeExpectation) {
          playbackFailure = error instanceof Error ? error.message : 'Playback could not start.';
          finishRun();
          status.textContent = `WebM file inspection completed, but browser playback could not start: ${playbackFailure}. The encoded-file measurements are available in the report; playback counters are unavailable.`;
        } else {
          runButton.disabled = !file || !sequenceFile;
          status.textContent = `Validation could not start: ${error instanceof Error ? error.message : 'unknown error'}`;
        }
      }
    }
    function buildReport() {
      const quality = qualityDelta();
      const playbackSeconds = Math.max(0, accumulatedPlaybackMs / 1000);
      const expectation = activeExpectation;
      const inspection = fileInspection;
      const actualFrames = inspection?.video.frames ?? null;
      const checks = exportChecks;
      const missingFrames = checks?.missingExportFrames ?? null;
      const extraFrames = checks?.extraOutputFrames ?? null;
      const videoDelta = checks?.videoDurationDifferenceSeconds ?? null;
      const audioDelta = checks?.audioDurationDifferenceSeconds ?? null;
      const containerDelta = checks?.containerDurationDifferenceSeconds ?? null;
      const videoDurationTolerance = checks?.videoDurationToleranceSeconds ?? null;
      const audioDurationTolerance = checks?.audioDurationToleranceSeconds ?? null;
      const containerDurationTolerance = checks?.containerDurationToleranceSeconds ?? null;
      const frameCoverage = checks?.frameCoveragePercent == null ? null : checks.frameCoveragePercent / 100;
      return {
        kind: 'clipwright-webm-export-validation',
        reportVersion: 3,
        generatedAt: new Date().toISOString(),
        file: { name: file?.name ?? null, bytes: file?.size ?? null, mimeType: file?.type || inspection?.mimeType || null },
        expectationRefresh: {
          sourceProjectFile: sequenceFile?.name ?? null,
          sourceProjectFileLastModified: sequenceFile ? new Date(sequenceFile.lastModified).toISOString() : null,
          readImmediatelyBeforeFileInspection: true,
          projectId: expectation?.projectId ?? null,
          projectName: expectation?.projectName ?? null,
          sequenceId: expectation?.sequenceId ?? null,
          sequenceName: expectation?.sequenceName ?? null,
          width: expectation?.width ?? null,
          height: expectation?.height ?? null,
          frameRate: expectation?.frameRate ?? null,
          frameCount: expectation?.frameCount ?? null,
          frameAlignedDurationSeconds: expectation?.durationSeconds ?? null,
        },
        encodedFile: inspection ? {
          mimeType: inspection.mimeType,
          video: {
            frameCount: inspection.video.frames,
            configuredFrameRate: expectation?.frameRate.value ?? null,
            measuredFrameRate: Number(inspection.video.frameRate.toFixed(9)),
            timeResolution: inspection.video.timeResolution,
            durationSeconds: Number(inspection.video.durationSeconds.toFixed(9)),
            durationDifferenceFromFrameAlignedExpectedSeconds: videoDelta === null ? null : Number(videoDelta.toFixed(9)),
            durationToleranceSeconds: videoDurationTolerance,
            durationWithinTolerance: checks?.videoDurationWithinTolerance ?? null,
            frameCoveragePercent: frameCoverage === null ? null : Number((frameCoverage * 100).toFixed(2)),
            missingExportFrames: missingFrames,
            extraOutputFrames: extraFrames,
            dimensions: { width: inspection.video.width, height: inspection.video.height },
            codec: inspection.video.codec,
            fullDecode: {
              decodedFrames: inspection.video.decodedFrames,
              error: inspection.video.decodeError,
              completeAgainstExpectedFrames: checks?.decodedVideoComplete ?? false,
              corruptionDetected: inspection.video.decodeError !== null || (inspection.video.decodedFrames !== null && inspection.video.decodedFrames !== expectation?.frameCount),
              decodedFrameDifferenceFromExpected: inspection.video.decodedFrames === null || !expectation ? null : expectation.frameCount - inspection.video.decodedFrames,
            },
          },
          audio: inspection.audio ? {
            durationSeconds: Number(inspection.audio.durationSeconds.toFixed(9)),
            durationDifferenceFromFrameAlignedExpectedSeconds: audioDelta === null ? null : Number(audioDelta.toFixed(9)),
            durationToleranceSeconds: audioDurationTolerance,
            durationWithinTolerance: checks?.audioDurationWithinTolerance ?? null,
            timeResolution: inspection.audio.timeResolution,
            sampleRate: inspection.audio.sampleRate,
            codec: inspection.audio.codec,
          } : null,
          container: {
            durationSeconds: Number(inspection.containerDurationSeconds.toFixed(9)),
            durationDifferenceFromFrameAlignedExpectedSeconds: containerDelta === null ? null : Number(containerDelta.toFixed(9)),
            durationToleranceSeconds: containerDurationTolerance,
            durationWithinTolerance: checks?.containerDurationWithinTolerance ?? null,
          },
        } : null,
        playback: {
          outcome: playbackFailure ? 'failed' : 'completed',
          error: playbackFailure,
          wallPlaybackSeconds: Number(playbackSeconds.toFixed(3)),
          observedCallbackCadenceFps: playbackSeconds > 0 && typeof video.requestVideoFrameCallback === 'function' ? Number((presentedFrames / playbackSeconds).toFixed(2)) : null,
          presentedFrameCallbacks: typeof video.requestVideoFrameCallback === 'function' ? presentedFrames : null,
          decodedPlaybackFrames: quality?.totalVideoFrames ?? null,
          droppedPlaybackFrames: quality?.droppedVideoFrames ?? null,
          corruptedPlaybackFrames: quality?.corruptedVideoFrames ?? null,
          waitingEvents,
        },
        device: {
          userAgent: navigator.userAgent,
          platform: navigator.platform || null,
          logicalProcessors: navigator.hardwareConcurrency || null,
          approximateMemoryGiB: navigator.deviceMemory || null,
        },
        limitations: [
          'The expectation is reread from the selected saved project JSON at the start of each validation run; save the active project immediately before selecting or rerunning it.',
          'Encoded file packet count, video/audio/container durations, and dimensions are parsed independently of playback callbacks.',
          'A full encoded-video decode error is reported separately from browser playback drops and missing/extra export frames.',
          'Playback counters and device performance are not export-frame counts or pixel-quality certification; manually review visual cuts and A/V sync.',
        ],
      };
    }
    function finishRun() {
      if (playbackStartedAt !== null) {
        accumulatedPlaybackMs += performance.now() - playbackStartedAt;
        playbackStartedAt = null;
      }
      measuring = false;
      cancelPendingFrameCallback();
      const quality = qualityDelta();
      const elapsed = Math.max(0.001, accumulatedPlaybackMs / 1000);
      const expectation = activeExpectation;
      const inspection = fileInspection;
      const videoDurationTolerance = exportChecks?.videoDurationToleranceSeconds ?? null;
      const audioDurationTolerance = exportChecks?.audioDurationToleranceSeconds ?? null;
      const containerDurationTolerance = exportChecks?.containerDurationToleranceSeconds ?? null;
      const videoDelta = exportChecks?.videoDurationDifferenceSeconds ?? null;
      const audioDelta = exportChecks?.audioDurationDifferenceSeconds ?? null;
      const containerDelta = exportChecks?.containerDurationDifferenceSeconds ?? null;
      const actualFrames = inspection?.video.frames ?? null;
      const missing = exportChecks?.missingExportFrames ?? null;
      const extra = exportChecks?.extraOutputFrames ?? null;
      output['file-frames'].textContent = actualFrames === null ? 'Unavailable' : `${actualFrames} / ${expectation?.frameCount ?? '—'} expected`;
      output['frame-delta'].textContent = missing === null ? 'Unavailable' : `${missing} missing / ${extra} extra`;
      output['file-fps'].textContent = inspection ? `${inspection.video.frameRate.toFixed(6)} fps` : 'Unavailable';
      output['video-duration'].textContent = inspection && videoDelta !== null ? `${seconds(inspection.video.durationSeconds)} · Δ ${deltaText(videoDelta)}` : 'Unavailable';
      output['audio-duration'].textContent = inspection?.audio && audioDelta !== null ? `${seconds(inspection.audio.durationSeconds)} · Δ ${deltaText(audioDelta)}` : 'No audio track';
      output['container-duration'].textContent = inspection && containerDelta !== null ? `${seconds(inspection.containerDurationSeconds)} · Δ ${deltaText(containerDelta)}` : 'Unavailable';
      output['file-decode'].textContent = inspection?.video.decodeError
        ? `Decode error: ${inspection.video.decodeError}`
        : inspection?.video.decodedFrames === null
          ? 'Unavailable'
          : inspection.video.decodedFrames === inspection.video.frames
            ? `Clean · ${inspection.video.decodedFrames} / ${inspection.video.frames}`
            : `Mismatch · ${inspection.video.decodedFrames} / ${inspection.video.frames} decoded`;
      output['playback-decoded'].textContent = `${quality?.totalVideoFrames ?? 'Unavailable'} decoded · ${presentedFrames} callbacks`;
      output['playback-dropped'].textContent = quality?.droppedVideoFrames == null ? 'Unavailable' : String(quality.droppedVideoFrames);
      output['playback-corrupted'].textContent = quality?.corruptedVideoFrames == null ? 'Unavailable' : String(quality.corruptedVideoFrames);
      output['playback-cadence'].textContent = typeof video.requestVideoFrameCallback === 'function' ? `${(presentedFrames / elapsed).toFixed(1)} fps` : 'Unavailable';
      output['playback-waiting'].textContent = String(waitingEvents);
      report = buildReport();
      reportView.textContent = JSON.stringify(report, null, 2);
      runButton.disabled = !file || !sequenceFile;
      downloadButton.disabled = false;
      const countsPass = exportChecks?.frameCountExact === true && missing === 0 && extra === 0;
      const durationPass = exportChecks?.videoDurationWithinTolerance === true
        && exportChecks?.containerDurationWithinTolerance === true
        && exportChecks?.audioDurationWithinTolerance !== false;
      const decodeCount = inspection?.video.decodedFrames === null ? 'unavailable' : `${inspection.video.decodedFrames} decoded`;
      status.textContent = `File inspection and playback ended: ${actualFrames} encoded video packets (expected ${expectation?.frameCount}); ${decodeCount}; ${missing} missing / ${extra} extra; video Δ ${deltaText(videoDelta)} (limit ${videoDurationTolerance?.toFixed(6)}s); audio Δ ${deltaText(audioDelta)} (limit ${audioDurationTolerance?.toFixed(6) ?? 'not applicable'}s); container Δ ${deltaText(containerDelta)} (limit ${containerDurationTolerance?.toFixed(6)}s); playback drops ${quality?.droppedVideoFrames ?? 'unavailable'}, playback corruptions ${quality?.corruptedVideoFrames ?? 'unavailable'}. ${countsPass && durationPass ? 'Encoded frame-count, full-decode, and duration gates pass; manual A/V sync and visual review is still required.' : 'Encoded frame-count, decode, or duration validation failed.'}`;
    }
    sequenceFileInput.addEventListener('change', () => {
      sequenceFile = sequenceFileInput.files?.[0] ?? null;
      activeExpectation = null;
      fileInspection = null;
      exportChecks = null;
      report = null;
      downloadButton.disabled = true;
      for (const element of Object.values(output)) element.textContent = '—';
      sequenceName.value = sequenceFile ? 'Selected; expectations refresh at validation time' : 'Choose a project JSON file';
      expectedFps.value = '—';
      expectedFrames.value = '—';
      expectedDuration.value = '—';
      reportView.textContent = 'No validation report yet.';
      updateMetadata();
      if (sequenceFile) status.textContent = `Selected ${sequenceFile.name}. It will be reread immediately before validation.`;
    });
    fileInput.addEventListener('change', () => {
      file = fileInput.files?.[0] ?? null;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = file ? URL.createObjectURL(file) : null;
      video.pause();
      video.removeAttribute('src');
      if (objectUrl) video.src = objectUrl;
      cancelPendingFrameCallback();
      measuring = false;
      activeExpectation = null;
      fileInspection = null;
      exportChecks = null;
      report = null;
      runButton.disabled = true;
      downloadButton.disabled = true;
      reportView.textContent = 'No validation report yet.';
      for (const element of Object.values(output)) element.textContent = '—';
      status.textContent = file ? `Loaded ${file.name} locally (${(file.size / 1_000_000).toFixed(1)} MB). Select the saved project JSON to validate against the active sequence.` : 'Choose the saved active project document and its WebM export.';
      updateMetadata();
    });
    video.addEventListener('loadedmetadata', updateMetadata);
    video.addEventListener('durationchange', updateMetadata);
    video.addEventListener('playing', () => {
      if (measuring && playbackStartedAt === null) playbackStartedAt = performance.now();
      schedulePresentedFrame();
    });
    video.addEventListener('pause', () => {
      if (measuring && playbackStartedAt !== null) {
        accumulatedPlaybackMs += performance.now() - playbackStartedAt;
        playbackStartedAt = null;
      }
    });
    video.addEventListener('waiting', () => { if (measuring) waitingEvents += 1; });
    video.addEventListener('error', () => {
      if (!measuring) return;
      playbackFailure = 'The browser could not decode or play the selected WebM.';
      measuring = false;
      cancelPendingFrameCallback();
      if (fileInspection && activeExpectation) {
        finishRun();
        status.textContent = 'The browser could not play the selected WebM. Encoded-file inspection results are saved separately from unavailable playback metrics in the report.';
      } else {
        runButton.disabled = !file || !sequenceFile;
        status.textContent = playbackFailure;
      }
    });
    video.addEventListener('ended', finishRun);
    runButton.addEventListener('click', beginRun);
    downloadButton.addEventListener('click', () => {
      if (!report) return;
      const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${(file?.name ?? 'export').replace(/[^a-z0-9._-]+/gi, '-')}.validation.json`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    window.addEventListener('pagehide', () => { if (objectUrl) URL.revokeObjectURL(objectUrl); }, { once: true });
