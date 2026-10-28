# Initial architecture decisions

Status: foundation only. These decisions establish seams and priorities, not a claim that future subsystems already exist.

## Current implementation

The current runnable increment is a TypeScript/React renderer built with Vite. Workspace selection is held in React state. Project-list records pass through `src/lib/projects.ts`; the localStorage adapter is intentionally isolated so it can be replaced by a desktop persistence adapter. The current browser app does **not** expose unrestricted filesystem or shell APIs. Schema-v2 `ProjectDocument`s are used by project creation, local-file open/import, `.cwproject` downloads, timeline playback, and clip editing; v1 timing migrates to seconds-based frame-aligned clips. Browser-picked video and audio use temporary in-memory object URLs and must be relinked after reload. See [the schema and storage limitations](PROJECT_SCHEMA.md).

## Target Windows architecture

A secure Electron shell now wraps the existing renderer while retaining the browser development/preview path. Windows installer configuration and a CI artifact workflow are present, but no installer artifact has yet been built or validated:

- **Main process:** Electron lifecycle and window creation, single-instance behavior, built-renderer `app://clipwright` asset serving, navigation allowlisting, permission denial, and one validated app-info IPC handler are implemented. Native dialogs, managed file access, project-store orchestration, media/render child processes, OS integration, and credential storage are not implemented.
- **Preload bridge:** a context-isolated, sandboxed preload exposes only typed app metadata through one fixed IPC channel. It exposes no raw `ipcRenderer`, Node, unrestricted filesystem, or shell APIs to the renderer.
- **Renderer:** React + TypeScript UI, design system, project views, command palette, accessible controls. Browser state remains in the renderer; the current metadata-only IPC result is a fixed primitive object. Any future data crossing IPC must be validated.
- **Project core:** versioned JSON project document with stable IDs, schema validation/migration, rational sequence frame rates, and generic clip times in seconds quantized to sequence frames. V2 is implemented; atomic desktop-file saves and rotating recovery checkpoints are not. Browser storage/downloads are interim, not the future managed project-file adapter.
- **Media services:** the browser foundation reads local metadata and can generate bounded audio peak envelopes on demand in the renderer; production-sized metadata, thumbnail, and waveform work should move to dedicated workers. Probe candidate: FFmpeg/ffprobe, subject to Windows packaging, codec configuration, licensing, and fixture tests. Keep original media immutable; references and proxies are separate.
- **Editing core:** the browser foundation has pure generic clip add, move, trim/resize, split, delete/ripple-delete, duplicate, and paste operations with frame quantization and same-track overlap checks. UI undo/redo snapshots sequence state in memory only. Browser-native audio elements play clips on separate tracks against the timeline clock, with project-persisted gain/pan controls routed through Web Audio; audio automation, durable history, and broader UI-independent commands remain future work.
- **Preview/render:** the renderer has an experimental real-time WebM path using canvas capture, Web Audio mixing, and `MediaRecorder`; one animation loop drives both the timeline clock and canvas capture, starting from a ready frame and manually requesting captured frames where supported. Canvas composition clears to black before drawing the active video, preserving letterboxing and offline-media behavior. It is still browser/device-dependent and too slow in the sandbox for acceptance; the UI warns when rendered canvas updates fall below 90% of the target cadence, but that cannot detect frames dropped later by the encoder. This is not an offline render or full compositor. A production export path should use validated project instructions and isolate decoders/encoders from the UI thread; an FFmpeg filter graph remains a candidate after packaging and licensing review.
- **Tasks:** durable task records and worker adapters expose real stages/progress only when measured. Cancellation/retry/pause semantics are declared per task capability.
- **AI providers:** typed capability interfaces, local provider first where feasible, opt-in cloud providers behind explicit consent and secure credential storage. No provider or model is currently included.
- **Persistence:** project files in user-chosen locations; preferences/task metadata in an appropriate local store. Never store large source media in a database by default.

## Desktop shell implementation boundary

