# Changelog

All notable, user-facing changes to Pi Jev Helm are documented here. Entries
summarize what changed for users — not individual commits — and every version
that changes behavior includes upgrade or migration notes.

Pi Jev Helm is distributed as a Pi Git package from immutable GitHub tags (see
[ADR 0001](docs/adr/0001-release-public-preview-from-git-tags.md)). Install
commands always reference a `v*` tag; published tags are never moved or
deleted. A defective release is superseded by a new patch tag.

## [Unreleased]

Nothing yet.

## [0.2.0] — Public Preview (unreleased)

Adds a second path to Jev: the Classification Provider Selection chooses
between the OpenRouter Jev Client (the default, unchanged behavior) and the
new TypeSafe Jev Client, with an explicit session-scoped override command and
per-client attribution.

### Added

- Classification Provider Selection: a new optional flat `classificationProvider`
  field in `pi-jev-helm.json` chooses the Jev Client through which Task
  Classification runs — `openrouter` (the default, today's behavior) or
  `typesafe`. Unknown values are rejected by configuration parsing with the
  field and its allowed values, and a selection whose credential is missing
  leaves Automatic Routing unavailable instead of substituting the other Jev
  Client; explicit Route Overrides keep working
  ([ADR 0002](docs/adr/0002-explicit-classification-provider-selection.md)).
- TypeSafe Jev Client: reaches Jev through TypeSafe's official service
  (`api.typesafe.ai/v1/systemone`) via the official `@typesafe-ai/sdk`, with
  the classification model pinned to `jev-1.13.0` (aliases are never
  requested or trusted) and the SDK confined to a single attempt inside the
  shared 2500 ms classification deadline with abort pass-through
  ([ADR 0003](docs/adr/0003-one-classification-provider-jev-client-seam.md)).
  It authenticates through Pi's own credential system (`/login` or
  `TYPESAFE_API_KEY`); the registered `typesafe` provider entry is auth-only
  and never appears as a chat-model provider for Route Targets.
- Session Classification Provider Override: `/helm client
  openrouter|typesafe|clear` supersedes the configured selection for the
  current session without writing configuration. It resets on every session
  start (`/reload`, new, resume, fork, exit), rejects a selection whose
  credential cannot be resolved, and `clear` is always allowed (warning when
  the configured selection lacks a credential). The interactive TUI footer
  prefixes every healthy-configuration state with the effective Jev Client's
  human label (`OpenRouter · auto`, `TypeSafe · classifying`,
  `TypeSafe · fail-open (provider-unavailable)`, …); `config error` stays
  unprefixed and machine-readable modes stay silent.
- Routing Explanations record the Jev Client that served each automatic
  attempt (or whose absence caused a fail-open), shown by `/helm why`.
- The real Jev compatibility gate certifies each Jev Client as its own leg:
  the same `classification-v1` corpus, three independent executions per
  message, and the per-message two-of-three rule per leg, each leg running
  only when its own credential (`OPENROUTER_API_KEY` / `TYPESAFE_API_KEY`)
  is present and reported as explicitly skipped otherwise.

### Changed

- Certified Pi `0.86.0` while retaining Pi `0.85.1` as the minimum supported
  version. The Pi compatibility matrix now runs typecheck, build, and the
  complete deterministic test suite against both the pinned minimum and the
  newest stable Pi, and rejects incomplete or mismatched cached Pi package
  pairs.

### Upgrade and migration notes

- No action is required. `classificationProvider` is optional and defaults to
  `openrouter`, so existing configurations keep working verbatim and
  Automatic Routing behavior is unchanged unless you opt in. To opt in, set
  `"classificationProvider": "typesafe"` and authenticate the `typesafe`
  provider through Pi (`/login` or the `TYPESAFE_API_KEY` environment
  variable). No Pi `0.86.0` runtime API migration was needed.

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

[Unreleased]: https://github.com/Z761293629/pi-jev-helm/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/Z761293629/pi-jev-helm/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Z761293629/pi-jev-helm/releases/tag/v0.1.0
