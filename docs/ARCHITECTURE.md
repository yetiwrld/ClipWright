# Initial architecture decisions

Status: foundation only. These decisions establish seams and priorities, not a claim that future subsystems already exist.

## Current implementation

The current runnable increment is a TypeScript/React renderer built with Vite. Workspace selection is held in React state. Project-list records pass through `src/lib/projects.ts`, which validates their basic shape before reading localStorage. The localStorage adapter is intentionally isolated so it can be replaced by a desktop persistence adapter. The current browser app does **not** expose unrestricted filesystem or shell APIs. A version-1 `ProjectDocument` is used by project creation, local-file open/import, and user-triggered `.cwproject` JSON downloads. Project payloads remain in a separate browser-local storage key; see [the schema and storage limitations](PROJECT_SCHEMA.md). Video files can be selected in the browser for metadata and source preview using a temporary in-memory object URL; no durable local path or media bytes are saved, so the source must be relinked after reload.

## Target Windows architecture

Adopt an Electron desktop shell around the existing renderer, retaining a web development/preview path:

- **Main process:** app lifecycle, native dialogs, secure file access, project-store orchestration, media/render child processes, OS integration, and credential storage.
- **Preload bridge:** narrow, typed, allowlisted IPC methods; no raw `ipcRenderer`, Node, or unrestricted filesystem in the renderer.
- **Renderer:** React + TypeScript UI, design system, project views, command palette, accessible controls. All state crossing IPC is validated.
- **Project core:** versioned JSON project document with stable IDs, schema validation/migration, integer video-frame positions/rational timebases, and separate audio sample timing. V1 is implemented; atomic desktop-file saves and rotating recovery checkpoints are not. Browser storage/downloads are interim, not the future managed project-file adapter.
- **Media services:** dedicated probe/import and thumbnail/waveform workers. Probe candidate: FFmpeg/ffprobe, subject to Windows packaging, codec configuration, licensing, and fixture tests. Keep original media immutable; references and proxies are separate.
- **Editing core:** the browser foundation currently has pure append, frame-indexed reposition with overlap checks, source-tick trim, and removal commands for video clips. UI undo/redo snapshots the edited sequence in memory only. Durable history, audio editing, timeline-synchronized playback, and broader UI-independent editing commands remain future work.
- **Preview/render:** preview and final render consume the same project instructions where feasible. Isolate decoder/encoder processes from the UI thread. An FFmpeg filter graph may serve a verified initial export path, but does not itself supply the editor model or full real-time compositor.
- **Tasks:** durable task records and worker adapters expose real stages/progress only when measured. Cancellation/retry/pause semantics are declared per task capability.
- **AI providers:** typed capability interfaces, local provider first where feasible, opt-in cloud providers behind explicit consent and secure credential storage. No provider or model is currently included.
- **Persistence:** project files in user-chosen locations; preferences/task metadata in an appropriate local store. Never store large source media in a database by default.

## Decisions and constraints

- **Do not port or bind this work to the images of other products.** Reference images inform density and panel hierarchy only. The supplied ClipWright icon is a replaceable user-provided asset.
- **React/Vite is the renderer baseline** because the repository was empty, Node/npm are available, and it supports rapid preview/testing. Electron remains the planned Windows runtime; it has not been installed or validated yet.
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

The v1 project schema, browser-local source preview, and a minimal pure timeline command set (append, frame-indexed reposition with overlap checks, source-tick trim, and removal) now exist; sequence-level undo/redo is session-only. Before timeline-synchronized playback, add a representative real media fixture and decide how playback timing will align with a future renderer. Before claiming broader media compatibility, add more local fixtures and review a container-aware probe/render approach and its licensing/package implications. The current browser source preview remains separate from the timeline.
