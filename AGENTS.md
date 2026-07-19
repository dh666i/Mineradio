# Mineradio Project Rules

## Project Identity

Mineradio is a Windows Electron desktop music player. Its core experience includes music search and playback, playlists, lyrics, a 3D playlist shelf, particle visuals, DIY controls, and GitHub updates.

- Repository: `https://github.com/dh666i/Mineradio.git`
- Current source version: `v1.5.0`
- Desktop entry: `desktop/main.js`
- Main UI: `public/index.html`

## Repository Layout

```text
Mineradio/
|- public/          # Main UI, styles, player logic, lyrics, and visuals
|- desktop/         # Electron main process and preload code
|- build/           # Packaging resources and installer scripts
|- docs/            # Maintained technical and design documentation
|- server.js        # Local API, music sources, and update handling
|- dj-analyzer.js   # Beat and audio analysis
|- package.json     # Scripts and electron-builder configuration
`- CHANGELOG.md     # Release notes
```

## Commands

```powershell
npm start
node --check server.js
npm run build:win:dir
npm run build:win
```

There is no standalone automated test suite. For every code change, run at least:

```powershell
git diff --check
node --check server.js
```

When `public/index.html` changes, also parse its inline CSS and JavaScript and verify the affected workflow in the Electron development build.

## Implementation Guardrails

- Keep the product as a desktop Electron application; do not replace it with a web-only client.
- Reuse the existing visual system and local helpers before adding new dependencies or abstractions.
- Keep changes scoped. `public/index.html` is large, so locate relevant selectors and functions before editing.
- Preserve the established dark glass treatment, stable frame rate, and responsive desktop layout.
- Do not regress search, playback controls, lyrics, the DIY console, or the 3D playlist shelf while changing Home.
- Music service integrations must handle expired login state, unavailable tracks, request failures, and empty results explicitly.
- Never commit account cookies, tokens, local user data, build output, or machine-specific paths.

## Release Workflow

1. Update versions in `package.json` and `package-lock.json` when preparing a release.
2. Update the top section of `CHANGELOG.md`.
3. Run syntax, whitespace, and focused behavior checks.
4. Build with `npm run build:win`.
5. Publish the installer and required update metadata to the configured GitHub repository.

Keep license and provenance information in `LICENSE` and `NOTICE.md`. Do not add donation, sponsorship, or personal promotion material to the repository.
