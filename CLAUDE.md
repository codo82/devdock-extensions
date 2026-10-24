# devdock-extensions — notes for Claude Code

Official DevDock extensions: one folder per extension, catalog in `index.json`. The extension contract is DevDock's `docs/EXTENSIONS.md` (repository `codo82/devdock`).

- Commit messages in Italian; README, CHANGELOGs and docs in English. UI text only in the catalogs (`<code>/i18n/<lang>.json`, Italian is the source and must be complete).
- Every change to an extension goes in the `## [Unreleased]` section of its `CHANGELOG.md`; releases only through `npm run release <code> <level>` (version, changelog, catalog, tag `<code>@<version>`).
- After changing a manifest run `npm run catalog` and commit `index.json`.
- Tests: `npm test`; each extension's tests use `require('devdock/testkit')` and start DevDock with the extension installed (`{ install: [path.join(__dirname, '..')] }`).
