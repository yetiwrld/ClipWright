# ClipWright project document schema — v1

Status: implemented as a validated TypeScript data contract; integrated with project creation, browser-local document storage, and `.cwproject` downloads. Media import, relinking, timeline mutation, opening downloaded files through the application, atomic filesystem writes, and crash recovery are not yet implemented.

## Why two stores exist

The dashboard project entry (`projects.ts`) is a small index record used for names, favourites, archive state, and sorting. A `ProjectDocument` is the actual structured project payload. In this browser foundation, the document payload is stored separately under `clipwright.project-documents.v1`; it is **not** a managed on-disk project file. The card action “Download .cwproject” serializes a validated copy for the user’s browser download folder. The file contains project metadata and the default empty sequence/tracks; it does not include source media, and there is no project-file open/import command yet.

## v1 shape

`src/lib/projectDocument.ts` defines the format:

- `schemaVersion` (currently 1), `appVersion`, stable project ID, and metadata timestamps.
- `projectSettings.defaultSequenceId`.
- `assets[]` with stable IDs, display name, source path, path kind, media kind, optional media-stream descriptors, optional size and fingerprint. Paths are references; media bytes are never embedded.
- `sequences[]` with dimensions, exact rational frame rate, audio sample rate, duration in integer frames, and ordered tracks.
- `tracks[]` currently support video/audio kind, name, mute/lock flags, and clips.
- Video clips use integer `timelineStartFrame` and `timelineDurationFrames`; audio clips use integer `timelineStartSample` and `timelineDurationSamples` plus an explicit sample rate. Source ranges use integer stream ticks, interpreted using that source stream’s rational `timeBase` (seconds per tick). Playback rate is rational.

Rationals use `{ "numerator": n, "denominator": d }` with positive safe integers. For example, 29.97 fps is stored exactly as `{ "numerator": 30000, "denominator": 1001 }`, not as a binary floating-point seconds value.

## Validation and serialization

`validateProjectDocument` checks required fields, supported schema version, safe integer timing, rational denominators, dimensions/rates, unique IDs, track/clip kind agreement, media references, stream presence, source boundaries, default-sequence references, and video clip bounds against sequence duration. `serializeProjectDocument` refuses invalid structures; `parseProjectDocument` reports malformed JSON or field-specific validation failures. Unknown future schema versions are rejected instead of being silently rewritten.

The format currently represents only the editing foundation: media references, sequence settings, and basic video/audio clip placement. Effects, transitions, titles, captions, keyframes, colour/audio processing, project history, proxy state, and renderer compatibility metadata remain future schema additions, not implied capabilities.

## Migration

The initial dashboard stored project-list records before project documents existed. Those records have no `schemaVersion`; `migrateLegacyProjectEntry` converts them into v1 documents with an empty sequence and video/audio tracks. Sequence and track IDs are deterministic for this migration, making a retry idempotent. Invalid legacy entries are not migrated. Future schema versions are rejected until a real migration is added and tested.

On application startup, the app fills in missing v1 documents for valid legacy dashboard entries. If the v1 document store is malformed, the raw value is left untouched and automatic writes stop. The user can explicitly preserve a browser-local recovery copy before rebuilding empty documents from the dashboard list.

## Persistence limits

Browser localStorage is an interim adapter with limited capacity and no atomic file-write guarantee. A download is a user-triggered JSON copy, not autosave. It does not overwrite an existing file through an application-managed safe-replacement flow. Do not use this foundation as the only copy of important production work. The Windows desktop storage adapter should later provide user-selected project locations, validated load/import, atomic save, checkpoints, and recovery before relying on this model for real editing projects.
