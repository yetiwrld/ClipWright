# ClipWright project document schema — v2

Status: schema v2 is used by project creation, browser-local storage, `.cwproject` import/export, timeline playback, and clip editing. Desktop builds additionally support native open/save, linked-file autosave, atomic replacement, and up to ten recovery checkpoints per project. Project documents store references and edit instructions only—never media bytes or temporary object URLs. Undo/redo history remains session-only.

## Why two stores exist

The dashboard project entry (`projects.ts`) is a small index used for names, favourites, archive state, and sorting. A `ProjectDocument` is the structured project payload. Documents remain in the browser-local key `clipwright.project-documents.v1` for compatibility with stored v1 documents; records migrate in memory to v2 when loaded. `.cwproject` files contain project structure and source references, not media. Browser imports with ID collisions become separate copies; the desktop open dialog asks before replacing an existing browser copy with the file version.

## v2 shape

`src/lib/projectDocument.ts` defines the format:

- `schemaVersion: 2`, `appVersion`, stable project ID, metadata timestamps, and `projectSettings.defaultSequenceId`.
- `assets[]` with stable IDs, display name, source path, path kind (`absolute`, `project-relative`, or `browser-session`), media kind, stream descriptors, optional size, and fingerprint. Browser-picked sources use a filename-only session reference; bytes and temporary URLs are not serialized.
- Stream metadata may include `metadataSource: "browser" | "container"` so browser-reported observations remain distinguishable from container inspection.
- `sequences[]` with dimensions, exact rational frame rate, audio sample rate, `durationFrames`, and tracks.
- `tracks[]` support video/audio kinds, name, mute/lock flags, and clips. Optional `gain` is linear 0–2 (default 1) and optional `pan` ranges from -1 (left) to 1 (right, default 0/center); they remain optional so earlier schema-v2 documents validate unchanged.
- Every clip has `{ id, sourceId, trackId, start, trimIn, trimOut }`. Times are seconds aligned to whole sequence frames. `start` is a timeline position; `trimIn` and `trimOut` are source positions. Original source media is not modified.
- Sequence duration is derived from the maximum end time across all tracks. Same-track clips may not overlap.

Rationals use `{ "numerator": n, "denominator": d }` with positive safe integers; video frame rates are constrained to 1–240 fps. For example, 29.97 fps is stored exactly as `{ "numerator": 30000, "denominator": 1001 }`.

## Validation, editing, and playback

`validateProjectDocument` checks schema version, required fields, IDs, dimensions/rates, frame-aligned clip timing, track/clip kind agreement, source references and boundaries, same-track overlaps, default-sequence references, and derived sequence duration. Serialization refuses invalid structures; parsing reports malformed JSON or field-specific validation failures. Unknown future schema versions are rejected rather than silently rewritten.

Pure timeline operations add, move, resize/trim, split, remove, ripple-delete, duplicate, and paste generic clips. Operations quantize to the sequence frame rate, enforce source boundaries and non-overlap, recalculate sequence duration, and leave media assets untouched. App edits persist to browser storage; if linked to a desktop project file, edits also autosave to disk after a short debounce. Sequence, track-state, and audio mix-setting undo/redo is available for the current session only.

Timeline playback uses timeline time as its master clock. Two browser video elements follow timeline time; the next active source is preloaded before a cut, each clip maps timeline time to `trimIn + (timelineTime - start)`, gaps remain black while the clock continues, and playback stops at the end of the last clip on any track. Browser drift is corrected during playback. Audio clips on separate tracks use browser audio elements, follow timeline seeks/trims, and mix while honoring track mute, per-track gain/pan, session-only solo, and shared preview volume. Per-track gain/pan is routed through Web Audio when available; the preview is a single active video layer, not a compositor, and actual decoding/seeking remain browser/codec-dependent. Stereo waveform peaks can be generated on demand for relinked local audio up to 20 MB and 3 minutes; they are kept only in page memory and are not part of the project schema. Audio automation is not included.

The Editor can record a real-time WebM export from the timeline by drawing the active video frame to a canvas stream and mixing media-element audio through Web Audio into `MediaRecorder`. The UI defaults to exact sequence dimensions and offers 720p/540p/360p long-edge sizes plus compact/standard/high target bitrate profiles; these are encoder targets, not quality guarantees. The browser must support canvas capture, Web Audio, and a WebM codec. This is not an offline or frame-deterministic renderer, and output quality remains browser/device dependent and unvalidated.

## Browser-picked media references

The Editor can create `browser-session` video and audio assets from user-selected `File`s after rejecting empty files and obvious media-kind/MIME mismatches; metadata must probe successfully before project state or an existing relink target is replaced. The document stores the basename, browser-reported size, and duration; video also stores dimensions. Browser duration uses rounded microsecond ticks (`timeBase: 1/1,000,000`) and video metadata is tagged `metadataSource: "browser"`; frame rate and audio channel layout are not inferred. These are not verified container timestamps or a frame-accurate probe.

The actual `File` is referenced through an in-memory `blob:` URL revoked when replaced or when the app is left. The URL and media bytes are never written to localStorage or `.cwproject`. Browser file pickers do not expose a durable path, so session sources must be relinked after reload. Imported absolute/project-relative paths are not automatically checked; video and audio assets can be relinked through local file pickers, with bounded filename normalization and metadata probing. Image ingestion is not supported in this increment.

## Migration

Project-list records with no `schemaVersion` are converted to empty v2 documents by `migrateLegacyProjectEntry`. V1 documents with frame/sample positions and stream ticks are converted by `migrateProjectDocumentV1`; source trims are rounded to sequence frames and clamped within source duration. Invalid entries are rejected, not silently repaired. V2 migration is covered by tests for parsing and project-storage loading.

On startup, missing documents are created from valid legacy dashboard records. If the document store is malformed, the raw value is left untouched and automatic writes stop. The user can preserve a browser-local recovery copy before rebuilding empty documents.

## Persistence limits

Browser localStorage remains a limited browser-profile adapter; importing a project file writes its document there, and downloads are user-triggered snapshots. In the Windows desktop app, native dialogs link a `.cwproject` file to a session-scoped opaque handle. Save/Save As and Ctrl+S use an atomic temp-write/replace flow, while linked documents autosave after a 650 ms debounce. Before a changed file is replaced, the existing version is copied to Electron userData and synced; up to ten recovery points per path are retained. The recovery control restores a selected checkpoint while preserving the current on-disk file as another checkpoint. Desktop files are capped at 25 MB and validate schema/identity before writes. Neither storage mode packages source media; browser-session media must be relinked after restart.
