# Repository audit — 2026-10-27

## Baseline

- Checkout: `yetiwrld/ClipWright`, branch `arena/b7257dc1-clipwright` (branch name is managed by the development environment).
- Initial commit: `14bcb7549442ad88887df78d4b81bb75dce7c23c`; clean working tree before implementation.
- Existing files before work: a 13-byte README only. There was no application, package manifest, schema, test suite, media engine, persistence layer, build pipeline, or Windows packaging configuration.
- The repository already has a GitHub `origin`; it is not an empty unhosted directory. Work is therefore being added to this existing repository rather than creating a second remote and detaching the session from its tracked branch.
- Runtime inspected in the sandbox: Linux x86_64, Python 3.11, Node 22.22.3, npm 10.9.8. FFmpeg and .NET were not found on `PATH`. This is not the specified Windows laptop; Windows-specific claims remain unverified.

## Inventory

| Area | Initial state | Current foundation |
|---|---|---|
| Desktop shell / routing | Missing | Browser-rendered React workspace shell; Electron/Windows shell not present |
| Design system | Missing | Graphite/orange tokens, dark/light variables, responsive layouts |
| Project schema | Missing | Version-2 validated project document with frame-quantized seconds, rational sequence rates, generic video/audio clip contracts, and v1 migration |
| Project persistence | Missing | Browser localStorage index/document stores, validated `.cwproject` open/import/download, and autosaving edits; no managed filesystem, atomic file save, or crash recovery |
| Media ingestion / metadata | Missing | Browser file pickers for video and audio; validated local-file names/kinds and metadata; metadata-only references plus session object URLs; hardened relink flow required after reload |
| Preview / timeline / edits | Missing | Timeline-master dual-deck video and mixed audio-track playback with per-track gain/pan; experimental real-time WebM export with selectable resolution and target-bitrate profiles; frame-snapped move/trim/split/delete/ripple, drag-drop, clipboard, snapping, multi-select, and session-only undo/redo |
| FFmpeg / rendering | Missing | No FFmpeg dependency or render implementation |
| Transcription / AI | Missing | No models/providers; AI clipping screen explains the limitation |
| Tests | Missing | Vitest model/persistence unit tests |
| CI / docs | Missing | Basic GitHub Actions verification and initial docs added |
| Windows packaging | Missing | No installer or portable build |

## Baseline and current verification

- Baseline build/test: not applicable; no package manifest or application existed.
- Latest local checks on 2026-10-28 (Node 22.22.3): `npm test -- --run --reporter=dot` passed (50 tests across 8 files); `npm run build` passed (strict TypeScript check and Vite production bundle); `git diff --check` passed. The browser export integration is covered by mocked tests and a separate real Chromium smoke test; see the finding below. The earlier dependency audit is recorded in the initial 2026-10-27 check below; it has not been rerun for this update.
- CI run `40584129896` passed install, tests, and build on commit `db95a35`. The Vite dev server served HTTP 200 on port 5173.
- Initial tool discovery found no installed browser or media fixture; a temporary Chromium 153/Linux runtime and generated 4-second VP8/Opus fixture were used for a real-browser smoke test. Local media import, metadata probing, preview playback, active export cancellation, and the automatic-capture fallback with `requestFrame` disabled succeeded; cancelling stopped recording, restored the export button, and produced no download. After correcting export-clock accumulation and starting capture from a decoded frame, repeated default 1080p WebM exports decoded with 20–28 video frames over 4 seconds (120 expected at 30 fps); FFmpeg decoded the audio stream without timestamp warnings. Resolution diagnostics produced 54 encoded packets at 1280×720 (43 Chromium frame callbacks), 72 at 960×540, and 98–109 at 640×360 over 4 seconds (120 expected). Lower output sizes improved sandbox throughput. The editor now exposes sequence-default/720p/540p/360p sizing and compact/standard/high target-bitrate profiles; those earlier diagnostics predate the controls and do not validate output quality or target-device results. Chromium replayed the 640×360 file to EOF (3.994 s, 87 presented-frame callbacks); FFmpeg decoded its audio with no video warnings. A latest 1080p export replayed to EOF at 4.067 s but produced only 16 presented-frame callbacks from 21 video packets; its last video packet was timestamped 3.602 s, while audio continued to 4.067 s. The low-cadence warning appeared in that run at 6.8 estimated canvas fps. A/B testing redundant full-canvas clears showed no measurable cadence gain. Export frame cadence remains unacceptable in this sandbox and quality is unverified; rerun on supported target hardware before relying on it. No Windows build or export has been verified.

## Initial risk register

1. **No pre-existing editing engine:** versioned projects, timeline-master video/audio playback, browser source references, and a frame-snapped multitrack edit workflow now exist; compositor-quality preview and verified rendered export still require separate implementations and media fixtures.
2. **No Windows environment available here:** packaging and device-specific capability checks require actual Windows validation.
3. **No FFmpeg executable detected:** codec support and licensing/package mode need a deliberate later decision.
4. **Large scope:** staged milestones are essential; UI affordances must not be presented as functional when they are not.
5. **Image provenance:** the supplied icon has no accompanying license/provenance statement; distribution rights need confirmation before release.
6. **Dependency maintenance:** the initial Vitest line had advisories and was upgraded to a clean audited release. Recheck advisories on every dependency update and before release.
