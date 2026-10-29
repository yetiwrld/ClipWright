# ClipWright Studio

ClipWright Studio is the starting point for a local-first Windows video editor and AI-assisted clipping application. The supplied ClipWright icon is included as a replaceable asset; the wordmark and Graphite + Electric Orange theme are deliberately easy to change.

> **Current status — foundation build (0.1.0).** This is a React + TypeScript editor foundation that runs in the browser and in an unsigned Windows preview shell; it is not a complete desktop video editor. It includes a local project dashboard, schema-v2 project documents, `.cwproject` import/download, browser-local video/audio metadata inspection and relinkable session sources, timeline-master playback for video and audio clips, and a frame-snapped multitrack editing workflow with move, trim, split, delete/ripple-delete, duplicate/copy/paste, snapping, marquee selection, and session-only undo/redo. Project files never contain media bytes or temporary object URLs. Deterministic browser-native export preserves WebM VP9/Opus and adds capability-gated MP4 H.264/AVC plus AAC-LC with no fallback. Both formats use timestamp-addressed Mediabunny source-frame decoding (not HTML video seek events), explicit frame-index timestamps, backpressure, finalization and local finalized-file validation. Saved project canvases support common aspect ratios, custom exact dimensions, and explicit fit/fill/stretch composition with a background. The earlier MediaRecorder/RAF path produced unverified frame loss and duration drift and has been replaced. Required real-file MP4/WebM production coverage and independent CI-only FFmpeg/ffprobe checks are implemented in the Windows workflow; that workflow has not yet run on this branch, so MP4 capability and output remain unverified. User-media exports and target-device behavior remain unvalidated. Track gain/pan, on-demand session-only audio waveforms, selectable export dimensions and target-bitrate profiles, and hardened local media import/relink are implemented. Offline rendering, waveform persistence, transcoding, and AI clipping are not implemented. An unsigned x64 Windows installer was built by GitHub Actions, passed the packaged renderer/preload smoke test, and was installed successfully by the user; it is a CI artifact, not a signed public release.

## Run locally

Requirements: Node.js 22.12+ and npm. (The repository is developed in a Linux container; the unsigned Windows installer has been manually installed and confirmed working, but target-device media/export quality remains unvalidated.)

```bash
npm install
npm run dev
```

Open the Vite URL printed in the terminal. The development server binds to `0.0.0.0` to support the hosted preview. Build and test with:

```bash
npm test
npm run build
```

The secure Electron shell can be started locally with `npm run desktop:dev` (it uses a separate Vite server on `127.0.0.1:5174`) or against the built renderer with `npm run desktop:preview`. These commands require a graphical desktop session and network access on the first run so Electron can fetch its runtime.

## Windows installer (unsigned preview)

