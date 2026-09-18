# Pi Jev Helm

Pi Jev Helm is a planned [Pi](https://github.com/badlogic/pi-mono) extension that uses OpenRouter Jev judgments to classify a new unit of work and temporarily select an appropriate Pi model.

It is designed to reduce manual model switching without taking control away from the user. Routing is explicit, configurable, inspectable, and fail-open: if classification or model switching fails, Pi continues with the user's existing **Baseline Model**.

> **Status:** The loadable extension, strict V1 configuration, and one-shot Route Override lifecycle are implemented. Automatic Jev classification and the remaining Routed Run controls remain under development in the child issues of [the V1 specification](https://github.com/Z761293629/pi-jev-helm/issues/12).

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
5. Uses that target for the complete Routed Run, including tools, retries, and queued continuations.
6. Restores the Baseline Model and thinking level after the run settles.

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

The current implementation includes configuration health, instance-local Automatic Routing control, and one-shot Route Overrides. An override resolves its configured Route Target exactly, applies it before the first Turn, keeps it for the full Routed Run, and restores the Baseline Model after settlement. Overrides remain available while Automatic Routing is off and are consumed even when target resolution or application fails. Routing Explanations and automatic classification are added by later V1 stages.

## Configuration

Pi Jev Helm reads `pi-jev-helm.json` from the user directory returned by Pi's public `getAgentDir()` API. It reads the file at session startup and `/reload`; it does not watch the file or assume a home-directory path.

```json
{
  "schemaVersion": 1,
  "automaticRouting": true,
  "confidenceThreshold": 0.75,
  "routes": {
    "fast": {
      "provider": "openrouter",
      "model": "fast-model-id",
      "thinkingLevel": "off"
    },
    "coding": {
      "provider": "anthropic",
      "model": "coding-model-id",
      "thinkingLevel": "high"
    },
    "reasoning": {
      "provider": "openai",
      "model": "reasoning-model-id",
      "thinkingLevel": "high"
    },
    "research": {
      "provider": "google",
      "model": "research-model-id",
      "thinkingLevel": "medium"
    }
  }
}
```

`automaticRouting` defaults to `true`; `confidenceThreshold` defaults to `0.75` and must be finite and within `[0,1]`. Every standard Route requires exactly one complete Route Target. Run `/helm` to inspect configuration health and the effective Automatic Routing state. Invalid configuration disables Automatic Routing without blocking ordinary Pi requests.

## Development

Pi 0.85.1 and Node.js 22.19 or newer are required.

```bash
npm ci
npm run typecheck
npm run build
npm test
```

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

1. Deterministic schema, policy, configuration, command, privacy, and Provider contract tests.
2. Black-box Pi public-extension-API tests with in-process fake models.
3. An explicitly invoked, credentialed real OpenRouter/Jev compatibility gate.

External probabilistic calls are excluded from default CI. The Pi lifecycle suite must cover version 0.85.1 and the newest intended compatible version.

## Project documentation

- [`CONTEXT.md`](CONTEXT.md) — canonical domain vocabulary.
- [V1 specification and parent issue](https://github.com/Z761293629/pi-jev-helm/issues/12).
- [Decision map and completed research tickets](https://github.com/Z761293629/pi-jev-helm/issues/1).
