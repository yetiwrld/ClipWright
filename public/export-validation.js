    const fileInput = document.querySelector('#file');
    const expectedDurationInput = document.querySelector('#expected-duration');
    const fpsInput = document.querySelector('#expected-fps');
    const runButton = document.querySelector('#run');
    const downloadButton = document.querySelector('#download');
    const status = document.querySelector('#status');
    const video = document.querySelector('#video');
    const reportView = document.querySelector('#report');
    const output = Object.fromEntries(['frames', 'decoded', 'dropped', 'cadence', 'duration', 'dimensions'].map((id) => [id, document.getElementById(id)]));
    let file = null;
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

    function seconds(value) { return Number.isFinite(value) ? `${value.toFixed(3)} s` : 'Unavailable'; }
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
      output.duration.textContent = seconds(video.duration);
      output.dimensions.textContent = video.videoWidth && video.videoHeight ? `${video.videoWidth} × ${video.videoHeight}` : 'Unavailable';
      runButton.disabled = !file || !Number.isFinite(video.duration);
    }
    function recordPresentedFrame(_now, metadata) {
      if (!measuring || video.paused || video.ended) return;
      if (Number.isFinite(metadata.mediaTime) && metadata.mediaTime > lastMediaTime + 1e-5) {
        presentedFrames += 1;
        lastMediaTime = metadata.mediaTime;
        output.frames.textContent = String(presentedFrames);
        const elapsed = Math.max(0.001, (accumulatedPlaybackMs + (playbackStartedAt === null ? 0 : performance.now() - playbackStartedAt)) / 1000);
        output.cadence.textContent = `${(presentedFrames / elapsed).toFixed(1)} fps`;
      }
      schedulePresentedFrame();
    }
    function beginRun() {
      if (!file || !Number.isFinite(video.duration) || measuring) return;
      cancelPendingFrameCallback();
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
      report = null;
      downloadButton.disabled = true;
      runButton.disabled = true;
      output.frames.textContent = '0';
      output.decoded.textContent = 'Measuring…';
      output.dropped.textContent = 'Measuring…';
      output.cadence.textContent = 'Measuring…';
      measuring = true;
      if (video.currentTime !== 0) video.currentTime = 0;
      status.textContent = 'Playback check running. Let the file reach the end; visual quality still requires manual review.';
      video.play().catch((error) => { measuring = false; runButton.disabled = !file; status.textContent = `Playback could not start: ${error.message}`; });
    }
    function buildReport() {
      const quality = qualityDelta();
      const playbackSeconds = Math.max(0, accumulatedPlaybackMs / 1000);
      const expectedDuration = Number(expectedDurationInput.value);
      const expectedFps = Number(fpsInput.value);
      const expectedFrames = expectedDuration > 0 && expectedFps > 0 ? Math.round(expectedDuration * expectedFps) : null;
      const frameCoverage = expectedFrames ? presentedFrames / expectedFrames : null;
      return {
        kind: 'clipwright-webm-export-playback-check',
        reportVersion: 1,
        generatedAt: new Date().toISOString(),
        file: { name: file?.name ?? null, bytes: file?.size ?? null, mimeType: file?.type || null },
        expected: { durationSeconds: expectedDuration > 0 ? expectedDuration : null, frameRate: expectedFps || null, frameCount: expectedFrames },
        media: { durationSeconds: Number.isFinite(video.duration) ? video.duration : null, width: video.videoWidth || null, height: video.videoHeight || null },
        playback: {
          wallPlaybackSeconds: Number(playbackSeconds.toFixed(3)),
          presentedFrameCallbacks: typeof video.requestVideoFrameCallback === 'function' ? presentedFrames : null,
          decodedVideoFrames: quality?.totalVideoFrames ?? null,
          droppedVideoFrames: quality?.droppedVideoFrames ?? null,
          corruptedVideoFrames: quality?.corruptedVideoFrames ?? null,
          callbackFrameCoverage: frameCoverage === null ? null : Number((frameCoverage * 100).toFixed(1)),
          waitingEvents,
        },
        device: {
          userAgent: navigator.userAgent,
          platform: navigator.platform || null,
          logicalProcessors: navigator.hardwareConcurrency || null,
          approximateMemoryGiB: navigator.deviceMemory || null,
        },
        limitations: [
          'Playback counters are browser-reported and are not a pixel-quality or encoder-integrity certification.',
          'Frame callback coverage is meaningful only when expected duration and frame rate are entered accurately.',
          'Audio sync, visual artifacts, black frames, cuts, and color quality require manual review.',
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
      output.decoded.textContent = quality?.totalVideoFrames != null ? String(quality.totalVideoFrames) : 'Unavailable';
      output.dropped.textContent = quality?.droppedVideoFrames != null ? String(quality.droppedVideoFrames) : 'Unavailable';
      const elapsed = Math.max(0.001, accumulatedPlaybackMs / 1000);
      output.cadence.textContent = typeof video.requestVideoFrameCallback === 'function' ? `${(presentedFrames / elapsed).toFixed(1)} fps` : 'Unavailable';
      report = buildReport();
      reportView.textContent = JSON.stringify(report, null, 2);
      runButton.disabled = !file;
      downloadButton.disabled = false;
      status.textContent = `Playback check finished. ${presentedFrames} frame callbacks over ${elapsed.toFixed(2)} seconds; visually inspect the export before deciding pass or fail.`;
    }
    fileInput.addEventListener('change', () => {
      file = fileInput.files?.[0] ?? null;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = file ? URL.createObjectURL(file) : null;
      video.pause();
      video.removeAttribute('src');
      if (objectUrl) video.src = objectUrl;
      cancelPendingFrameCallback();
      measuring = false;
      report = null;
      runButton.disabled = true;
      downloadButton.disabled = true;
      reportView.textContent = 'No playback report yet.';
      for (const element of Object.values(output)) element.textContent = '—';
      status.textContent = file ? `Loaded ${file.name} locally (${(file.size / 1_000_000).toFixed(1)} MB).` : 'Choose a WebM file to begin.';
    });
    video.addEventListener('loadedmetadata', updateMetadata);
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
      measuring = false;
      cancelPendingFrameCallback();
      runButton.disabled = true;
      status.textContent = 'This browser could not decode the selected file. Try a supported WebM codec and browser.';
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
