# Deterministic WebM export and validation

## Export contract

The saved active sequence is authoritative. `durationFrames` is the exact requested output frame count; the rational sequence frame rate (`numerator / denominator`) defines each frame's timestamp and duration; dimensions come from the sequence unless an explicit export-size preset is selected. The sequence endpoint is end-exclusive in frame-index space: the final clip end is converted to frames using ceiling (with a small floating-point boundary epsilon), so a non-frame-aligned endpoint includes the frame containing that endpoint. Expected video duration is exactly `durationFrames × denominator / numerator`.

The exporter uses a frame-index loop and WebCodecs-backed Mediabunny `CanvasSource`. For every integer frame index it awaits source readiness/seeking and timeline composition, submits the canvas with an explicit sequence timestamp and duration, and awaits encoder/muxer backpressure before moving on. No RAF or display-refresh callback schedules export frames. Encoder packet callbacks, finalized WebM packets, track durations, and container duration are counted/measured separately; the output is flushed/finalized and then parsed before it is downloaded. Audio is mixed against sequence time in bounded chunks and encoded as a separate WebM audio track where source audio exists.

A validated export requires requested, rendered, submitted, encoded, and parsed output video-frame counts all to equal the active sequence frame count. Actual video, audio, and container durations are reported separately against the frame-aligned expected duration. The duration check allows no more than one sequence frame interval. Playback drops and callback cadence are never substituted for encoded/missing export frames.

## Root-cause context

The former `MediaRecorder`/canvas-capture implementation depended on `requestAnimationFrame`, browser capture cadence, and real-time media playback. It could not set exact per-frame presentation timestamps, wait for encoder/muxer backpressure, or guarantee a one-input-frame/one-output-packet mapping. The prior Windows playback report's 1,316 callbacks and 1,330 decoded frames were playback metrics, not proof of the actual output-frame count; its reported 22.646 s duration versus the entered 22.21 s expectation exceeded a frame interval and was not a pass. The deterministic WebCodecs export path replaces that cadence-dependent implementation; a target Windows installer/device run is still required to establish production behavior.

## Local diagnostic tool

`/export-validation.html` is a local-only page included in the production static bundle. First save the current ClipWright project, then select that saved project JSON and the exported WebM. The validator rereads the selected JSON immediately before every run and derives the active sequence from `projectSettings.defaultSequenceId`, including rational FPS, dimensions, `durationFrames`, and frame-aligned duration. If the project has changed, save it and reselect its current JSON before validating.

The tool independently parses the WebM packet count, video frame rate and duration, audio duration, container duration, codec, and dimensions. It also attempts a full encoded-video decode, reporting decoder errors separately. Browser presentation callbacks, decoded playback frames, playback-dropped frames, playback-corrupted frames, and waiting events are a distinct playback section. Missing/extra output frame metrics use the parsed file frame count only. The tool reads the project and WebM locally; it does not upload either file.

## Target-device test procedure

1. Record the target device model, Windows version, exact browser/Electron version, display/GPU configuration, and power mode. Record whether the device is plugged in and which power profile is active.
2. Save a repeatable project with known sequence dimensions, rational frame rate, and active sequence. Include relinked sources, multiple cuts, a gap, audio, and recognizable motion; preserve an untouched source-project copy.
3. Export with sequence, 720p, 540p, and 360p presets where applicable, and compact, standard, and high bitrate targets. Record exact requested/rendered/submitted/encoded/output frame counts, sequence rate, output-file measurements, export time, output size, and any warning/error.
4. Save the active project immediately before validation. Open `/export-validation.html`, reselect the fresh project JSON and each WebM, and run the check from the beginning through EOF. Save its JSON report with the device test notes.
5. Treat actual file packet/frame count and track/container duration as export gates. Review playback drops/cadence separately as playback/device diagnostics. Manually review all content for missing/duplicated frames, cuts, black frames where media should be online, aspect/letterbox errors, color artifacts, audio dropouts, and A/V drift.
6. Where available, independently inspect and decode the file with a separately installed media tool such as `ffprobe`/FFmpeg. Record the tool version and exact command; this is supplementary to the in-app WebM parser and target-browser playback.
7. Repeat for longer timelines and the highest supported resolution/frame-rate combination. Exercise cancellation, low-memory behavior, unsupported codecs, and recovery after export errors. Do not average away failed runs.

## Release gates

- Requested, rendered, submitted, encoded, and actual output-file video frame counts match the active sequence frame count exactly.
- Actual output video duration differs from `frameCount / configured rational fps` by no more than one frame interval. Audio-track and container durations are reported separately and manually reviewed for sync and padding behavior; any documented codec/container allowance must be explicit and must not hide missing video frames.
- The output file can be fully parsed and decoded by the target media stack; corruption/decode failures are distinct from browser playback drops and export-frame-count differences.
- Playback remains visually acceptable on target devices. Browser callbacks/drops diagnose playback performance but do not establish export-frame completeness.
- No crash, stuck export controls, or truncated/corrupt output during success, cancellation, and failure tests; repeat runs reproduce frame-count and duration results.
- Visual review confirms the requested dimensions/aspect ratio, intended content and gaps, and no material compression artifacts at the chosen bitrate.

A local unit suite or development build does not satisfy Windows release acceptance. The Windows release process and an installed target-device validation run must be reported independently.
