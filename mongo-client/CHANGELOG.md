# Changelog

All notable changes to the `mongo-client` extension. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/); releases are tagged `mongo-client@<version>`.

## [Unreleased]

## [1.0.0] - 2026-10-24

### Added
- MongoDB connections (section `mongoConnections`): host and port, connection string (`mongodb://`, `mongodb+srv://`) or an SSH tunnel of the Tunnels extension; user, authentication database, default database, TLS, read-only. Passwords are encrypted with the DevDock master password (core vault) and never stored in the URI.
- Sidebar tree connection ▸ database ▸ collections with sizes and estimated counts; context menus to test, refresh, edit and delete connections, open, export and drop collections.
- Document browser: filter, sort and projection as Extended JSON, page size and pages, total count, documents shown in mongosh syntax (`ObjectId(…)`, `ISODate(…)`, `NumberLong(…)`), copy as JSON.
- Changes always confirmed: insert one or many documents, replace a document, delete the selected documents, drop a collection (typing its name). The server shows the exact operation and runs it only with the confirmation token bound to it; read-only connections refuse every change.
- 64-bit integers keep all their digits and stay `Long` after an edit.
- Export of a collection or of the filtered documents as a JSON array (streamed, up to 100,000 documents); index list.
- MCP tools (read-only, vault unlocked from the UI): `mongo_client_connections`, `mongo_client_databases`, `mongo_client_collections`, `mongo_client_find`, `mongo_client_count`.
- Export/Import checkbox "MongoDB connections" (connections and the vault).
