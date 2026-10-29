# Persistent media restoration root-cause analysis

## Findings before implementation

ClipWright currently persists its project list and project-document collection in browser `localStorage` (`src/lib/projects.ts` and `src/lib/projectDocument.ts`). The document schema can represent absolute, project-relative, and browser-session media references, but current video/audio ingestion writes only the selected filename with `pathKind: "browser-session"` (`src/App.tsx`). The runtime source registry is a React state map of `URL.createObjectURL(File)` values. These Blob URLs are revoked when replaced or when the renderer unmounts; they are not serializable or valid after a process restart.

The Electron `.cwproject` API (`electron/projectFiles.cjs`, `electron/main.cjs`) already has validated, atomic manifest writes and recovery checkpoints, but it is opt-in through Save/Open. It saves the document only, not the source media; opening a manifest does not resolve or restore media. The preload exposes narrow project and export APIs, but no application-data library or media-copy/relink APIs. There is no startup scan for disk projects or last-opened-project restoration.

Therefore the primary failure is not a lost timeline serializer: it is that the only current media locator is an ephemeral browser-session filename/Blob URL, while project documents and project-list restoration are renderer-profile-local. Saving a `.cwproject` preserves edit state but cannot restore those runtime media URLs.

## Scope and safety constraints

The persistent desktop library will live under Electron's per-user `userData` directory. Managed copies will be written separately from source files and referenced relative to the per-project library folder; external links will remain absolute references. Manifest writes will reuse the existing validation, atomic replace, hash-conflict checks, and recovery checkpoints. Renderer access will be through sender-validated IPC and opaque media URLs; no Node filesystem API or arbitrary filesystem path API will be exposed. Export receives a cloned/serialized project snapshot and the resolved source map at export start; persistence changes must not mutate that snapshot.

This report records the observed cause before implementation. The current implementation adds a separate `ClipWright Studio` tree below Electron `userData`, per-project v2 manifests and managed-media folders, explicit managed/linked imports, opaque streaming media URLs, startup library/recent-project restore, recovery checkpoints, portable backups, and safe cache-only cleanup. Filesystem tests now include a fresh Node process reloading a manifest and restoring a backup into another directory. They are not a substitute for launching the packaged desktop application, closing it, and verifying the UI restoration path. At this revision, no actual packaged-app restart test or Windows CI run has been performed.
