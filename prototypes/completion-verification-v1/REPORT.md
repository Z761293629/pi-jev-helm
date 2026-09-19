# Completion Verification Prototype Report

> THROWAWAY PROTOTYPE. This report answers whether three narrow Jev judgments over bounded synthetic Completion Evidence can pass a precision-first gate. It is not a product implementation or a security evaluation.

- Template: `completion-verification-prototype-v1`
- Model: `typesafe/jev-1.13` through OpenRouter Decisions with ZDR
- Fixtures: 60 (30 calibration, 30 frozen holdout; 15 English and 15 Chinese per split)
- Repetitions: 3 per fixture (180 expected requests)
- Attempt coverage complete: yes
- Valid responses: 178/180 (98.9%)
- Failures: protocol=2
- Latency: median 366 ms, p95 559 ms, deadline 2500 ms
- Reported provider cost: $0.006576

## Selected calibration policy

```json
{
  "requestCoverage": 0.5,
  "verificationSufficiency": 0.5,
  "unresolvedBlockerLow": 0.2,
  "unresolvedBlockerHigh": 0.6
}
```

### Calibration

- Supported precision: **100.0%**
- Supported recall: 90.0%
- Predicted-supported fixtures: 9
- False-supported fixture IDs: none
- Critical false-supported fixture IDs: none
- Three-run outcome stability: 93.3%
- Decisive fixture rate: 96.7%

### Frozen holdout

- Supported precision: **100.0%**
- Supported recall: 80.0%
- Predicted-supported fixtures: 8
- False-supported fixture IDs: none
- Critical false-supported fixture IDs: none
- Three-run outcome stability: 93.3%
- Decisive fixture rate: 90.0%

### Per-signal raw-choice accuracy

- Calibration Request Coverage: 56.2%
- Calibration Verification Sufficiency: 64.0%
- Calibration Unresolved Blocker direction: 76.7%
- Holdout Request Coverage: 51.7%
- Holdout Verification Sufficiency: 59.6%
- Holdout Unresolved Blocker direction: 75.0%

## Gate

**FAIL**

Required:

- frozen-holdout supported precision ≥95%;
- zero critical false-supported fixtures;
- 100% protocol-valid responses across all expected attempts;
- p95 latency ≤2500 ms.

The empirical question did not pass. Stop here and return to design; do not proceed to a formal product specification without revising the evidence or template and adding a new frozen holdout.
