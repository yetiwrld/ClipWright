# Dependency, model, and asset licensing notes

- React and React DOM: MIT.
- Vite: MIT.
- TypeScript: Apache-2.0.
- Vitest: MIT.
- Lucide React: ISC.
- Electron: MIT.
- electron-builder: MIT.
- concurrently: MIT.
- cross-env: MIT.
- wait-on: MIT.

These are direct dependency declarations; review the exact transitive dependency licenses in the npm package metadata before distribution. `package-lock.json` records resolved package versions.

No FFmpeg, codecs, fonts, AI models, or plugin packages are bundled in this foundation. Before selecting a media distribution strategy, review FFmpeg build configuration and each codec's patent/licensing implications for the target distribution. Model license and redistribution terms must be checked per model.

The ClipWright icon PNG was supplied by the requester as a project attachment. `packaging/clipwright.ico` is a resized/multi-resolution conversion of that PNG for the Windows installer. No license or attribution statement accompanied the original; distribution/redistribution rights for both files are not verified, and the icon remains replaceable.
