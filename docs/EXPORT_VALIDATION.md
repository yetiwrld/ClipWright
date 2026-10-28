# WebM export validation

## Current status

The in-app browser `MediaRecorder` export is experimental and must not be treated as a production render path. Existing sandbox measurements showed inadequate cadence: a recent 1080p run replayed to EOF but presented only 16 video frames from 21 encoded packets over about four seconds; earlier 1080p runs produced 20–28 frames where 120 were expected at 30 fps. The in-app warning measures canvas updates, not frames subsequently dropped by the encoder. No target Windows device has been validated.

The sandbox used for this work does not currently provide a discoverable Chromium/Chrome, FFmpeg, or ffprobe executable, and it is not representative target hardware. Therefore target-device cadence and visual quality remain an external acceptance gate; no quality claim is made here.

## Local diagnostic tool

`/export-validation.html` is a standalone, local-only page served by Vite and included in the production static bundle. Open it on the device/browser being tested, select a WebM export, enter the source sequence's expected duration and frame rate, and run playback from the beginning through EOF. Download the JSON report and retain it with the test notes.

The report records the file's size/type, playback duration and dimensions, browser-reported frame callbacks and decoded/dropped/corrupted-frame counters when available, waiting events, an optional expected-frame coverage estimate, and basic browser/device metadata. The page processes the selected file locally; it does not upload it. The data is diagnostic only: browser counters are best-effort, expected coverage is only meaningful when the entered project settings are accurate, and the tool does not certify pixel quality, codec conformance, audio synchronization, or encoder integrity.

## Target-device test procedure

1. Record the target device model, Windows version, browser and exact version, display/GPU configuration, and power mode. Run plugged in and note whether the device is in a performance or balanced profile.
2. Create a repeatable project with known sequence dimensions and frame rate. Use relinked sources and include multiple cuts, a gap, audio, and a visible frame sequence or other recognizable motion. Keep an untouched copy of the source project.
3. Export using the sequence-size, 720p, 540p, and 360p presets where applicable, and compact, standard, and high bitrate targets. Record settings, export duration, output size, warnings, and whether the app remains responsive. Repeat runs to identify variance.
4. On the same target device/browser, open `/export-validation.html`, select each output, enter its expected sequence duration/frame rate, and play it through to the end. Save the JSON report.
5. Manually review the complete output for missing/duplicated frames, cadence judder, black frames where media should be online, incorrect cuts, aspect/letterbox errors, color artifacts, audio dropouts, and audio/video sync drift. Check that gaps intentionally render black/silent.
6. Where available, independently inspect and decode the file with a separately installed media tool such as `ffprobe`/FFmpeg. Record the tool/version and exact command; this is supplementary and does not replace target-browser playback.
7. Repeat for longer timelines and the highest supported resolution/frame-rate combination. Exercise cancellation, low-memory behavior, unsupported codecs, and recovery after an export error.

## Proposed release gates

These are initial engineering gates, not verified product requirements; adjust them with product/design before calling export production-ready.

- The target browser can fully decode every supported output, and the output duration is within one sequence frame of the intended duration.
- Presented cadence reaches at least 99% of the expected frame count in the diagnostic run; the browser reports no more than 1% dropped frames where that counter exists. Any unexplained black/missing frames or repeated/omitted cuts fail the run regardless of aggregate rate.
- Audio remains intelligible and stays within 100 ms of video synchronization through the beginning, middle, cuts, and end.
- No crash, unbounded memory growth, corrupted/truncated file, or stuck export controls during success, cancellation, and failure tests.
- Visual review confirms the requested dimensions/aspect ratio, expected content and gaps, no unintended crops/letterbox changes, and no material compression artifacts at the chosen bitrate profile.
- Repeatability is demonstrated across at least two consecutive runs per required target configuration. Record all failures; do not average them away.

A passing browser diagnostic is necessary but not sufficient. Production acceptance also requires a deterministic renderer, container/codec policy, target Windows hardware coverage, and a licensing/redistribution review for any packaged media engine.
