# Changelog

All notable changes to the `notes` extension. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/); releases are tagged `notes@<version>`.

## [Unreleased]

## [1.0.0] - 2026-10-27

### Added
- **Boards**: one per project of Kelbo plus *General*, in the sidebar with the projects' folders and the number of open items; boards of projects removed from Kelbo are kept under *Removed projects*. The tab badge counts the open items of every board.
- **To-do lists**: several per board, each with a name (edited in place) and items to check; add with Enter, edit in place (Enter saves, Esc cancels), check/uncheck, delete, reorder by dragging (⋮⋮); done items go under the open ones, struck through with when they were done, and *Clear done* removes them; lists are moved before/after or deleted from their ⋯ menu.
- **Notes**: sticky notes in a grid, free text saved automatically a moment after the last keystroke, six colours, delete; a note changed elsewhere in the meantime is not overwritten.
- **Encrypted with the master password**: the content of each board (list names, items, notes) is one box encrypted by Kelbo's vault in `notesBoards`; with the vault locked the section shows only *Unlock* and every route answers `423`. Changing the master password re-encrypts it; resetting it deletes it. Export/Import checkbox *Note e to-do*, with the content still encrypted.
