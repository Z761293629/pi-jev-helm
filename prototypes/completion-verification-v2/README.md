# Completion Verification Jev prototype V2

> **THROWAWAY PROTOTYPE — not product code.**

V1 is preserved at `../completion-verification-v1/`. It passed the precision and latency checks but failed the original 100%-valid-response gate and exposed a domain flaw: three outcomes could not distinguish agent-actionable unfinished work from work blocked on user or external action.

## Question

Can one batched Jev request over bounded, synthetic Completion Evidence produce three independent Choice judgments—Request Coverage, Verification Sufficiency, and Blocker Status—that support a useful four-way Completion Disposition?

The dispositions are:

- `complete` — evidence supports completion;
- `continue` — unfinished work remains agent-actionable;
- `blocked` — progress genuinely needs user or external action;
- `inconclusive` — bounded evidence cannot be classified reliably.

This prototype does **not** test active continuation, blocking control flow, correctness proof, arbitrary rubrics, personal transcript mining, telemetry, or adversarial robustness.

## Corpus and gate

- 80 fixtures: 40 calibration and 40 entirely new frozen holdout.
- Each split balances English/Chinese, all four dispositions, and every option of all three Verification Signals.
- Three live repetitions per fixture; repetitions measure stability and are not independent fixtures.
- Any erroneous `complete` attempt counts as false-complete, even if the other two repetitions disagree.
- Other disposition and signal metrics use the three-run fixture majority; a failed request contributes `inconclusive`/`unclear`.

The gate requires:

- holdout `complete` precision ≥95% and zero critical false-complete fixtures;
- `blocked` and `continue` precision and recall each ≥80%;
- disposition macro-F1 ≥80%;
- every Verification Signal macro-F1 ≥75%;
- 100% safe failure handling and ≥98% valid responses;
- end-to-end p95 latency ≤2.5 seconds.

Thresholds are selected only from calibration. Protocol failures retain safe enum diagnostics and answer-key names, never raw response bodies.

## Run

The script reads `OPENROUTER_API_KEY` from the process environment. It never prints or writes the key. Do not place the key in chat, source files, fixtures, or shell history.

```bash
node prototypes/completion-verification-v2/run.mjs live
```

Replace an existing synthetic cassette only when explicitly requested:

```bash
node prototypes/completion-verification-v2/run.mjs live --force
```

Replay without network access:

```bash
node prototypes/completion-verification-v2/run.mjs analyze
```

## Artifacts

- `fixtures.json` — synthetic and repository-derived labeled cases only.
- `run.mjs` — live runner, safe protocol diagnostics, calibration sweep, and gate evaluator.
- `cassette.jsonl` — normalized judgments, latency, safe failures, and usage; no key or real user content.
- `REPORT.md` — measured verdict.

If the gate fails, stop and return to design. Do not tune against the frozen holdout; revise the evidence or template, add a new holdout, and rerun.
