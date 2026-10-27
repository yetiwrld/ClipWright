# ClipWright project document schema — v1

Status: implemented as a validated TypeScript data contract; integrated with project creation, browser-local document storage, `.cwproject` downloads, and validated local-file open/import. Imported media paths are preserved but not checked/relinked. Timeline mutation, atomic filesystem writes, and crash recovery are not yet implemented.

## Why two stores exist

The dashboard project entry (`projects.ts`) is a small index record used for names, favourites, archive state, and sorting. A `ProjectDocument` is the actual structured project payload. In this browser foundation, documents are stored separately under `clipwright.project-documents.v1`; this is not a managed project-folder adapter. “Download .cwproject” serializes a validated copy to the browser’s download flow. “Open project file” reads a local `.cwproject`/JSON file, validates it before state changes, and adds it to the dashboard. ID collisions are imported as a separate copy with a new project ID rather than replacing existing data. The file contains supported project structure and media path references, but does not include source media.

## v1 shape

`src/lib/projectDocument.ts` defines the format:

- `schemaVersion` (currently 1), `appVersion`, stable project ID, and metadata timestamps.
- `projectSettings.defaultSequenceId`.
- `assets[]` with stable IDs, display name, source path, path kind, media kind, optional media-stream descriptors, optional size and fingerprint. Paths are references; media bytes are never embedded.
- `sequences[]` with dimensions, exact rational frame rate, audio sample rate, duration in integer frames, and ordered tracks.
- `tracks[]` currently support video/audio kind, name, mute/lock flags, and clips.
- Video clips use integer `timelineStartFrame` and `timelineDurationFrames`; audio clips use integer `timelineStartSample` and `timelineDurationSamples` plus an explicit sample rate. Source ranges use integer stream ticks, interpreted using that source stream’s rational `timeBase` (seconds per tick). Playback rate is rational.

Rationals use `{ "numerator": n, "denominator": d }` with positive safe integers; video frame rates are constrained to 1–240 fps. For example, 29.97 fps is stored exactly as `{ "numerator": 30000, "denominator": 1001 }`, not as a binary floating-point seconds value.

## Validation and serialization

`validateProjectDocument` checks required fields, supported schema version, safe integer timing, rational denominators, dimensions/rates, unique IDs, track/clip kind agreement, media references, stream presence, source boundaries, default-sequence references, and video clip bounds against sequence duration. `serializeProjectDocument` refuses invalid structures; `parseProjectDocument` reports malformed JSON or field-specific validation failures. Unknown future schema versions are rejected instead of being silently rewritten.

The format currently represents only the editing foundation: media references, sequence settings, and basic video/audio clip placement. Effects, transitions, titles, captions, keyframes, colour/audio processing, project history, proxy state, and renderer compatibility metadata remain future schema additions, not implied capabilities.

## Migration

The initial dashboard stored project-list records before project documents existed. Those records have no `schemaVersion`; `migrateLegacyProjectEntry` converts them into v1 documents with an empty sequence and video/audio tracks. Sequence and track IDs are deterministic for this migration, making a retry idempotent. Invalid legacy entries are not migrated. Future schema versions are rejected until a real migration is added and tested.

On application startup, the app fills in missing v1 documents for valid legacy dashboard entries. If the v1 document store is malformed, the raw value is left untouched and automatic writes stop. The user can explicitly preserve a browser-local recovery copy before rebuilding empty documents from the dashboard list.

## Persistence limits

Browser localStorage is an interim adapter with limited capacity and no atomic file-write guarantee. Opening a project file imports its document into browser storage; a download is a user-triggered JSON snapshot, not autosave. It does not overwrite an existing file through an application-managed safe-replacement flow, and the source media is not packaged. Do not use this foundation as the only copy of important production work. The Windows desktop storage adapter should later provide user-selected project locations, validated load/import, atomic save, checkpoints, and recovery before relying on this model for real editing projects.
