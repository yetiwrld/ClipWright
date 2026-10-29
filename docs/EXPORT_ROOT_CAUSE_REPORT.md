# Export root-cause report

**Initial evidence and scope summary (published before broad implementation changes):** repository source at `9e78d29527fe12e468a60dd44e76599588c3877f`, Windows CI runs 40798215447 and 40797889183, available repository history, and accessible workflow/report metadata. Findings below separate confirmed validation defects from hypotheses.

## Baseline findings

1. **Confirmed false-success path:** the old `src/App.tsx` export gate accepted a missing finalized audio track. If an audio reader had been opened but `outputAudioDurationSeconds` was null, `audioDelta` was null and the duration predicate accepted it.
2. **Confirmed ordinary-export validation gap:** the old path parsed finalized WebM packets and track/container durations but did not decode or compare any finalized output frame content before download. A parseable file with invalid/wrong frame payloads could pass those checks.
3. **Confirmed synthetic-test coupling:** the old packaged identity fixture computed expected frames with the same `selectActiveVideoClip` and `sourceTimeForTimelineClip` helpers used by the renderer. Its simple synthetic A/V pulse bypassed source-audio decoding and timeline mixing.
4. **Confirmed CI evidence gap:** the old Windows workflow exercised real packaged WebCodecs/Mediabunny encoding for its helper-level fixtures, but did not exercise the full saved-project export service, independently inspect its output with FFmpeg/ffprobe, capture encoder configuration, or publish passing media artifacts.
5. **Historical case remains unresolved:** repository/history/artifact-metadata searches found no original project, media, WebM or device log for 22.646 s versus 22.21 s. Download of one old diagnostics artifact failed at redirected blob storage. Audio/container tail, old real-time capture cadence, and measurement-source differences remain hypotheses, not established causes.

A 667-frame sequence at 30 fps has frame-aligned duration 22.233333 s. The reported 22.646 s is 0.412667 s longer. An entered 22.21 s end time also rounds to 667 frames using the existing end-exclusive frame rule. These arithmetic observations do not reproduce the original case.

## Current implementation on this branch

- `src/lib/timelineExport.ts` now provides the shared production export service used by the editor and the Windows synthetic fixture. It validates the saved schema-v2 snapshot, reads session-local source blobs, uses the existing timestamped Mediabunny/WebCodecs VP9/Opus pipeline, applies hidden/solo/mute state, mixes source audio, and releases decoders on success/failure/cancellation.
- Finalized-file validation now requires exact requested/rendered/submitted/encoded/video-packet counts, monotonic per-packet video PTS within half a frame plus half the actual WebM timebase tick, three decoded first/middle/last image probes with timestamp and pixel checks, expected audio-track presence plus decoded audio when source audio was selected, finite per-track/container duration measurements, and reported effective encoder configuration before the editor may download.
- At 30 fps, 48 kHz and a 1 ms WebM tick, bounds are: video PTS 17.166667 ms; audio onset/A/V event 10.520833 ms; audio duration 20.520833 ms; container duration the greater applicable track bound. These scale with actual timebase, sample rate and frame period. Probe content MAE bound is 48/255 on a 16×9 downsample. These are explicit implementation policies; target-device distributions remain to be measured.
- Failure diagnostics are local JSON with stage, counts, actual measurements when available, effective encoder configuration, duration checks, error/stack, and `sourceMediaIncluded: false`. Encoder hardware preference is recorded as configuration only; physical hardware use is not claimed.
- `src/lib/deterministicWebmSmoke.ts` now creates two generated video+audio sources, serializes and reparses a saved project snapshot, then calls `exportTimelineProject`. Its independent expected timeline schedule is literal test data. It checks all decoded output identities, gaps/offline intervals, frame PTS, audio pulse onsets, and aligned flash A/V events. It returns the synthetic source/project/output artifacts to packaged Electron CI.
- `.github/workflows/windows-installer.yml` now requires the packaged production-export fixture, CI-only FFmpeg/ffprobe, an independent full decode/timing/content/audio check, effective encoder-config reporting, and success/failure artifact upload. FFmpeg/ffprobe is not added to runtime or installer dependencies.
- `/export-validation.html` and its local parser now use explicit timebase/Opus-duration bounds and fail packet/decode-count mismatch. It still does not certify arbitrary pixels or A/V synchronization; those are covered by the dedicated synthetic CI validator.

## Verification and limitations

The Windows workflow changes have not yet completed on this branch, so the saved-project packaged export, required-codec capability, independently decoded output, tolerance behavior, encoder-config capture, and artifact upload are pending. Local tests/build validate code and threshold arithmetic only; they cannot establish successful Windows WebCodecs behavior. The available Linux agent environment has no GUI display, FFmpeg or ffprobe.

The policy unit test rejects the reported 22.646 s value against a synthetic 667-frame/30 fps expectation by arithmetic only. It does **not** reproduce or resolve the historical export. Request only the original saved project, media, file and device logs if still available after the new synthetic investigation and Windows run.

## Baseline reconciliation

No dedicated AI-assistant handoff file existed in the checkout; the Arena handoff and `docs/REPOSITORY_AUDIT.md` were used. The checkout initially showed `14bcb75` with a partially materialized worktree, while the requested `d2ba226` was in branch history. All working files were verified to match the remote branch tree exactly and the branch was advanced with fast-forward only to `9e78d29`, which descends from `d2ba226`. This describes the initial reconciliation, not the current dirty worktree.
