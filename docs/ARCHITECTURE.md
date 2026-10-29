# Initial architecture decisions

Status: foundation plus a user-tested unsigned Windows desktop shell and managed project-file persistence. These decisions establish seams and priorities, not a claim that future subsystems already exist.

## Current implementation

The TypeScript/React renderer built with Vite runs in both browser and Electron modes. Project-list records and the browser fallback use localStorage; the desktop app additionally opens and saves `.cwproject` files through native dialogs. The renderer receives opaque per-window handles, never arbitrary file paths or filesystem APIs. Schema-v2 `ProjectDocument`s support project creation, import, playback, and editing; v1 timing migrates to frame-aligned seconds. Browser-picked video/audio still use temporary object URLs and must be relinked after reload. See [the schema and storage limitations](PROJECT_SCHEMA.md).

## Target Windows architecture

A secure Electron shell wraps the renderer while retaining the browser development/preview path. GitHub Actions built the unsigned x64 installer and passed the packaged renderer/preload smoke test; the installed build was confirmed working. It remains an unsigned preview, not a public release:

- **Main process:** Electron lifecycle, built-renderer `app://clipwright` serving, navigation allowlisting, permission denial, and validated app-info IPC are implemented. Native open/save dialogs and managed project-file reads/writes/checkpoints are also implemented; media/render child processes, broader OS integration, and credential storage are not.
- **Preload bridge:** a context-isolated, sandboxed preload exposes typed app metadata and narrow project-file operations through fixed IPC channels. Native dialogs select files; renderer calls use session-scoped opaque handles, not paths. Raw `ipcRenderer`, Node, unrestricted filesystem, and shell APIs remain unavailable.
- **Renderer:** React + TypeScript UI, design system, project views, command palette, accessible controls. Browser state remains in the renderer; the current metadata-only IPC result is a fixed primitive object. Any future data crossing IPC must be validated.
- **Project core:** versioned JSON project documents have stable IDs, schema validation/migration, rational frame rates, and frame-quantized clip times. Desktop file writes validate schema-v2 envelopes, cap files at 25 MB, write a synced temporary file and atomically replace the destination, and checkpoint the existing version before replacement. Recovery retains up to ten checkpoints per linked path. Desktop Save/Save As, debounced autosave, Ctrl+S, recovery listing, and checkpoint restore are integrated; browser localStorage and downloads remain the fallback.
- **Media services:** the browser foundation reads local metadata and can generate bounded audio peak envelopes on demand in the renderer; production-sized metadata, thumbnail, and waveform work should move to dedicated workers. FFmpeg/ffprobe are CI-only independent validators, never a runtime or installer dependency. Keep original media immutable; references and proxies are separate.
- **Editing core:** the browser foundation has pure generic clip add, move, trim/resize, split, delete/ripple-delete, duplicate, and paste operations with frame quantization and same-track overlap checks. UI undo/redo snapshots sequence state in memory only. Browser-native audio elements play clips on separate tracks against the timeline clock, with project-persisted gain/pan controls routed through Web Audio and saved hide/show/solo render state; audio automation, durable history, and broader UI-independent commands remain future work.
- **Preview/render:** timeline preview remains browser-media-element playback inside the saved project canvas. Deterministic export uses a frame-index loop with rational-rate timestamps, timestamp-addressed Mediabunny `CanvasSink` source frames (not HTML video seek events), the persisted fit/fill/stretch and background composition, and awaited WebCodecs/Mediabunny backpressure. WebM remains VP9/Opus; MP4 uses capability-checked H.264/AVC plus AAC-LC with no silent fallback. Exact sequence/output width and height are used for composition, encoder config, muxing, preview and final-file validation. Audio is mixed by sequence time in bounded chunks. This is not a full multi-layer compositor or offline desktop render. The current Windows production/FFmpeg gate passed at [run 40906510630](https://github.com/yetiwrld/ClipWright/actions/runs/40906510630) with synthetic fixtures; target-device quality, user-media compatibility, and actual hardware/software backend remain unverified.
- **Tasks:** durable task records and worker adapters expose real stages/progress only when measured. Cancellation/retry/pause semantics are declared per task capability.
- **AI providers:** typed capability interfaces, local provider first where feasible, opt-in cloud providers behind explicit consent and secure credential storage. No provider or model is currently included.
- **Persistence:** project files in user-chosen locations; preferences/task metadata in an appropriate local store. Never store large source media in a database by default.

## Desktop shell implementation boundary

`npm run desktop:dev` runs a loopback-only Vite server on port 5174 and launches Electron; `npm run desktop:preview` builds the renderer and loads the static bundle through the privileged local `app://clipwright` scheme. The local-resource handler resolves requests beneath `dist/`, rejects traversal and non-app hosts, serves only GET/HEAD, sets explicit MIME/security headers, and uses a restrictive CSP. The development CSP allows the local renderer and Vite HMR. Electron windows use context isolation, sandboxing, disabled Node integration, denied permission requests, and blocked popups/untrusted top-level navigation. `electron/security.test.cjs` tests path and navigation restrictions without launching Electron.

The bridge exposes `app.getInfo()` and limited project-file commands. Main-process handlers validate the trusted top-level renderer, use native file dialogs, and return no filesystem path; opaque handles are scoped to a renderer session and are cleared when its WebContents is destroyed. `electron/projectFiles.cjs` bounds project files to 25 MB, validates JSON/schema envelope and project identity, writes atomically, and stores rotating checkpoints below Electron userData. `electron/projectFiles.test.cjs` covers write preservation, identity checks, migration envelopes, recovery rotation, and path validation. Save/Save As, debounced autosave, and recovery restore are integrated in the renderer. The successful Actions installer artifact was installed and confirmed working; signing, public release, upgrade behavior, crash handling, and broad Windows runtime validation remain out of scope.

## Export architecture decision

The former browser `MediaRecorder` path was replaced because it could not guarantee timestamps or await encoder backpressure. Current WebCodecs export is deterministic in frame order and reports measured progress, cancellation, structured failures, and output-file measurements, but it is not an offline desktop renderer and has not passed the target Windows hardware gate. A future isolated desktop render process may still be needed for throughput and memory scaling; it must consume the same validated project/timeline instructions.

Production export remains browser-native WebCodecs/Mediabunny, capability-gated per selected configuration and validated before download. FFmpeg/ffprobe are reserved for independent Windows CI artifact inspection and are not bundled, invoked by the application, or required at runtime. Any future backend change must preserve the project/timeline contract, local-first media handling, exact canvas dimensions, and the tested WebM path. The target-device procedure and release gates are in [export validation](EXPORT_VALIDATION.md). No target-device or current-branch production MP4 pass has been recorded.

## Decisions and constraints

- **Do not port or bind this work to the images of other products.** Reference images inform density and panel hierarchy only. The supplied ClipWright icon is a replaceable user-provided asset.
- **React/Vite is the renderer baseline** because the repository was empty, Node/npm are available, and it supports rapid preview/testing. Electron 45 is now installed as a development dependency and the secure shell scaffold builds; GUI startup and Windows behavior have not been validated in this headless Linux environment.
- **FFmpeg/ffprobe are CI-only.** They are used for independent inspection/decoding of synthetic Windows production artifacts, not as a renderer dependency, installer payload, or user-installed tool.
- **No database has been selected.** First define the versioned project document and access patterns; avoid adding SQLite before it is justified.
- **Persistence differs by runtime.** Browser builds keep project entries/documents in browser-profile localStorage and offer explicit file snapshots. The Windows desktop app supports linked `.cwproject` files, atomic saves, autosave, and bounded recovery checkpoints; media remains external and browser-session paths must be relinked after restart.

## Initial communication contracts

1. UI requests typed application commands, not direct shell/file operations.
2. Project services validate external data before mutation and return structured errors.
3. Timeline commands are pure/undoable where possible.
4. Media jobs and AI providers implement explicit capability/task contracts.
5. Preview and render consume the same versioned edit instructions and report unsupported effects explicitly.

## Next architecture gate

The Windows workflow and manual install/launch check passed historically for the unsigned preview; current-branch MP4 production coverage and independent validation must still pass before making codec claims. Remaining gates include upgrade/uninstall checks on supported Windows devices, signing/release policy, target-device export quality, and broad codec/device coverage. This Linux sandbox has no graphical display and cannot run the packaged GUI smoke. The unsigned installer is a short-lived CI artifact, not a public release. The v2 project schema, timeline-master playback, two-deck source preloading, frame-snapped editing, project-canvas settings, deterministic WebM/MP4 encoding, and session-only sequence undo/redo are implemented. Preview and export share saved fit/fill/stretch composition and canvas dimensions; editing remains a single active video layer rather than a multi-layer compositor.
