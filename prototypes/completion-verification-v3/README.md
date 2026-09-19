# Completion Verification Jev prototype V3

> **THROWAWAY PROTOTYPE — not product code.**

V1 and V2 remain preserved in their sibling directories. V2 showed that a four-way Completion Disposition was promising, but its three independently evaluated signals were not accurate enough to present as faithful explanations. Its protocol-validity result was also distorted by a probability-sum tolerance stricter than the official `pi-typesafe` contract.

## Question

On this registered synthetic corpus, can one direct Jev Choice over bounded Completion Evidence decide whether a Helm Run should be treated as:

- `complete` — every requested outcome is addressed with reasonable support and nothing remains;
- `continue` — meaningful agent-actionable work remains;
- `blocked` — the incomplete request genuinely requires user or external action;
- `inconclusive` — bounded evidence cannot distinguish the other outcomes safely?

V3 deliberately asks for the final disposition directly. It does not expose auxiliary judgments as reasoning. It also runs a Route Context ablation:

- `route-aware` includes the selected Route and Capability Signals as a bounded hint;
- `route-blind` uses the same evidence without Route Context.

Route Context is never treated as proof of completion. The ablation is descriptive; the registered gate applies to the route-aware condition.

This prototype does **not** test Pi editor integration, user-interface usefulness, arbitrary correctness, personal transcripts, telemetry, or adversarial security. It deliberately rejects automatic continuation and stop veto.

## Corpus and registered gate

- 80 entirely fresh synthetic fixtures: 40 calibration and 40 frozen holdout.
- Each split balances English/Chinese, all four dispositions, and five Route Context buckets: `fast`, `coding`, `reasoning`, `research`, and `unrouted`.
- Every Route Context × disposition pair has one English and one Chinese fixture per split.
- Three live repetitions per fixture in each condition: 480 total requests. Conditions are deterministically counterbalanced across fixture and repetition order.
- Any erroneous confidence-routed `complete` attempt counts as false-complete even when the other repetitions disagree. Raw Choice false-completes before confidence fallback are reported separately and cannot be hidden by majority voting.
- Failed requests and Choices below the calibrated confidence threshold contribute `inconclusive`; no provider failure can become `complete`.
- One common confidence threshold is selected on pooled route-aware and route-blind calibration, then frozen for both holdout conditions.
- The audited fixture file is sealed before collection as SHA-256 `864599b3c9b8ac29318692e395276448a633e9ac73b88b41751e565863ababd3`. Every cassette row carries that digest and the template version; replay strictly validates both successful and failed normalized records.
- Response parsing uses `PROBABILITY_SUM_TOLERANCE = 0.05`, matching the official `pi-typesafe` parser contract discovered during the V2 review.

The route-aware frozen-holdout gate requires:

- confidence-routed `complete` precision ≥95%, recall ≥80%, at least eight predicted-complete fixtures, and zero confidence-routed any-attempt false-complete fixtures;
- `blocked` and `continue` precision and recall each ≥80%;
- disposition macro-F1 ≥80%;
- 100% safe failure handling and ≥98% protocol-valid responses across both conditions;
- end-to-end p95 latency ≤2.5 seconds across both conditions.

Thresholds are selected only from calibration. Protocol failures retain safe enum diagnostics and an `expected | unexpected | unavailable` answer-key status, never raw answer keys or response bodies.

This is an exact finite-corpus gate, not a population-level reliability estimate. Reports include a fixture-level Wilson confidence bound, and repetitions are treated as correlated stability checks rather than independent examples. A passing result still requires broader real-task validation.

## Run

Validate the corpus without network access:

```bash
node prototypes/completion-verification-v3/run.mjs validate
```

The live runner reads `OPENROUTER_API_KEY` from the process environment. It never prints or writes the key. Do not place the key in chat, source files, fixtures, or shell history.

```bash
node prototypes/completion-verification-v3/run.mjs live
```

Replace an existing synthetic cassette only when explicitly requested:

```bash
node prototypes/completion-verification-v3/run.mjs live --force
```

Replay without network access:

```bash
node prototypes/completion-verification-v3/run.mjs analyze
```

After the empirical run, open the no-network experience walkthrough directly in a browser:

```bash
open prototypes/completion-verification-v3/walkthrough.html
```

Its guided scenarios compare ordinary Pi behavior, Shadow-only presentation, and the user-selected design: an unsent Continuation Draft placed in the editor for the user to edit, send, or delete.

To exercise the real Pi editor lifecycle without a Jev request, load the throwaway extension:

```bash
pi -e ./prototypes/completion-verification-v3/editor-draft-extension.ts
```

Then run `/helm-draft-demo arm`, send one ordinary prompt, and wait for settlement. The prototype stages a generic draft at `agent_end` and fills an empty editor at `agent_settled`; it never sends the draft, starts a Turn, or overwrites existing editor text.

## Artifacts

- `fixtures.json` — fresh synthetic and repository-shaped labeled cases only.
- `run.mjs` — live runner, strict safe parser, calibration sweep, Route Context ablation, and gate evaluator.
- `cassette.jsonl` — normalized judgments, timing, safe failures, and usage; no key or real user content.
- `REPORT.md` — measured verdict.
- `walkthrough.html` — standalone, no-network product experience walkthrough; no Jev calls or persistence.
- `editor-draft-extension.ts` — loadable throwaway Pi extension that validates the unsent editor-draft lifecycle without Jev.
- `PRODUCT-WALKTHROUGH.md` — accepted user experience, manual Pi lifecycle evidence, and product-gate verdict.

If the empirical gate fails, stop and return to design. Do not tune against the frozen holdout. The empirical gate passed, and the user subsequently validated the Continuation Draft against Pi's real editor lifecycle; both prerequisites for `/to-spec` are now satisfied.