On Windows x64, run `npm ci` then `npm run desktop:dist:win`. The unsigned NSIS setup executable is written to `release/ClipWright-Studio-Setup-0.1.0-x64.exe`. A GitHub Actions workflow runs the same installer build and a packaged-renderer/preload smoke test, then uploads `ClipWright-Windows-unsigned-x64` for 14 days. The verified CI artifact was installed successfully, but this is not a permanent release: the executable is unsigned and can trigger Windows SmartScreen. See the [successful Windows desktop installer run](https://github.com/yetiwrld/ClipWright/actions/runs/40755076470) for the workflow and artifact record.

## Current functionality

- Home, AI Clipping, and Editor workspace navigation.
- Create projects with landscape, portrait, square, common aspect-ratio or custom pixel canvases, and frame-rate preferences including exact rational 24000/1001, 30000/1001, and 60000/1001 options displayed as 23.976, 29.97, and 59.94 fps. Saved project canvas dimensions, fit/fill/stretch composition and background color drive preview and export.
- Persist project-list entries and schema-v2 project documents in browser local storage, scoped to the browser profile; older v1 documents migrate to the current seconds-based, frame-quantized clip model.
- Create projects with a default video/audio sequence, rational frame rates, and clip timing stored as `{ id, sourceId, trackId, start, trimIn, trimOut }` in seconds snapped to sequence frames.
- Browser builds open/import a `.cwproject` with the local picker and download snapshots. The Windows desktop build adds native Open, Save, Save As, debounced autosave for linked project files, Ctrl+S save, and a separate downloadable backup. Source media is never included.
- Imports validate the schema before changing state, preserve exact sequence settings, and open ID collisions as separate copies instead of replacing existing projects.
- Import local video and audio files to inspect browser-reported dimensions (video) and duration. Sources use revocable in-memory object URLs for the current page session; project documents keep only filename references and metadata, so browser-picked media must be relinked after reload. Project files never embed media bytes or temporary URLs.
- `.cwproject` path references are not automatically resolved or verified. Imported video and audio references can be relinked through their file pickers; empty files, obvious kind/MIME mismatches, invalid metadata, and overlapping media reads are rejected, and relink replaces a session source only after a successful browser probe.
- Timeline time is the master playback clock and advances with `requestAnimationFrame`. Two video elements follow that clock; the next active source is preloaded before a cut, source frames are sought from each clip's trim-in, drift is corrected, gaps are black, and playback stops at the last clip on any track. Audio clips on separate tracks play and mix against the same timeline clock, follow trims/seeks, and honor per-track mute, gain (0–200%), stereo pan, and saved solo state (soloed audio tracks only) plus the shared preview-volume control. Gain, pan, hide/show, and solo state are saved in project documents; older schema-v2 tracks default to visible and unsoloed. Stereo audio waveforms can be generated on demand for relinked local files up to 20 MB and 3 minutes; waveform data stays in page memory and is not saved. Scrubbing, ruler clicks, skip buttons, and frame/second keyboard steps seek the timeline. Player duration reflects the full sequence, not the selected source.
- Sequence export uses one deterministic frame-index loop for WebM VP9/Opus and capability-gated MP4 H.264/AVC with AAC-LC when timeline audio is present; unsupported MP4 configurations fail without format fallback. The production service maps timestamp-decoded source frames through project clips/tracks, applies the saved exact project canvas and composition, mixes local source audio, awaits encoder/muxer backpressure, finalizes and validates codecs/dimensions, exact frame counts, timestamp order, decoded probes, expected audio-track presence, per-track/container durations and effective encoder configuration before download. At 30 fps/48 kHz/1 ms, existing WebM bounds remain video PTS 17.167 ms, audio onset/A/V 10.521 ms, and audio/container duration 20.521 ms; AAC uses 1024-sample packet bounds. See [validation policy](docs/EXPORT_VALIDATION.md). Failure creates a local JSON diagnostic without source media. Offline clips remain black/silent. Outputs are buffered in memory. The prior packaged smoke [passed](https://github.com/yetiwrld/ClipWright/actions/runs/40797889183) for an earlier path; it is not MP4 evidence. Current Windows MP4/WebM production and FFmpeg/ffprobe checks are required but have not run on this branch. User media, long encoded output and target hardware remain unvalidated.
- Use the standalone [`/export-validation.html`](public/export-validation.html) page to select the latest saved project JSON and exported WebM. It rereads active sequence expectations on each run, counts actual packets and fully decoded frames, checks explicit video/audio/container duration bounds, and reports playback drops/corruptions separately from missing export frames. It does not certify arbitrary pixels or A/V synchronization; the Windows synthetic CI fixture and [target-device procedure/release gates](docs/EXPORT_VALIDATION.md) cover those separately. The CI synthetic smoke is not a user-media or target-device pass.
- Use the standalone [`/export-validation.html`](public/export-validation.html) page to select the latest saved project JSON and exported WebM. It rereads active sequence expectations on each run, parses actual encoded video frames/rate/duration plus separate audio/container durations, attempts a full decode, and reports playback drops/corruptions separately from missing export frames. Follow the [Windows target-device procedure and release gates](docs/EXPORT_VALIDATION.md); the CI synthetic smoke is not a user-media or target-device pass.
- A secure Electron shell wraps the built renderer using a privileged local `app://clipwright` protocol, strict content security policy, context isolation, sandboxing, disabled Node integration, and a typed preload bridge. Project-file access is limited to native dialogs and opaque per-window handles; raw paths, Node APIs, and shell access are not exposed. Schema-checked `.cwproject` saves use atomic replacement, and prior versions are retained in the app recovery directory (up to ten per project). An unsigned x64 NSIS installer and packaged smoke test passed in GitHub Actions, and the installed build was confirmed working. Code signing and public release publishing remain incomplete.
- Drag clips to move them horizontally or between same-type unlocked tracks; same-track overlaps are rejected. Snap to the playhead, clip edges, and time zero within 8px, with a visible guide and toggle. Trim with edge handles or keyboard; split at the playhead; delete or ripple-delete; add selected media or drag it from the media panel; duplicate, copy, and paste at the playhead; use the right-click menu. Shift/Ctrl/Cmd multiselect, empty-space marquee, and empty-click clearing are supported. A ripple toggle applies to moves and trims.
- Edits are frame-quantized to the sequence rate, update sequence duration and preview, autosave to browser storage, and are undoable/redone during the current app session. One pointer drag creates one history entry. Track mute/lock, audio gain/pan, and hide/show/solo render state are stored with the project; these saved visibility/solo settings affect preview and export and older schema-v2 tracks default to visible/unsoloed.
- Keyboard shortcuts: Ctrl/Cmd+S saves the linked project file in the desktop app (or downloads a `.cwproject` snapshot in browser builds); Space play/pause, S split, Delete remove, Shift+Delete ripple-delete, arrows step frames, Shift+arrows step one second, Home/End jump, Ctrl/Cmd+Z and Shift+Z undo/redo, Ctrl/Cmd+C/V/D copy/paste/duplicate, N toggle snapping, and Shift+F10 or the Context Menu key opens timeline actions for the focused clip or track region. Trim sliders report source-time bounds, move by frame or second with the arrow keys, move by one second with PageUp/PageDown, and jump to a limit with Home/End.
- Keep the editor below the top bar with the project name and sequence badges above, collapsible navigation/media panels, and optional focus mode. The preview height is resizable; the lower timeline retains its fixed track-header column, ruler, synced scrolling, pixels-per-second zoom, adaptive frame/time ruler, and auto-follow playback.
- Migrate earlier project-list records into empty schema-v2 documents and old v1 clip documents into seconds-based clips; preserve unreadable data until the user confirms recovery.
- Open, rename, duplicate, favourite, archive/restore, search, and delete project entries.
- Deletion is confirmed and removes only local project entries/documents; it never deletes media.
- Dark and light themes, keyboard shortcuts (`Ctrl/Cmd+K`, `Ctrl/Cmd+N`), an accessible in-app keyboard shortcut reference, a command palette with wraparound arrow navigation and Home/End shortcuts, task-centre status, and modal focus management for project creation, settings, the command palette, and the task centre (initial focus, Tab trapping, and focus restoration). Also includes keyboard-operable project filter tabs, a project-action disclosure that focuses its actions and returns focus on Escape, a keyboard-accessible skip-to-content link, visible focus treatment, polite status announcements, assertive error alerts that remain until dismissed, and live feedback while local media metadata is read.
- Honest unavailable states for audio automation, AI analysis, offline desktop rendering, transcoding, and full-frame compositing; browser-native media elements handle preview decoding, while WebM export uses deterministic frame-index rendering and WebCodecs encoding in the browser.

A `.cwproject` file is a portable JSON document that preserves supported project structure and source references, but does not bundle media. In the Windows desktop app, use Save As to link a file; subsequent edits autosave after a short debounce, writes replace atomically, and up to ten prior on-disk versions can be restored from the recovery control. Browser builds continue to use local storage with user-triggered downloads. Media picked from the browser is session-only and must be relinked after reload.

## Repository guide

- `src/App.tsx` — workspace shell and first foundation UI.
- `src/lib/projects.ts` — validated project-entry model and local persistence boundary.
- `src/lib/projectDocument.ts` — versioned project-file contract, validation, serialization, migration, and document storage.
- `src/styles/tokens.css` — centralized theme, typography, and spacing tokens.
- `electron/main.cjs` and `electron/preload.cjs` — secure desktop window, local app protocol, and allowlisted IPC bridge.
- `electron/security.cjs` — tested navigation-origin and packaged-asset path checks.
- `docs/` — audit, architecture decisions, project schema, setup notes, and current limitations.
- `public/assets/clipwright-icon.png` — user-provided replaceable icon.

## Roadmap

1. Desktop shell and persistence contracts.
2. Versioned project files, safe writes, and project dashboard storage.
3. Browser-local video metadata and in-session source preview (implemented foundation; relink after reload).
4. Complete the required Windows H.264/AAC MP4 and exact-canvas production/independent-decode gates on supported target devices; later add a verified offline render path and production desktop support.
5. Transcription, explainable clip suggestions, and captions.
6. Reframing, effects, audio automation, colour, recovery, and Windows distribution.

See [the architecture notes](docs/ARCHITECTURE.md), [repository audit](docs/REPOSITORY_AUDIT.md), and [known limitations](docs/KNOWN_LIMITATIONS.md). Features are documented as complete only after implementation and verification.

## Privacy and licensing

This foundation has no cloud provider, telemetry, AI model, media upload, or external credential handling. It uses React, Vite, TypeScript, Vitest, Lucide React, and an Electron desktop-shell scaffold (plus its launch utilities); see `package-lock.json` and [dependency and asset notes](docs/LICENSING.md) for exact versions and license references. The supplied image was provided with the project request; its copyright/redistribution provenance has not been independently verified. See [dependency and asset notes](docs/LICENSING.md).
