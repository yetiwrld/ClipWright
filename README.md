# ClipWright Studio

ClipWright Studio is the starting point for a local-first Windows video editor and AI-assisted clipping application. The supplied ClipWright icon is included as a replaceable asset; the wordmark and Graphite + Electric Orange theme are deliberately easy to change.

> **Current status — foundation build (0.1.0).** This is an early React + TypeScript application shell, not yet a Windows desktop editor. It has a functional local project dashboard, versioned project-document schema, `.cwproject` JSON downloads, theme switching, and a searchable command palette. The app can open/import `.cwproject` files and download project snapshots. Files contain project metadata, sequence/track data, and media path references, but never media bytes. Media ingestion, playback, timeline editing, transcription, AI clipping, and rendering are not implemented. The UI labels these limitations rather than simulating their results.

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
- Migrate the foundation’s earlier project-list records into empty v1 documents; preserve unreadable data until the user confirms recovery.
- Open, rename, duplicate, favourite, archive/restore, search, and delete project entries.
- Deletion is confirmed and removes only local project entries/documents; it never deletes media.
- Dark and light themes, keyboard shortcuts (`Ctrl/Cmd+K`, `Ctrl/Cmd+N`), a working command palette, and task-centre status.
- Honest, explicit unavailable states for the not-yet-built editor and AI/media processing systems.

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
3. Media probe/import and a real preview.
4. Frame-accurate sequence, timeline operations, undo/redo, and render vertical slice.
5. Transcription, explainable clip suggestions, and captions.
6. Reframing, effects, audio, colour, recovery, and Windows distribution.

See [the architecture notes](docs/ARCHITECTURE.md), [repository audit](docs/REPOSITORY_AUDIT.md), and [known limitations](docs/KNOWN_LIMITATIONS.md). Features are documented as complete only after implementation and verification.

## Privacy and licensing

This foundation has no cloud provider, telemetry, AI model, media upload, or external credential handling. It uses React, Vite, TypeScript, Vitest, and Lucide React; see `package-lock.json` for exact versions and their licenses. The supplied image was provided with the project request; its copyright/redistribution provenance has not been independently verified. See [dependency and asset notes](docs/LICENSING.md).
