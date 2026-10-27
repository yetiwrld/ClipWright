# ClipWright project document schema — v1

Status: implemented as a validated TypeScript data contract; integrated with project creation, browser-local document storage, `.cwproject` downloads/import, session-only browser-picked video metadata/source preview, and basic persisted video clip placement/reposition/removal. Imported project paths are not auto-resolved, but video references can be relinked via the file picker. Atomic filesystem writes and crash recovery are not yet implemented.

## Why two stores exist

The dashboard project entry (`projects.ts`) is a small index record used for names, favourites, archive state, and sorting. A `ProjectDocument` is the actual structured project payload. In this browser foundation, documents are stored separately under `clipwright.project-documents.v1`; this is not a managed project-folder adapter. “Download .cwproject” serializes a validated copy to the browser’s download flow. “Open project file” reads a local `.cwproject`/JSON file, validates it before state changes, and adds it to the dashboard. ID collisions are imported as a separate copy with a new project ID rather than replacing existing data. The file contains supported project structure and media path references, but does not include source media.

## v1 shape

`src/lib/projectDocument.ts` defines the format:

- `schemaVersion` (currently 1), `appVersion`, stable project ID, and metadata timestamps.
- `projectSettings.defaultSequenceId`.
- `assets[]` with stable IDs, display name, source path, path kind (`absolute`, `project-relative`, or `browser-session`), media kind, optional media-stream descriptors, optional size and fingerprint. Paths are references; media bytes and temporary browser URLs are never embedded.
- Stream metadata can include `metadataSource: "browser" | "container"` so browser-reported observations are distinguishable from future container inspection.
- `sequences[]` with dimensions, exact rational frame rate, audio sample rate, duration in integer frames, and ordered tracks.
- `tracks[]` currently support video/audio kind, name, mute/lock flags, and clips.
- Video clips use integer `timelineStartFrame` and `timelineDurationFrames`; audio clips use integer `timelineStartSample` and `timelineDurationSamples` plus an explicit sample rate. Source ranges use integer stream ticks, interpreted using that source stream’s rational `timeBase` (seconds per tick). Playback rate is rational.

Rationals use `{ "numerator": n, "denominator": d }` with positive safe integers; video frame rates are constrained to 1–240 fps. For example, 29.97 fps is stored exactly as `{ "numerator": 30000, "denominator": 1001 }`, not as a binary floating-point seconds value.

## Validation and serialization

`validateProjectDocument` checks required fields, supported schema version, safe integer timing, rational denominators, dimensions/rates, unique IDs, track/clip kind agreement, media references, stream presence, source boundaries, default-sequence references, and video clip bounds against sequence duration. `serializeProjectDocument` refuses invalid structures; `parseProjectDocument` reports malformed JSON or field-specific validation failures. Unknown future schema versions are rejected instead of being silently rewritten.

The current UI can append a full-length video source to an unlocked video track, reposition a video clip to an integer frame without overlapping another clip on that track, and remove it. These operations update and validate the same project document persisted by the existing browser-local store. Source trims, split/edge edits, undo/redo, audio-lane editing, effects, transitions, titles, captions, keyframes, colour/audio processing, project history, proxy state, and renderer compatibility metadata are not implemented.

## Browser-picked video references

The Editor can create a `browser-session` video asset from a user-selected `File`. The document stores the selected file's basename and browser-reported size, width, height, and duration. The observed duration is represented in rounded microsecond ticks (`timeBase: 1/1,000,000`) and tagged `metadataSource: "browser"`; no frame rate is inferred from this metadata. These are browser media-element values, not verified container timestamps or a frame-accurate probe. When placing a source on a sequence, its full duration is rounded to the nearest sequence frame for `timelineDurationFrames`; source ticks remain stored separately, and no clip trimming is performed.

The actual `File` is referenced through a temporary `blob:` object URL kept only in app memory and revoked when replaced, deleted, or when the app is left. The URL and media bytes are never written to localStorage or a `.cwproject`. Ordinary browser file pickers do not expose a durable local path, so every session-only source must be relinked after reload. Existing absolute/project-relative paths imported from project files are not checked automatically; users can relink video assets by selecting the corresponding local file.

Preview uses the browser's native `<video>` decoder and playback controls. Supported containers/codecs vary by browser and operating system; this is not transcoding, complete codec detection, or frame-accurate timeline playback. Audio-only and image previews are not supported by this increment.

## Migration

The initial dashboard stored project-list records before project documents existed. Those records have no `schemaVersion`; `migrateLegacyProjectEntry` converts them into v1 documents with an empty sequence and video/audio tracks. Sequence and track IDs are deterministic for this migration, making a retry idempotent. Invalid legacy entries are not migrated. Future schema versions are rejected until a real migration is added and tested.

On application startup, the app fills in missing v1 documents for valid legacy dashboard entries. If the v1 document store is malformed, the raw value is left untouched and automatic writes stop. The user can explicitly preserve a browser-local recovery copy before rebuilding empty documents from the dashboard list.

## Persistence limits

Browser localStorage is an interim adapter with limited capacity and no atomic file-write guarantee. Opening a project file imports its document into browser storage; a download is a user-triggered JSON snapshot, not autosave. It does not overwrite an existing file through an application-managed safe-replacement flow, and the source media is not packaged. Do not use this foundation as the only copy of important production work. The Windows desktop storage adapter should later provide user-selected project locations, validated load/import, atomic save, checkpoints, and recovery before relying on this model for real editing projects.
