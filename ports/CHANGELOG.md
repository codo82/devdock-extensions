# Changelog

All notable changes to the `ports` extension. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/); releases are tagged `ports@<version>`.

## [Unreleased]

## [1.0.0] - 2026-10-24

### Changed
- Moved out of DevDock, where it was a built-in extension up to 1.23: same features (listening TCP ports with their process, links to npm scripts, PM2 processes and SSH tunnels, stop and force stop, MCP tool `ports_list`).
- Requires DevDock 2.0 or later (`"devdock": "^2.0"`); install it from the DevDock Extensions panel (🧩) or with `npm run ext -- install ports`.
