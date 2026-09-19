# Pi Jev Helm

Pi Jev Helm is a planned [Pi](https://github.com/badlogic/pi-mono) extension that uses OpenRouter Jev judgments to classify a new unit of work and temporarily select an appropriate Pi model.

It is designed to reduce manual model switching without taking control away from the user. Routing is explicit, configurable, inspectable, and fail-open: if classification or model switching fails, Pi continues with the user's existing **Baseline Model**.

> **Status:** The loadable extension, strict V1 configuration, automatic Jev Task Classification, deterministic Routing Policy, one-shot Route Override lifecycle, explicit user override precedence, recoverable Baseline checkpoints, branch-aware Routing Explanations, live footer status, the real Jev compatibility gate, and the cross-version Pi public-API lifecycle certification are implemented. The black-box lifecycle suite passes on Pi 0.85.1 and the newest stable Pi version; see [Pi compatibility](#pi-compatibility).

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

A low-confidence classification, Provider failure, unavailable Route Target, or failed model transition keeps or restores the Baseline Model so the original request can continue.

## User control

V1 is intended to provide:

- Automatic Routing that can be disabled for the current extension instance.
- A one-shot Route Override for the next Routed Run.
- Immediate precedence for direct user model or thinking-level changes.
- A concise footer status and branch-aware routing records.
- `/helm why` for a structured **Routing Explanation** without copied prompts or invented chain of thought.
- Silent operation in print, JSON, RPC, and other machine-readable modes.

V1 command grammar:

```text
/helm
/helm auto on|off
/helm route fast|coding|reasoning|research|clear
/helm why
```

The current implementation includes configuration health, instance-local Automatic Routing control, automatic classification through OpenRouter's fixed `typesafe/jev-1.13` model, deterministic confidence-gated Route selection, and one-shot Route Overrides. Automatic Routing and overrides resolve their configured Route Target exactly, apply it before the first Turn, keep it for the full Routed Run, and restore the Baseline Model after settlement. Overrides remain available while Automatic Routing is off and are consumed even when target resolution or application fails. Classification uses one total 2500 ms attempt, validates the complete success contract, and maps cancellation, transport, HTTP, timeout, and protocol failures to safe typed outcomes before failing open.

Every real routing attempt writes a compact, branch-aware, non-context session entry: automatic success or fail-open, Route Override success or failure, and post-selection explicit overrides. Each entry records the applicable Capability Signals with their confidence, the decision-relevant confidence checks, the policy branch, the Route, the Route Target, the Baseline, the actually applied model, override events, the fail-open reason, and the restoration outcome. It never copies the user message, exposes chain of thought, invents a Jev rationale, or includes unsafe provider details. `/helm why` shows the current run's explanation when available, otherwise the most recent applicable explanation on the active conversation branch, as a read-only informational result without duplicating the session entry.

In the interactive TUI, one Helm footer status slot mirrors the live state: idle Automatic Routing on/off, a pending Route Override, classification in progress, the active Route and its Route Target, an Explicit Model Override, or a fail-open, configuration-error, or restoration outcome. After restoration the slot returns to the current idle or pending state instead of permanently displaying the previous result. Invalid configuration raises an error notification; Provider, protocol, Route Target, and model-switch failures raise warnings; low-confidence fail-open is visible in the footer and Routing Explanation without a popup; successful routing and restoration stay silent. Print, JSON, RPC, and other non-interactive modes keep routing and session-entry behavior but add no Helm text to stdout or stderr.

## Lifecycle recovery

Baseline checkpoints are versioned custom session entries and never enter model context. Helm updates the pending checkpoint when an Explicit Model Override or Explicit Thinking Override changes the Baseline. It attempts restoration on settlement and every graceful Pi teardown path (`reload`, session replacement, fork, and normal exit). When the same session or branch starts again, Helm restores its latest incomplete checkpoint before doing new routing work. A failed restoration remains explicitly incomplete and is retried instead of being recorded as successful.

Recovery is limited by Pi's public extension lifecycle and session persistence APIs. A forced process termination that prevents the checkpoint entry from being written durably (for example `SIGKILL`, power loss, or unavailable session storage) cannot be guaranteed recoverable. Helm therefore refuses to apply a Route Target when the initial checkpoint write fails. Checkpoints are session-branch state; a different new session cannot read an interrupted session's entries, but it also starts from Pi's normal model selection rather than inheriting that session's temporary Route Target. If a stored Baseline model can no longer be resolved or authenticated, Helm records restoration failure, skips new routing attempts, and intercepts idle input before agent startup so work cannot continue on the temporary Route Target. Later input retries recovery; an Explicit Model Override can repair the checkpoint when the stored model is no longer available.

## Configuration

Pi Jev Helm reads `pi-jev-helm.json` from the user directory returned by Pi's public `getAgentDir()` API; `/helm` reports this path as its `Configuration file` line. It reads the file at session startup and `/reload`; it does not watch the file or assume a home-directory path.

A credential-free starter template is checked in at [`examples/pi-jev-helm.json`](examples/pi-jev-helm.json). Copy it to the configuration path, then replace every `your-` provider and model placeholder with an identity you can access; every standard thinking level (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) is valid. The template is validated by the production configuration loader in CI, so a schema drift fails the build instead of first-time setup.

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

`automaticRouting` defaults to `true`; `confidenceThreshold` defaults to `0.75` and must be finite and within `[0,1]`. Every standard Route requires exactly one complete Route Target. Automatic classification uses the OpenRouter credential already configured in Pi (for example through `/login` or the `OPENROUTER_API_KEY` environment variable). Run `/helm` to inspect configuration health, configured and session-effective Automatic Routing, the pending Route Override, the current or recent Route, and the Baseline Model. Invalid configuration disables Automatic Routing, raises an error notification in the interactive TUI, and leaves ordinary Pi requests operational.

## Development

Pi 0.85.1 and Node.js 22.19.0 or newer are required; default CI certifies the exact minimum Node.js `22.19.0` and current Node.js `24`.

```bash
npm ci
npm run typecheck
npm run build
npm test
```

### Verification tiers

The repository separates three verification tiers; only the first runs by default.

1. **Deterministic default CI** — `npm test`, run with typecheck and build by [`.github/workflows/ci.yml`](.github/workflows/ci.yml) on both declared Node.js runtimes: the exact minimum `22.19.0` and current Node.js `24`. Schema, configuration, Classification Provider contract, Routing Policy, command/state, privacy, and Routed Run lifecycle tests include the Pi public-API black-box suite with in-process fake models. No external credentials, network, or paid calls are required; the workflow reads no secret and never references `OPENROUTER_API_KEY`.
2. **Pi compatibility matrix** — `npm run test:pi-matrix`, also run as a dedicated default-CI job on Node.js `24`. It discovers the newest stable Pi version from npm at run time, installs it plus the pinned minimum into isolated directories, swaps them in one at a time, and re-runs the black-box lifecycle suite against each. See [Pi compatibility](#pi-compatibility).
3. **Real Jev compatibility gate** — `OPENROUTER_API_KEY=... npm run test:real-jev-gate`. Credentialed, paid, probabilistic; excluded from default CI by construction and run explicitly.

### Pi compatibility

V1 uses only Pi's public extension APIs and is certified against an executable matrix:

- **Minimum supported Pi version:** `0.85.1`, pinned as the exact dev dependency `@earendil-works/pi-coding-agent@0.85.1`; this pin is the single minimum-version source for the matrix.
- **Newest version intentionally supported:** the newest stable Pi version at certification time, discovered by the matrix script itself (`npm view @earendil-works/pi-coding-agent dist-tags.latest`). At certification this is also `0.85.1`, so certification evidence currently covers Pi `0.85.1`.
- **Package contract:** per Pi package guidance, `@earendil-works/pi-coding-agent` is declared as a wildcard (`"*"`) peer dependency, so an installed Git package always uses the Pi installation supplied by its host. The peer range encodes no compatibility policy; the certification evidence above is the support statement.
- The matrix lives in `scripts/test-pi-matrix.mjs` and runs the same public-API black-box suite (`test/pi-black-box.test.ts`) against every distinct version in `{minimum, newest stable}`, driving the real in-process Pi SDK: extension loading, session lifecycle, model registry, session tree, and footer UI seams, with scripted in-process fake providers. Rerun it when a new Pi version is released; a failure means public lifecycle semantics diverged and the declared support range must be narrowed (or the extension adapted) rather than reaching for Pi internals.
- Matrix installs are cached under `.pi-matrix/` (git-ignored); `PI_MATRIX_SKIP_INSTALL=1` reuses them.

### Real Jev compatibility gate

The versioned `classification-v1` corpus (24 canonical messages in
`src/classification-corpus.ts`) is protected by deterministic tests that run in
default CI. The real OpenRouter/Jev compatibility gate reclassifies every
corpus message against the live service with fixed model `typesafe/jev-1.13`,
confidence threshold `0.75`, three independent executions per message, and a
per-message two-of-three pass rule. It performs paid external requests, is
never run by default CI or `npm test`, and fails clearly when credentials are
missing:

```bash
OPENROUTER_API_KEY=... npm run test:real-jev-gate
```

Run the gate before a release and whenever validating a Jev model or
classification-template change. Any substantive change to the
`classification-v1` template requires a new template version plus a complete
corpus rerun; the gate refuses to start otherwise.

Load the extension directly during development:

```bash
pi -e ./src/index.ts
```

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

The Classification Provider hides OpenRouter/Jev protocol details. Routing Policy handles confidence and Route selection. Routed Run orchestration applies and restores Pi model state. Presentation exposes controls and factual explanations.

## Roadmap

The original integration plan has been reduced to the following staged roadmap. Only the first three stages belong to Pi Jev Helm V1.

### 1. Validate and isolate the Jev contract

- Confirm the OpenRouter Decisions request and response contract.
- Fix the initial model to `typesafe/jev-1.13` and request zero-data-retention routing.
- Validate responses locally and represent external failures as safe typed results.
- Keep real Jev checks in an explicit compatibility gate rather than normal CI.

Research and protocol probes are complete; production implementation is tracked by the V1 child issues.

### 2. Implement Task Classification and Routing Policy

- Classify requests with the three versioned Capability Signals.
- Preserve every capability required by compound requests.
- Select `fast`, `coding`, `reasoning`, or `research` using fixed priority and decision-relevant confidence checks.
- Verify semantics with a versioned 24-message corpus.

The contract and acceptance criteria are complete; implementation remains pending.

### 3. Integrate Routed Runs with Pi

- Resolve exact Route Targets from user configuration.
- Apply a target before the first Turn and retain it through the complete Routed Run.
- Support Automatic Routing, one-shot Route Overrides, and explicit user overrides.
- Restore and recover the Baseline Model across settlement and ordinary lifecycle transitions.
- Add footer status, branch-aware Routing Explanations, deterministic tests, and Pi version compatibility checks.

This is the main V1 delivery stage. Work is decomposed under [issue #12](https://github.com/Z761293629/pi-jev-helm/issues/12).

### 4. Explore a Safety Gate after V1

A future, separately specified extension may evaluate sensitive tool operations and choose `allow`, `block`, or `ask`. Unlike model routing, uncertain dangerous operations would require conservative behavior. Tool authorization and dynamic permission decisions are intentionally outside V1.

### 5. Explore a Verifier after V1

A later, separately specified capability may evaluate completion evidence, test sufficiency, unresolved errors, and whether more work is required. Completion scoring and `pass`/`retry`/`escalate` behavior are intentionally outside V1.

## Testing strategy

V1 uses three evidence layers:

1. Deterministic schema, policy, configuration, command, privacy, and Provider contract tests, including the versioned `classification-v1` corpus (24 messages: every Boolean Capability Signal combination twice plus the semantic boundaries — verbosity is not Deep Reasoning, software discussion is not Code Work, local repository exploration is not External Research, ambiguous prompts fail open on low confidence).
2. Black-box Pi public-extension-API tests with in-process fake models (`test/pi-black-box.test.ts`, driven by `test/pi-harness.ts` through the real in-process Pi SDK). The suite covers all four Routes, Automatic Routing bypass, one-shot Route Override set/replace/clear/consumption (including while Automatic Routing is off), every fail-open path (Provider unavailable, classification failure, low confidence, unavailable or unappliable Route Target), Explicit Model and Thinking Overrides, the pre-application race, queued `steer` and `followUp` continuations, restoration, next-run isolation, branch-aware entries with `/helm why`, lifecycle recovery from an incomplete checkpoint, session replacement through Pi's `AgentSessionRuntime`, footer smoke states, and silence in print, JSON, and RPC modes — asserted through behavior and state tokens, never full-text snapshots.
3. An explicitly invoked, credentialed real OpenRouter/Jev compatibility gate (`npm run test:real-jev-gate`), evaluated per message with a two-of-three rule so no aggregate pass rate can hide a consistently failing example.

External probabilistic calls are excluded from default CI. The deterministic suite is certified on Node.js `22.19.0` (declared minimum) and `24` by the CI matrix, and the black-box lifecycle suite is certified against the minimum and newest supported Pi versions by the executable matrix (`npm run test:pi-matrix`, see [Pi compatibility](#pi-compatibility)).

## Project documentation

- [`CONTEXT.md`](CONTEXT.md) — canonical domain vocabulary.
- [V1 specification and parent issue](https://github.com/Z761293629/pi-jev-helm/issues/12).
- [Decision map and completed research tickets](https://github.com/Z761293629/pi-jev-helm/issues/1).
