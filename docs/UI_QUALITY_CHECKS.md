# UI quality and visual-regression checks

ClipWright currently has React/Vitest tests and production build checks, but no browser screenshot-testing dependency. This process keeps the automated gate on the tools already in the repository and adds a repeatable manual screenshot comparison instead of implying that pixel-level regression is automated.

## Automated gate

Run before merging UI changes:

```sh
npm run qa:ui       # Vitest suite, TypeScript, and production renderer/export builds
npm run test:desktop # Electron security, project-file, export-file, and storage tests
```

The UI suite covers appearance palettes and scale tokens, dashboard preferences, onboarding/tour navigation, and a 61-project incremental-rendering case. Appearance checks also enforce at least 4.5:1 for normal semantic text, status colors, and accent text; 3:1 for disabled text and focus rings; and no explicit CSS font size below 12px. The shared type scale is 12/13/14/15px for xs/sm/md/base, with shared regular/medium/semibold/bold weights and tight/UI/normal/reading/relaxed line-height tokens. The desktop suite is separate so renderer-only work does not accidentally skip Electron security/storage coverage.

## Repeatable visual comparison

1. Launch the app from the same build each time (`npm run dev` in a browser, or the existing desktop preview workflow) and use the same OS display scaling and window dimensions. Start with **1440 × 900**, then check a compact **1024 × 768** window and a narrow **768 × 1024** viewport where browser testing is available.
2. Capture the same states after each UI change. Save temporary captures outside the source tree (or under an ignored local artifact folder), named by commit and viewport; do not commit screenshots unless a reviewed baseline is intentionally being added.
3. Compare each capture side by side with the previous reviewed capture. Check for clipped/overlapping controls, unexpected horizontal scroll, text truncation that hides meaning, changed alignment, and accents that no longer match the selected palette. Ignore transient media frames, timestamps, cursor position, and animation timing. If an image-diff utility is already installed locally, it may be used to highlight changed pixels; no new dependency is required.
4. Record the build/commit, viewport, scale, theme/accent, and states checked alongside any intentional visual changes. A changed screenshot is a review prompt, not automatically a defect or a passing result.

### Minimum state matrix

- **Dashboard:** no projects and welcome panel; one project; long project name; search with results and with no results; archived filter; and 61 projects (confirm the first 60 render, then “Load more projects” reveals the remainder).
- **Editor:** empty timeline; representative video and audio clips; long media names; Help dialog; each guided-tour step; and settings open beside the editor.
- **Appearance:** check 90%, 100%, 110%, and 125% at the supported window sizes. Check dark and light themes with orange, blue, and violet accents; verify navigation selection and timeline clip/selection/header treatments change together. Also inspect real rendered text contrast, focus visibility, and hover, selected, disabled, success, warning, and error states; ensure semantic audio/error colors remain distinct and labels are not clipped.
- **Keyboard/reflow:** tab through dashboard controls, project actions, settings, and tour controls; verify focus is visible, Escape dismisses transient UI, and Back/Next/Skip do not trap focus. Resize the window while each major surface is open.

## Review notes

- Automated DOM tests do not measure actual rendered geometry, operating-system display scaling, screen-reader output, or real media decoding/export. Record those as manually checked only when they were actually exercised.
- Keep the current capture set small and representative. Re-capture after deliberate visual changes rather than updating baselines automatically, so unexpected regressions remain visible.
