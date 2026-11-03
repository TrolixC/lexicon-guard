# Changelog

All notable changes to this project are documented here. This project follows [Semantic Versioning](https://semver.org).

## [1.0.0] - 2026-11-03

First public release.

### Added

- `guard.js`: zero-dependency CLI for Node 18+. Scans files and folders line by line against a JSON lexicon of case-insensitive regex rules.
- Several paths per run (files and folders mixed), as a pre-commit hook passes them. Duplicates are scanned once.
- Path-based classification: top-level `internalPaths` regexes mark files internal; everything else is client-facing. Rule scopes `all`, `client`, `internal`.
- `--scope client|internal` to classify every file one way regardless of path.
- `quotable` rules skip hits inside double quotes (straight or curly) and markdown blockquotes.
- One hit per rule per line.
- `--lexicon` (default `./lexicon.json`), `--json`, `--quiet`, `--help`, `--version`.
- Exit codes: 0 clean or warnings only, 1 blocker, 2 bad usage (unknown flag, missing path, unreadable lexicon, invalid rule or regex), 3 nothing to gate (no eligible file, or every file empty).
- Strict lexicon validation: required fields, unique ids, valid severities and scopes, compilable regexes, and no pattern that matches empty text.
- `lexicon.example.json` and fictional Acme fixtures in `examples/docs/` that fire every example rule.
- `.pre-commit-hooks.yaml` (hook id `lexicon-guard`), `node --test` suite, CI on Node 18, 20 and 22.
