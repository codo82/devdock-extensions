# DevDock extensions

Official extensions for [DevDock](https://github.com/codo82/devdock), the local developer dashboard. Each folder is one extension; `index.json` is the official catalog that the DevDock **Extensions** panel (🧩) reads by default.

| Extension | Folder | What it does |
|---|---|---|
| ⚙️ PM2 | [`pm2`](pm2) | PM2 processes: list, start/stop/restart/delete, streaming logs; npm scripts started under PM2 from the NPM section |
| 🔌 Ports | [`ports`](ports) | Listening TCP ports with their process, linked to what DevDock started (npm, PM2, tunnels); stop of the process that holds a port |
| 🍃 MongoDB | [`mongo-client`](mongo-client) | MongoDB client with the features of the DevDock Database section: connections (host, URI or SSH tunnel) in folders with passwords in the DevDock vault, mongosh editor with history, documents as JSON or table with inline edit, every change shown and confirmed, collections and indexes designer, structure, export as JSON/CSV/script, read-only MCP tools |
| 📝 Notes | [`notes`](notes) | To-do lists and sticky notes per project (plus *General*), encrypted with the master password: lists of items to check, reorderable, with the open items on the tab; coloured notes saved automatically |
| 📄 Swagger | [`swagger`](swagger) | Preview of an OpenAPI `.yaml`/`.json` file loaded from disk (Swagger UI from CDN) |

PM2 and Ports were built into DevDock up to 1.23, Swagger up to 2.0. All of them require DevDock 2.0 or later.

## Install

From DevDock: 🧩 **Extensions** → **Catalog** → *Install…*, or from the command line in the DevDock folder:

```bash
npm run ext -- install pm2
npm run ext -- install ports
npm run ext -- install mongo-client
npm run ext -- install swagger
npm run ext -- install notes
```

Any extension can also be installed by URL (🧩 → **From URL**): `https://github.com/codo82/devdock-extensions.git` with the folder of the extension (`pm2`, `ports`, `mongo-client`, `swagger`, `notes`).

## Versions

Every extension has its own version, in its `setting.json` and in its `CHANGELOG.md`, and its own git tags with the code as prefix: `pm2@1.0.0`, `ports@1.2.0`. DevDock proposes the latest tag whose `devdock` range includes the running version, and checks for new tags once a day.

## Development

```bash
npm install          # installs DevDock (devDependency) with its test kit, and the extensions' packages (npm workspaces)
npm test             # every extension's tests (DevDock started with the extension installed)
npm run catalog      # rewrites index.json from the manifests
```

The `mongo-client` tests start a real MongoDB with [mongodb-memory-server](https://github.com/typegoose/mongodb-memory-server), which downloads the `mongod` binary on first use (cached in `~/.cache/mongodb-binaries`); without network access to `fastdl.mongodb.org` those tests are skipped.

To try an extension in a running DevDock while developing it, link its folder into the installed extensions:

```bash
ln -s "$PWD/pm2" ~/.devdock/extensions/pm2     # then restart DevDock, or reload it from the 🧩 panel
```

The extension contract (manifest, backend and frontend `ctx`, configuration, translations, test kit) is in DevDock's [docs/EXTENSIONS.md](https://github.com/codo82/devdock/blob/main/docs/EXTENSIONS.md).

## Adding an extension

1. Create a folder named as the extension `code`, with `setting.json` (`version` and `devdock` are required), the backend and frontend files, `i18n/it.json` and `i18n/en.json`, `CHANGELOG.md` with an `## [Unreleased]` section, and `tests/` (they use `require('devdock/testkit')`: `startServer(config, { install: [path.join(__dirname, '..')] })` starts DevDock with the extension installed, `i18nProblems(dir)` checks its translations).
2. npm packages used by the extension go in its own `package.json` (`dependencies`), and the folder goes in the `workspaces` of the root `package.json` so that `npm install` makes them available to the tests: an installed extension doesn't see DevDock's packages. They are installed with `--ignore-scripts`, so packages that need to compile native code at install time can't be used.
3. `npm run catalog` and commit `index.json` (the CI fails when it is out of date).

## Release

```bash
npm run release <code> <patch|minor|major>        # e.g. npm run release pm2 minor
git push origin HEAD <code>@<version>             # or add --push to the command above
```

The script refuses to run with uncommitted changes or an empty `[Unreleased]` section; it bumps the version in `setting.json` (and `package.json`), turns `[Unreleased]` into the new version in `CHANGELOG.md`, regenerates `index.json`, commits and creates the annotated tag `<code>@<version>`.
