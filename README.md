# ClipWright Studio

ClipWright Studio is the starting point for a local-first Windows video editor and AI-assisted clipping application. The supplied ClipWright icon is included as a replaceable asset; the wordmark and Graphite + Electric Orange theme are deliberately easy to change.

> **Current status — foundation build (0.1.0).** This is an early React + TypeScript application shell, not yet a Windows desktop editor. It has a local project dashboard, versioned project documents, `.cwproject` import/download, browser-local video metadata inspection and in-session source preview, plus basic video timeline operations (append, move, source trim, remove, and session-only undo/redo). Project files never contain media bytes or temporary object URLs. Browser-picked media must be relinked after reload. Timeline playback, audio editing, transcoding, AI clipping, and rendering are not implemented.

## Run locally

Requirements: Node.js 22.12+ and npm. (The repository was inspected in a Linux development container; Windows packaging and Windows hardware have not yet been validated.)

```bash
npm install
npm run dev
```

Open the Vite URL printed in the terminal. The development server binds to `0.0.0.0` to support the hosted preview. Build and test with:

```bash
npm test
npm run build
```

## Current functionality

- Home, AI Clipping, and Editor workspace navigation.
- Create projects with aspect ratio and frame-rate preferences.
- Persist project-list entries and version-1 project documents in browser local storage, scoped to the browser profile.
- Create projects with a default video/audio sequence, integer frame-based video timing, sample-based audio timing, and rational frame rates.
- Download a validated `.cwproject` JSON document from a project card and open/import it from a local file picker; source media is not included.
- Imports validate the schema before changing state, preserve exact sequence settings, and open ID collisions as separate copies instead of replacing existing projects.
- Select a local video file to inspect browser-reported duration and dimensions and preview it with native browser decoding and in-app playback/seek/volume controls.
- Keep picked media available only for the current page session using a revocable object URL. The project document stores a filename-only `browser-session` reference and browser-reported metadata, never the bytes or temporary URL; relinking is required after reload.
- `.cwproject` path references are not auto-resolved or verified. Imported video references can be relinked through the file picker.
- Append the selected in-session video source to an unlocked video track, reposition clips by integer sequence-frame index without overlap, trim source in/out points in stream ticks, remove clips, and persist the resulting project document. Source-duration-to-sequence mapping is rounded from browser-reported duration; undo/redo history is session-only and source preview remains separate from the timeline.
- Migrate the foundation’s earlier project-list records into empty v1 documents; preserve unreadable data until the user confirms recovery.
- Open, rename, duplicate, favourite, archive/restore, search, and delete project entries.
- Deletion is confirmed and removes only local project entries/documents; it never deletes media.
- Dark and light themes, keyboard shortcuts (`Ctrl/Cmd+K`, `Ctrl/Cmd+N`), a working command palette, and task-centre status.
- Honest, explicit unavailable states for timeline playback, audio editing, AI analysis, and export; full-frame preview, split/advanced edits, and audio-lane operations are not implied by the basic video timeline.

A `.cwproject` file is a portable JSON document that can be reopened by this foundation. It preserves supported project structure and references to source paths, but does not bundle media. Browser storage is interim and may be cleared; downloads are user-triggered snapshots rather than autosaved files, so do not rely on browser storage as the only copy of important work.

## Repository guide

- `src/App.tsx` — workspace shell and first foundation UI.
- `src/lib/projects.ts` — validated project-entry model and local persistence boundary.
- `src/lib/projectDocument.ts` — versioned project-file contract, validation, serialization, migration, and document storage.
- `src/styles/tokens.css` — centralized theme, typography, and spacing tokens.
- `docs/` — audit, architecture decisions, project schema, setup notes, and current limitations.
- `public/assets/clipwright-icon.png` — user-provided replaceable icon.

## Roadmap

1. Desktop shell and persistence contracts.
2. Versioned project files, safe writes, and project dashboard storage.
3. Browser-local video metadata and in-session source preview (implemented foundation; relink after reload).
4. Extend the minimal video timeline with synchronized timeline playback, split/advanced edits, and a verified render vertical slice.
5. Transcription, explainable clip suggestions, and captions.
6. Reframing, effects, audio, colour, recovery, and Windows distribution.

See [the architecture notes](docs/ARCHITECTURE.md), [repository audit](docs/REPOSITORY_AUDIT.md), and [known limitations](docs/KNOWN_LIMITATIONS.md). Features are documented as complete only after implementation and verification.

## Privacy and licensing

This foundation has no cloud provider, telemetry, AI model, media upload, or external credential handling. It uses React, Vite, TypeScript, Vitest, and Lucide React; see `package-lock.json` for exact versions and their licenses. The supplied image was provided with the project request; its copyright/redistribution provenance has not been independently verified. See [dependency and asset notes](docs/LICENSING.md).
