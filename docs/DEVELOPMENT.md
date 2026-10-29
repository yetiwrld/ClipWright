# Development setup

## Requirements

- Node.js 22.12 or newer and npm.
- Git.
- Windows 11 for the Electron desktop shell and NSIS installer smoke test. The current shell/installer configuration was authored in a Linux sandbox; the Windows workflow must pass before claiming Windows installation support.

## Commands

```bash
npm install
npm run dev       # Vite dev server (binds 0.0.0.0 for hosted previews)
npm test          # unit tests
npm run build     # strict TypeScript check + production bundle
npm run preview   # serve the built renderer
npm run desktop:dev     # Electron window with a separate Vite server (desktop session required)
npm run desktop:smoke   # built renderer/preload IPC smoke check (desktop session required)
npm run desktop:dist:win # unsigned x64 NSIS installer; Windows only
```

No `.env` file or credentials are needed. Do not add real credentials to `.env`; a future provider integration must use OS credential storage and a consented IPC boundary.

## Current storage warning

The foundation saves project-entry metadata, validated schema-v2 documents, timeline edits, and theme preferences in browser localStorage. Older v1 project documents migrate on load. Browser data can be cleared. `.cwproject` files can be imported and downloaded as JSON snapshots, but source media is not embedded and the app does not manage project folders or atomic saves. Do not store important edits here or assume a downloaded document contains the media.

## Working practices

- Keep features small and update the inventory/known limitations when behavior changes.
- Add domain tests for timeline arithmetic, serialization, and task-state contracts before building their UI.
- Never use user footage, credentials, generated exports, downloaded models, or private logs as fixtures/committed files.
- Use actual local fixtures and validate rendered output before describing an edit/export feature as working.
- Review dependency advisories and licenses before releases.
