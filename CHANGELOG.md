# Changelog

All notable, user-facing changes to Pi Jev Helm are documented here. Entries
summarize what changed for users — not individual commits — and every version
that changes behavior includes upgrade or migration notes.

Pi Jev Helm is distributed as a Pi Git package from immutable GitHub tags (see
[ADR 0001](docs/adr/0001-release-public-preview-from-git-tags.md)). Install
commands always reference a `v*` tag; published tags are never moved or
deleted. A defective release is superseded by a new patch tag.

## [0.1.0] — Public Preview (2026-09-19)

First externally installable release. Pre-stable by definition: support is
best-effort, and the next minor version may change the contract.

### Added

- Pi extension that classifies each new Routed Run with three Capability
  Signals (`codeWork`, `deepReasoning`, `externalResearch`) through the
  OpenRouter Jev Classification Provider (fixed model `typesafe/jev-1.13`),
  and applies a deterministic Routing Policy over the four Routes `fast`,
  `coding`, `reasoning`, and `research`.
- User-level configuration file `pi-jev-helm.json` (schema version 1) with one
  exact Route Target per Route, `automaticRouting` (default `true`), and
  `confidenceThreshold` (default `0.75`).
- One-shot Route Overrides (`/helm route …`) and session-scoped Automatic
  Routing control (`/helm auto on|off`), both resolving their configured Route
  Target exactly and restoring the Baseline Model after the Routed Run
  settles.
- Explicit user model and thinking-level choices made during a Routed Run win
  immediately and update what is restored.
- Recoverable, non-context Baseline checkpoints with restoration across
  settlement and ordinary Pi lifecycle transitions (reload, session
  replacement, fork, exit).
- Branch-aware Routing Explanations recorded as non-context session entries
  and shown by `/helm why`; `/helm` reports configuration health and current
  routing state; a single footer slot mirrors live status in the interactive
  TUI.
- Fail-open behavior everywhere: classification failure, low confidence,
  unavailable Route Targets, and failed model switches keep or restore the
  Baseline Model so the original request continues.
- Credential-free starter configuration template validated by the production
  configuration loader in CI ([`examples/pi-jev-helm.json`](examples/pi-jev-helm.json)).
- Executable compatibility evidence: deterministic default suite on Node.js
  `22.19.0` and `24`, and a Pi public-API lifecycle matrix covering Pi
  `0.85.1` (minimum certified) through the newest stable Pi at certification
  time (`npm run test:pi-matrix`). Default CI requires no credentials and
  performs no paid requests.

### Upgrade and migration notes

- This is the initial release; there is nothing to migrate from. Follow
  [the README install and configuration sections](README.md#install).
- Automatic Routing sends the current user message, unmodified, to OpenRouter
  for classification. Read [Data, cost, and control](README.md#data-cost-and-control)
  before enabling it, and use `/helm auto off` to keep the extension loaded
  without automatic classification.
- Route Targets are resolved exactly against Pi's model registry. Copy
  provider and model identities from `pi --list-models` or `/model`; no fuzzy
  matching exists.

## Versioning policy

- Within one minor release line (currently `0.1.x`), patch releases preserve
  the user-facing configuration schema (`pi-jev-helm.json`, `schemaVersion 1`)
  and the `/helm` command grammar. Upgrading a patch release never requires
  configuration or workflow changes.
- Breaking changes to the configuration schema, command grammar, or documented
  behavior require a new minor version (for example `0.2.0`) and migration
  notes in this changelog.
- Public `v*` tags are immutable. A failed release is superseded by a new
  patch tag, never by moving an existing one; see the
  [tag policy](docs/tag-policy.md).

[0.1.0]: https://github.com/Z761293629/pi-jev-helm/releases/tag/v0.1.0