`npm run desktop:dev` runs a loopback-only Vite server on port 5174 and launches Electron; `npm run desktop:preview` builds the renderer and loads the static bundle through the privileged local `app://clipwright` scheme. The local-resource handler resolves requests beneath `dist/`, rejects traversal and non-app hosts, serves only GET/HEAD, sets explicit MIME/security headers, and uses a restrictive CSP. The development CSP allows the local renderer and Vite HMR. Electron windows use context isolation, sandboxing, disabled Node integration, denied permission requests, and blocked popups/untrusted top-level navigation. `electron/security.test.cjs` tests path and navigation restrictions without launching Electron.

The bridge currently exposes only `app.getInfo()`. No filesystem, project-save, shell, or media API is exposed. This is intentional; add capabilities only with typed request/result schemas, sender validation, focused unit tests, and explicit UX/permission handling. An electron-builder NSIS x64 installer configuration and Windows Actions workflow now exist; the workflow smoke test checks that the packaged React renderer mounts and the preload IPC responds. The workflow has not yet run in this session, so there is no verified installer artifact. Code signing, upgrades, crash handling, and broader Windows runtime validation remain out of scope.

## Export architecture decision

The browser `MediaRecorder` path remains a diagnostic/experimental export only; it is not the production renderer. Production export should be deterministic and offline, run in an isolated desktop render process rather than competing with React and preview playback on the UI thread, and consume a validated version of the same project/timeline instructions. The renderer should report measured progress, cancellation, structured failures, and the exact output settings used.

An FFmpeg-backed adapter is the preferred candidate for the first production implementation because the current requirements need broad container/codec handling and a repeatable offline filter/render pipeline. This is an architectural direction, not approval to bundle or redistribute a particular FFmpeg build. Before selecting that build, compare LGPL/GPL and codec configuration, Windows redistribution, update/security process, supported inputs/outputs, and fixture coverage. Keep the renderer behind a narrow backend interface so a licensing or compatibility review can change the implementation without changing the editor's project model. The target-device playback tool and proposed gates are in [export validation](EXPORT_VALIDATION.md). No target-device export pass has been recorded.

## Decisions and constraints

- **Do not port or bind this work to the images of other products.** Reference images inform density and panel hierarchy only. The supplied ClipWright icon is a replaceable user-provided asset.
- **React/Vite is the renderer baseline** because the repository was empty, Node/npm are available, and it supports rapid preview/testing. Electron 45 is now installed as a development dependency and the secure shell scaffold builds; GUI startup and Windows behavior have not been validated in this headless Linux environment.
- **No FFmpeg package has been selected.** An executable was not detected in the current environment. Compare redistribution/licensing and Windows packaging strategies before choosing bundled vs user-installed media tools.
- **No database has been selected.** First define the versioned project document and access patterns; avoid adding SQLite before it is justified.
- **Foundation persistence is deliberately limited.** localStorage is a browser-profile project-list store, not a durable project format. This limitation appears in UI and documentation.

## Initial communication contracts

1. UI requests typed application commands, not direct shell/file operations.
2. Project services validate external data before mutation and return structured errors.
3. Timeline commands are pure/undoable where possible.
4. Media jobs and AI providers implement explicit capability/task contracts.
5. Preview and render consume the same versioned edit instructions and report unsupported effects explicitly.

## Next architecture gate

The next desktop-distribution gate is a successful Windows workflow run (NSIS build plus packaged renderer/preload smoke test), followed by manual install, launch, upgrade, and uninstall checks on a supported Windows machine. This Linux sandbox has no graphical display and cannot download the Electron binary, so it can validate the builder configuration, compilation, and pure security helpers but not produce or execute the Windows installer. The current installer is unsigned and uploaded only as a short-lived CI artifact; do not treat it as a public release. Separately, the v2 project schema, timeline-master browser playback, two-deck source preloading, and frame-snapped clip-editing operations now exist; sequence-level undo/redo is session-only. Before claiming broader media compatibility, add representative local fixtures, validate browser codec behavior, and review a container-aware probe/render approach and its licensing/package implications. Playback and the real-time WebM export are still browser-decoded; there is no compositor or offline/final-render path.
