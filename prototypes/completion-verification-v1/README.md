# Completion Verification Jev prototype V1

> **THROWAWAY PROTOTYPE — not product code.**
>
> Result: **FAIL**. Precision and latency passed, but 2/180 responses were protocol-invalid and the three-state model conflated agent-actionable gaps with external blockers. The follow-up experiment is preserved at `../completion-verification-v2/`.

## Question

Can one batched Jev request over bounded, synthetic Completion Evidence produce three independent judgments—Request Coverage, Verification Sufficiency, and Unresolved Blocker—with enough precision and latency headroom to justify a formal Shadow Verification specification?

This prototype does **not** test active continuation, blocking, correctness proof, arbitrary rubrics, personal transcript mining, telemetry, or adversarial robustness.

## Gate

- 60 fixtures: 30 calibration and 30 frozen holdout.
- Each split has 15 English and 15 Chinese cases, balanced across `supported`, `unsupported`, and `inconclusive` gold outcomes.
- Three live repetitions per fixture; repetitions measure stability and are not counted as independent fixtures.
- Frozen-holdout supported precision must be at least 95%.
- Critical negative cases must have zero false-supported outcomes.
- All 180 requests must return protocol-valid responses.
- End-to-end p95 latency must not exceed 2.5 seconds.

Thresholds are selected only from the calibration split. A fixture counts as false-supported if **any** of its three attempts produces `supported`, making the gate conservative about run-to-run variation.

## Run

The script reads `OPENROUTER_API_KEY` from the process environment. It never prints or writes the key. Do not place the key in chat, source files, fixtures, or shell history.

```bash
node prototypes/completion-verification-v1/run.mjs live
```

A previous synthetic cassette is replaced only when explicitly requested:

```bash
node prototypes/completion-verification-v1/run.mjs live --force
```

Replay and regenerate the report without network access:

```bash
node prototypes/completion-verification-v1/run.mjs analyze
```

## Artifacts

- `fixtures.json` — synthetic and repository-derived labeled cases only.
- `run.mjs` — the throwaway live runner, strict response parser, calibration sweep, and gate evaluator.
- `cassette.jsonl` — normalized Jev judgments, latency, and usage; no API key or real user content.
- `REPORT.md` — the measured verdict.

If the gate fails, stop and return to design. Do not tune against the frozen holdout; revise the evidence or template, add a new holdout, and rerun.
