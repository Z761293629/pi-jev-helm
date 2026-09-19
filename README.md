# Pi Jev Helm

[![CI](https://github.com/Z761293629/pi-jev-helm/actions/workflows/ci.yml/badge.svg)](https://github.com/Z761293629/pi-jev-helm/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Z761293629/pi-jev-helm?include_prereleases&label=release&sort=semver)](https://github.com/Z761293629/pi-jev-helm/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> [!WARNING]
> **Pi Jev Helm is a Public Preview: pre-stable software with best-effort
> support and no response-time commitment.** When Automatic Routing is on,
> every new unit of work sends your current message — unmodified — to
> OpenRouter as a paid classification request. Read
> [Data, cost, and control](#data-cost-and-control) before enabling it, and
> see [Public Preview status](#public-preview-status) for what the preview
> contract does and does not promise.

Pi Jev Helm is a [Pi](https://github.com/badlogic/pi-mono) extension that uses
OpenRouter Jev judgments to classify a new unit of work and temporarily select
an appropriate Pi model. It reduces manual model switching without taking
control away from the user: routing is explicit, configurable, inspectable,
and fail-open. If classification or model switching fails, Pi continues with
your existing **Baseline Model**.

## Public Preview status

`v0.1.0` is an externally installable but pre-stable release. Within the
`0.1.x` line, patch releases preserve the user-facing configuration schema and
the `/helm` command grammar; breaking changes require a new minor version plus
migration notes in the [changelog](CHANGELOG.md). Published `v*` tags are
immutable — an installed tag always resolves to the same source
([tag policy](docs/tag-policy.md)).

The preview is feature-complete for its scope: the loadable extension, strict
V1 configuration, automatic Jev Task Classification, deterministic Routing
Policy, one-shot Route Override lifecycle, explicit user override precedence,
recoverable Baseline checkpoints, branch-aware Routing Explanations, live
footer status, the real Jev compatibility gate, and the cross-version Pi
public-API lifecycle certification are implemented. A future Safety Gate and
Verifier are *separate, uncommitted exploration directions* (see the V1
specification, [issue #12](https://github.com/Z761293629/pi-jev-helm/issues/12));
they are not part of this release and may never ship.

Support is best-effort. Security reports go through
[Private Vulnerability Reporting](SECURITY.md); bugs and feature requests
through the repository issue forms.

## Requirements and verified platforms

| Requirement | Evidence |
| --- | --- |
| Pi `0.85.1` or newer | Minimum certified version, pinned as the exact dev dependency and exercised by the executable Pi matrix (`npm run test:pi-matrix`). At certification time the newest stable Pi was also `0.85.1`, so certification evidence covers Pi `0.85.1`. |
| Node.js `22.19.0` or newer (the runtime Pi itself runs on) | Declared in `package.json` `engines`; default CI runs typecheck, build, and the full deterministic suite on exactly `22.19.0` and current Node.js `24`. |
| An OpenRouter credential, only for Automatic Routing | Supplied by Pi (`/login` or `OPENROUTER_API_KEY`), never by Helm's configuration. Not needed while Automatic Routing is off. |
| Models you can access for each Route | Any providers Pi supports. Helm resolves Route Targets exactly against Pi's model registry — no substitution, no fallback. |

Platform status:

- **Linux — verified.** Default CI (deterministic suite and Pi compatibility
  matrix) runs on Ubuntu.
- **macOS — verified.** The real Jev compatibility gate certification (24/24
  corpus messages) and the manual end-to-end acceptance runs were performed on
  macOS.
- **Windows — unverified, best-effort.** Helm uses only Pi public APIs
  (including `getAgentDir()` for all paths) and has no known deliberate
  platform coupling, but there is no Windows CI, certification, or acceptance
  evidence. Windows reports through the issue forms are welcome.

Two boundaries to know before installing:

- **Lifecycle limits.** A forced process termination that prevents the
  Baseline checkpoint from being written durably (`SIGKILL`, power loss,
  unavailable session storage) cannot be guaranteed recoverable; Helm refuses
  to apply a Route Target when the initial checkpoint write fails. See
  [Lifecycle recovery](#lifecycle-recovery).
- **No product telemetry.** The extension makes exactly one kind of outbound
  network request — the classification request described under
  [Data, cost, and control](#data-cost-and-control) — and adds no telemetry of
  its own.

## Install

Pi packages run with full system access. Review the source (it is small) or
pin an exact tag you have reviewed before installing.

### Recommended: pinned `v0.1.0`, user-level

```bash
pi install git:github.com/Z761293629/pi-jev-helm@v0.1.0
```

This is Pi's supported Git package syntax with an immutable version tag. The
install is user-level: it writes to `~/.pi/agent/settings.json` and clones the
tagged source under `~/.pi/agent/git/github.com/Z761293629/pi-jev-helm`, so
Helm loads in every project. Project-local installation is not a supported
preview path because Helm's configuration is user-level.

Verify the installation: `pi list` shows the package, and starting `pi` makes
`/helm` available. Before you configure it, `/helm` reports an unhealthy
configuration — that is the expected first-run state.

To try Helm without installing it, use Pi's temporary extension flag:

```bash
pi -e git:github.com/Z761293629/pi-jev-helm@v0.1.0
```

### Following `main` (unstable tester path)

```bash
pi install git:github.com/Z761293629/pi-jev-helm@main
```

`main` moves constantly, contains unreleased changes, and is **not** covered
by the `0.1.x` compatibility contract. Use it only if you want to test
unreleased work and accept breakage. Do not use `@main` where you need a
reproducible setup; that is what the pinned tag is for.

## Configure

1. **Find your configuration path.** Run `/helm` in Pi and read the
   `Configuration file:` line — always treat that reported path as
   authoritative, because it reflects Pi's actual agent directory (default:
   `~/.pi/agent/pi-jev-helm.json`, different when Pi's agent-dir override is
   set). Helm reads the file at session startup and `/reload`; it does not
   watch it.

2. **Start from the validated template.** Copy
   [`examples/pi-jev-helm.json`](examples/pi-jev-helm.json) to the reported
   path. CI loads this exact file through the production configuration
   loader, so a copy-paste of it cannot fail on schema drift:

   ```json
   {
     "schemaVersion": 1,
     "automaticRouting": true,
     "confidenceThreshold": 0.75,
     "routes": {
       "fast": {
         "provider": "your-fast-provider",
         "model": "your-fast-model",
         "thinkingLevel": "off"
       },
       "coding": {
         "provider": "your-coding-provider",
         "model": "your-coding-model",
         "thinkingLevel": "high"
       },
       "reasoning": {
         "provider": "your-reasoning-provider",
         "model": "your-reasoning-model",
         "thinkingLevel": "high"
       },
       "research": {
         "provider": "your-research-provider",
         "model": "your-research-model",
         "thinkingLevel": "medium"
       }
     }
   }
   ```

3. **Replace every placeholder with an exact Pi identity.** Discover the
   precise provider and model identities your Pi installation offers with:

   ```bash
   pi --list-models        # provider and model columns
   ```

   or the `/model` picker inside an interactive Pi session. Both display the
   same identities the config expects. `provider` and `model` in each Route
   Target must match Pi's model registry exactly — Helm has no fuzzy model
   matching, nearest-model substitution, or cross-Route fallback, and an
   unresolvable target fails that run open to your Baseline Model.

4. **Reload.** Run `/reload` (or restart Pi), then `/helm` again: it should
   now report `Configuration: healthy` plus the configured and
   session-effective Automatic Routing state, pending Route Override, current
   or recent Route, and Baseline Model.

Field reference: `automaticRouting` defaults to `true`; `confidenceThreshold`
defaults to `0.75` and must be a finite number in `[0,1]`; every standard
Route (`fast`, `coding`, `reasoning`, `research`) requires exactly one
complete Route Target; `thinkingLevel` is one of `off`, `minimal`, `low`,
`medium`, `high`, `xhigh`, `max`. Invalid configuration disables Automatic
Routing, raises an error notification in the interactive TUI, and leaves
ordinary Pi requests fully operational.

### Reference combination used by the acceptance suite

The executable Pi public-API lifecycle suite that certifies Helm drives this
exact Route Target combination, resolved against the registry like any user
configuration (from `test/pi-harness.ts`):

| Route | Provider | Model | `thinkingLevel` |
| --- | --- | --- | --- |
| `fast` | `helm-fast` | `fast-model` | `off` |
| `coding` | `helm-coding` | `coding-model` | `high` |
| `reasoning` | `helm-reasoning` | `reasoning-model` | `medium` |
| `research` | `helm-research` | `research-model` | `low` |

This is a **proven reference, not a default and not an availability promise**.
Those identities exist inside the test harness; nothing about them is
recommended, and no provider or model listed there (or anywhere in this
repository) is promised to be available to you. Choose identities from your
own `pi --list-models` output that your accounts can actually access.

## Data, cost, and control

Read this section **before** enabling Automatic Routing. It sits next to the
switch on purpose.

- **Your message leaves the machine.** With Automatic Routing on, each new
  Routed Run sends your current user message, **unmodified**, to OpenRouter's
  Decisions endpoint (`openrouter.ai`) for classification by the fixed model
  `typesafe/jev-1.13`. Helm adds exactly one such attempt per new Routed Run
  (2500 ms budget, no retries); it never sends conversation history, session
  entries, or file contents.
- **Zero-data retention has limits.** Every classification request asks
  OpenRouter for zero-data-retention routing (`zdr: true`). ZDR constrains
  what the receiving service retains or logs; it does **not** mean no data is
  transmitted. Your message still leaves your machine and passes through
  OpenRouter and its upstream provider. Treat ZDR as a retention control, not
  an air gap.
- **Classification is a paid request.** It is billed against the OpenRouter
  account behind Pi's credential, like any OpenRouter usage — small per run,
  but real and recurring. (The maintainer-only real Jev compatibility gate is
  a separate, much larger paid workload and never runs during normal use.)
- **To disable:** run `/helm auto off` in Pi, or set `"automaticRouting":
  false` in the configuration file to default to off. With Automatic Routing
  off, Helm sends nothing anywhere; one-shot Route Overrides (`/helm route …`)
  keep working and also perform no classification, because they bypass it.
- **Credentials stay in Pi.** The Helm configuration file has no credential
  fields, and Helm never reads keys from it. The OpenRouter credential comes
  exclusively through Pi's own facilities — `/login`, Pi's CLI/API key
  options, or the `OPENROUTER_API_KEY` environment variable. Never put API
  keys in `pi-jev-helm.json`.

## Upgrade

**Pinned tag** (`…@v0.1.0`): `pi update --extensions` and `pi update --all`
reconcile the clone to the same configured tag. Because published tags are
immutable, an update can never silently move you to a different source or a
newer version. Upgrading is a deliberate step — check
[CHANGELOG.md](CHANGELOG.md) first, then point the install at the new tag:

```bash
pi install git:github.com/Z761293629/pi-jev-helm@v0.1.1
```

Patch releases in `0.1.x` preserve the configuration schema and command
grammar, so a patch upgrade never requires config or workflow changes.

**`main`** (`…@main`): `pi update --extensions` / `pi update --all` fetch and
fast-forward the clone to the current `main`. You move with every upstream
commit — that is the point of the tester path and also its risk. Re-running
the install command with `@main` re-pins today's head explicitly.

Configuration files and checkpoints survive upgrades; they are user state,
not package state.

## Uninstall

```bash
pi remove git:github.com/Z761293629/pi-jev-helm
```

(`pi uninstall` is an alias.) This removes the settings entry and the cloned
package. **By default your configuration is preserved**: the
`pi-jev-helm.json` file at the path `/helm` reported stays on disk, so a
reinstall later restores your setup unchanged.

Optional complete cleanup:

1. Remove the extension as above.
2. Delete the configuration file — use the exact path `/helm` reported;
   default installations use:

   ```bash
   rm ~/.pi/agent/pi-jev-helm.json
   ```

   Adjust the path if Pi's agent directory is overridden on your machine.

Past routing records (branch-aware Routing Explanation entries) remain inside
existing Pi session files. They are inert without the extension, were never
part of model context, and disappear with the sessions they live in.

## How V1 works

For each new **Routed Run** started while Pi is idle, Helm:

1. Sends the current user message to the OpenRouter Jev **Classification Provider**.
2. Produces a versioned **Task Classification** with three independent **Capability Signals**:
   - `codeWork`
   - `deepReasoning`
   - `externalResearch`
3. Applies a deterministic **Routing Policy**:
   - external research → `research`
   - otherwise code work → `coding`
   - otherwise deep reasoning → `reasoning`
   - otherwise → `fast`
4. Resolves the selected Route to its configured **Route Target**: an exact Pi provider, model, and thinking level.
5. Persists a recoverable, non-context checkpoint containing the Baseline Model and thinking level before changing either value.
6. Uses the target for the complete Routed Run, including tools, retries, and queued continuations.
7. Restores the latest Baseline after the run settles and marks the checkpoint complete only after restoration succeeds.

A low-confidence classification, Provider failure, unavailable Route Target,
or failed model transition keeps or restores the Baseline Model so the
original request can continue.

## User control

- Automatic Routing that can be disabled for the current extension instance (`/helm auto off`).
- A one-shot Route Override for the next Routed Run (`/helm route fast|coding|reasoning|research|clear`).
- Immediate precedence for direct user model or thinking-level changes.
- A concise footer status and branch-aware routing records.
- `/helm why` for a structured **Routing Explanation** without copied prompts or invented chain of thought.
- `/helm` for configuration health, configured and session-effective Automatic Routing, the pending Route Override, the current or recent Route, and the Baseline Model.
- Silent operation in print, JSON, RPC, and other machine-readable modes.

V1 command grammar:

```text
/helm
/helm auto on|off
/helm route fast|coding|reasoning|research|clear
/helm why
```

Automatic Routing and overrides resolve their configured Route Target exactly,
apply it before the first Turn, keep it for the full Routed Run, and restore
the Baseline Model after settlement. Overrides remain available while
Automatic Routing is off and are consumed even when target resolution or
application fails. Classification uses one total 2500 ms attempt, validates
the complete success contract, and maps cancellation, transport, HTTP,
timeout, and protocol failures to safe typed outcomes before failing open.

Every real routing attempt writes a compact, branch-aware, non-context
session entry: automatic success or fail-open, Route Override success or
failure, and post-selection explicit overrides. Each entry records the
applicable Capability Signals with their confidence, the decision-relevant
confidence checks, the policy branch, the Route, the Route Target, the
Baseline, the actually applied model, override events, the fail-open reason,
and the restoration outcome. It never copies the user message, exposes chain
of thought, invents a Jev rationale, or includes unsafe provider details.
`/helm why` shows the current run's explanation when available, otherwise the
most recent applicable explanation on the active conversation branch, as a
read-only informational result without duplicating the session entry.

In the interactive TUI, one Helm footer status slot mirrors the live state:
idle Automatic Routing on/off, a pending Route Override, classification in
progress, the active Route and its Route Target, an Explicit Model Override,
or a fail-open, configuration-error, or restoration outcome. After
restoration the slot returns to the current idle or pending state instead of
permanently displaying the previous result. Invalid configuration raises an
error notification; Provider, protocol, Route Target, and model-switch
failures raise warnings; low-confidence fail-open is visible in the footer and
Routing Explanation without a popup; successful routing and restoration stay
silent. Print, JSON, RPC, and other non-interactive modes keep routing and
session-entry behavior but add no Helm text to stdout or stderr.

## Lifecycle recovery

Baseline checkpoints are versioned custom session entries and never enter
model context. Helm updates the pending checkpoint when an Explicit Model
Override or Explicit Thinking Override changes the Baseline. It attempts
restoration on settlement and every graceful Pi teardown path (`reload`,
session replacement, fork, and normal exit). When the same session or branch
starts again, Helm restores its latest incomplete checkpoint before doing new
routing work. A failed restoration remains explicitly incomplete and is
retried instead of being recorded as successful.

Recovery is limited by Pi's public extension lifecycle and session
persistence APIs. A forced process termination that prevents the checkpoint
entry from being written durably (for example `SIGKILL`, power loss, or
unavailable session storage) cannot be guaranteed recoverable. Helm therefore
refuses to apply a Route Target when the initial checkpoint write fails.
Checkpoints are session-branch state; a different new session cannot read an
interrupted session's entries, but it also starts from Pi's normal model
selection rather than inheriting that session's temporary Route Target. If a
stored Baseline model can no longer be resolved or authenticated, Helm
records restoration failure, skips new routing attempts, and intercepts idle
input before agent startup so work cannot continue on the temporary Route
Target. Later input retries recovery; an Explicit Model Override can repair
the checkpoint when the stored model is no longer available.

## Compatibility

V1 uses only Pi's public extension APIs and is certified against an
executable matrix:

- **Minimum supported Pi version:** `0.85.1`, pinned as the exact dev
  dependency `@earendil-works/pi-coding-agent@0.85.1`; this pin is the single
  minimum-version source for the matrix.
- **Newest version intentionally supported:** the newest stable Pi version at
  certification time, discovered by the matrix script itself
  (`npm view @earendil-works/pi-coding-agent dist-tags.latest`). At
  certification this is also `0.85.1`, so certification evidence currently
  covers Pi `0.85.1`.
- **Package contract:** per Pi package guidance,
  `@earendil-works/pi-coding-agent` is declared as a wildcard (`"*"`) peer
  dependency, so an installed Git package always uses the Pi installation
  supplied by its host. The peer range encodes no compatibility policy; the
  certification evidence above is the support statement.
- The matrix lives in `scripts/test-pi-matrix.mjs` and runs the same
  public-API black-box suite (`test/pi-black-box.test.ts`) against every
  distinct version in `{minimum, newest stable}`, driving the real in-process
  Pi SDK: extension loading, session lifecycle, model registry, session tree,
  and footer UI seams, with scripted in-process fake providers. Rerun it when
  a new Pi version is released; a failure means public lifecycle semantics
  diverged and the declared support range must be narrowed (or the extension
  adapted) rather than reaching for Pi internals.
- Matrix installs are cached under `.pi-matrix/` (git-ignored);
  `PI_MATRIX_SKIP_INSTALL=1` reuses them.

### Verification tiers

The repository separates three verification tiers; only the first runs by
default.

1. **Deterministic default CI** — `npm test`, run with typecheck and build by
   [`.github/workflows/ci.yml`](.github/workflows/ci.yml) on both declared
   Node.js runtimes: the exact minimum `22.19.0` and current Node.js `24`.
   Schema, configuration, Classification Provider contract, Routing Policy,
   command/state, privacy, and Routed Run lifecycle tests include the Pi
   public-API black-box suite with in-process fake models. No external
   credentials, network, or paid calls are required; the workflow reads no
   secret and never references `OPENROUTER_API_KEY`.
2. **Pi compatibility matrix** — `npm run test:pi-matrix`, also run as a
   dedicated default-CI job on Node.js `24`. It discovers the newest stable
   Pi version from npm at run time, installs it plus the pinned minimum into
   isolated directories, swaps them in one at a time, and re-runs the
   black-box lifecycle suite against each. See [Compatibility](#compatibility).
3. **Real Jev compatibility gate** —
   `OPENROUTER_API_KEY=... npm run test:real-jev-gate`. Credentialed, paid,
   probabilistic; excluded from default CI by construction and run explicitly.
   At certification the gate passed all 24 corpus messages.

The versioned `classification-v1` corpus (24 canonical messages in
`src/classification-corpus.ts`) is protected by deterministic tests that run
in default CI. The real OpenRouter/Jev compatibility gate reclassifies every
corpus message against the live service with fixed model `typesafe/jev-1.13`,
confidence threshold `0.75`, three independent executions per message, and a
per-message two-of-three pass rule. It performs paid external requests, is
never run by default CI or `npm test`, and fails clearly when credentials are
missing. Run the gate before a release and whenever validating a Jev model or
classification-template change; any substantive change to the
`classification-v1` template requires a new template version plus a complete
corpus rerun.

## Design principles

- **Classification and routing are separate.** Jev describes required capabilities; deterministic policy selects the Route.
- **The user remains authoritative.** Explicit model and thinking-level choices supersede Helm.
- **Routing is scoped.** A Route Target applies only to its Routed Run and must not contaminate the next independent request.
- **Failure is non-blocking.** Routing failures do not prevent Pi from handling the request.
- **Configuration is exact.** There is no fuzzy model matching, nearest-model substitution, or cross-Route fallback.
- **Diagnostics are privacy-conscious.** API keys, user messages, raw requests, raw responses, and upstream error text are excluded from records and failures.
- **Only public Pi extension APIs are used.** V1 targets Pi 0.85.1 and the newest version proven compatible by the lifecycle test suite.

## Architecture

V1 keeps four responsibilities separate:

```text
Current user message
        │
        ▼
Classification Provider ──► Task Classification
                                   │
                                   ▼
                            Routing Policy
                                   │
                                   ▼
                              Route Target
                                   │
                                   ▼
                       Routed Run orchestration
                                   │
                                   ▼
                  status and Routing Explanation
```

The Classification Provider hides OpenRouter/Jev protocol details. Routing
Policy handles confidence and Route selection. Routed Run orchestration
applies and restores Pi model state. Presentation exposes controls and
factual explanations.

## Testing strategy

V1 uses three evidence layers:

1. Deterministic schema, policy, configuration, command, privacy, and Provider contract tests, including the versioned `classification-v1` corpus (24 messages: every Boolean Capability Signal combination twice plus the semantic boundaries — verbosity is not Deep Reasoning, software discussion is not Code Work, local repository exploration is not External Research, ambiguous prompts fail open on low confidence).
2. Black-box Pi public-extension-API tests with in-process fake models (`test/pi-black-box.test.ts`, driven by `test/pi-harness.ts` through the real in-process Pi SDK). The suite covers all four Routes, Automatic Routing bypass, one-shot Route Override set/replace/clear/consumption (including while Automatic Routing is off), every fail-open path (Provider unavailable, classification failure, low confidence, unavailable or unappliable Route Target), Explicit Model and Thinking Overrides, the pre-application race, queued `steer` and `followUp` continuations, restoration, next-run isolation, branch-aware entries with `/helm why`, lifecycle recovery from an incomplete checkpoint, session replacement through Pi's `AgentSessionRuntime`, footer smoke states, and silence in print, JSON, and RPC modes — asserted through behavior and state tokens, never full-text snapshots.
3. An explicitly invoked, credentialed real OpenRouter/Jev compatibility gate (`npm run test:real-jev-gate`), evaluated per message with a two-of-three rule so no aggregate pass rate can hide a consistently failing example.

External probabilistic calls are excluded from default CI. The deterministic
suite is certified on Node.js `22.19.0` (declared minimum) and `24` by the CI
matrix, and the black-box lifecycle suite is certified against the minimum
and newest supported Pi versions by the executable matrix
(`npm run test:pi-matrix`, see [Compatibility](#compatibility)).

## Development

Pi 0.85.1 and Node.js 22.19.0 or newer are required.

```bash
npm ci
npm run typecheck
npm run build
npm test
```

To load a development checkout directly instead of installing the package:

```bash
pi -e ./src/index.ts
```

## License and versioning

Pi Jev Helm is released under the [MIT License](LICENSE). User-facing changes
are summarized in [CHANGELOG.md](CHANGELOG.md); within `0.1.x`, patches
preserve the configuration schema and command grammar, and breaking changes
require a new minor version with migration notes. Distribution uses immutable
Git tags only — see the [tag policy](docs/tag-policy.md) and
[ADR 0001](docs/adr/0001-release-public-preview-from-git-tags.md).

## Project documentation

- [`CONTEXT.md`](CONTEXT.md) — canonical domain vocabulary.
- [`CHANGELOG.md`](CHANGELOG.md) — user-facing change summaries and migration notes.
- [`SECURITY.md`](SECURITY.md) — supported preview versions, vulnerability reporting, evidence hygiene.
- [`docs/tag-policy.md`](docs/tag-policy.md) — public tag immutability and its enforcement.
- [V1 specification and parent issue](https://github.com/Z761293629/pi-jev-helm/issues/12).
- [Decision map and completed research tickets](https://github.com/Z761293629/pi-jev-helm/issues/1).
