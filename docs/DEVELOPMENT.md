# Development setup

## Requirements

- Node.js 22.12 or newer and npm.
- Git.
- Windows 11 for future desktop packaging validation. The current increment is browser-rendered and has been authored in a Linux sandbox; Windows installation is not yet supported.

## Commands

```bash
npm install
npm run dev       # Vite dev server (binds 0.0.0.0 for hosted previews)
npm test          # unit tests
npm run build     # strict TypeScript check + production bundle
npm run preview   # serve the built renderer
```

No `.env` file or credentials are needed. Do not add real credentials to `.env`; a future provider integration must use OS credential storage and a consented IPC boundary.

## Current storage warning

The foundation saves only small project-entry metadata and theme preferences in browser localStorage. Browser data can be cleared and entries are not standalone project files. Do not store important edits here or assume a project can be moved to another machine.

## Working practices

- Keep features small and update the inventory/known limitations when behavior changes.
- Add domain tests for timeline arithmetic, serialization, and task-state contracts before building their UI.
- Never use user footage, credentials, generated exports, downloaded models, or private logs as fixtures/committed files.
- Use actual local fixtures and validate rendered output before describing an edit/export feature as working.
- Review dependency advisories and licenses before releases.
