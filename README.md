# ClipWright Studio

ClipWright Studio is the starting point for a local-first Windows video editor and AI-assisted clipping application. The supplied ClipWright icon is included as a replaceable asset; the wordmark and Graphite + Electric Orange theme are deliberately easy to change.

> **Current status — foundation build (0.1.0).** This is an early React + TypeScript application shell, not yet a Windows desktop editor. It has a functional local project-list dashboard, project-entry management, theme switching, and a searchable command palette. Media ingestion, playback, timeline editing, transcription, AI clipping, and rendering are not implemented. The UI labels these limitations rather than simulating their results.

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
- Persist project-list entries in browser local storage, scoped to the browser profile.
- Open, rename, duplicate, favourite, archive/restore, search, and delete project entries.
- Deletion is confirmed and removes only the entry; it never deletes media.
- Dark and light themes, keyboard shortcuts (`Ctrl/Cmd+K`, `Ctrl/Cmd+N`), a working command palette, and task-centre status.
- Honest, explicit unavailable states for the not-yet-built editor and AI/media processing systems.

Projects created in this foundation are **not portable project files** and do not contain source media or edits. Do not use browser storage as the sole copy of important work.

## Repository guide

- `src/App.tsx` — workspace shell and first foundation UI.
- `src/lib/projects.ts` — validated project-entry model and local persistence boundary.
- `src/styles/tokens.css` — centralized theme, typography, and spacing tokens.
- `docs/` — audit, architecture decisions, setup notes, and current limitations.
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
