# Known limitations — foundation build 0.1.0

This is the initial application foundation, not a usable video editor yet.

- Runs as a web renderer/dev server. There is no Electron main process, native Windows app, installer, or portable build.
- Project records and theme settings use browser localStorage. There are no standalone project files, user-selected project folders, media references, project migration, autosave, checkpoints, or crash recovery.
- No media import, metadata inspection, playback, preview decoding, sequence/timeline model, clip editing, undo/redo, audio, effects, captions, AI, rendering, or export.
- Editor and AI Clipping workspaces are navigable shells that explicitly describe unavailable capabilities; no fake processing is performed.
- No FFmpeg binary/library, AI model, cloud provider, database, plugin system, telemetry, or credential store is included.
- The generated project card background is visual decoration only, not a real media thumbnail.
- The icon asset was supplied by the requester, but its redistribution rights are unverified.
- No Windows hardware benchmark, codec compatibility test, end-to-end media test, or installer test has been run.
