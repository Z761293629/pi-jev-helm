# Completion Verification Prototype V3 Report

> THROWAWAY PROTOTYPE. This report tests one direct four-way Completion Disposition Choice over bounded synthetic Completion Evidence, with a Route Context ablation. It is not product code, a correctness proof, or a security evaluation.

- Template: `completion-verification-prototype-v3`
- Model: `typesafe/jev-1.13` through OpenRouter Decisions with ZDR
- Probability-sum tolerance: 0.05 (aligned with the official pi-typesafe parser contract)
- Fixtures: 80 fresh cases (40 calibration, 40 frozen holdout; balanced by language, disposition, and Route Context bucket)
- Conditions: route-aware, route-blind
- Repetitions: 3 per fixture and condition (480 expected requests)
- Attempt coverage complete: yes
- Safe failure handling: 100%
- Valid responses: 480/480 (100.0%; gate ≥98.0%)
- Failures: none
- Safe protocol diagnostics: none
- Latency: median 357 ms, p95 592 ms, deadline 2500 ms
- Reported provider cost: $0.016941

## Selected calibration policy

A direct Choice with confidence below **0.50** routes safely to `inconclusive`. One common threshold was selected on pooled route-aware and route-blind calibration, then frozen for both holdout conditions.

### Calibration · route-aware

- Disposition macro-F1: **95.1%**
- Accuracy: 95.0%
- Complete precision Wilson 95% lower bound: 70.1%
- complete: precision 100.0%, recall 90.0%, F1 94.7% (predicted 9, gold 10)
- continue: precision 100.0%, recall 90.0%, F1 94.7% (predicted 9, gold 10)
- blocked: precision 100.0%, recall 100.0%, F1 100.0% (predicted 10, gold 10)
- inconclusive: precision 83.3%, recall 100.0%, F1 90.9% (predicted 12, gold 10)
- Confidence-routed any-attempt false-complete fixture IDs: none
- Raw Choice any-attempt false-complete fixture IDs (diagnostic, before fallback): none
- Three-run disposition stability: 97.5%
- Accuracy by Route Context bucket:
  - fast: 100.0%
  - coding: 100.0%
  - reasoning: 100.0%
  - research: 100.0%
  - unrouted: 75.0%

### Calibration · route-blind

- Disposition macro-F1: **95.1%**
- Accuracy: 95.0%
- Complete precision Wilson 95% lower bound: 70.1%
- complete: precision 100.0%, recall 90.0%, F1 94.7% (predicted 9, gold 10)
- continue: precision 100.0%, recall 90.0%, F1 94.7% (predicted 9, gold 10)
- blocked: precision 100.0%, recall 100.0%, F1 100.0% (predicted 10, gold 10)
- inconclusive: precision 83.3%, recall 100.0%, F1 90.9% (predicted 12, gold 10)
- Confidence-routed any-attempt false-complete fixture IDs: none
- Raw Choice any-attempt false-complete fixture IDs (diagnostic, before fallback): none
- Three-run disposition stability: 97.5%
- Accuracy by Route Context bucket:
  - fast: 100.0%
  - coding: 100.0%
  - reasoning: 100.0%
  - research: 100.0%
  - unrouted: 75.0%

### Frozen holdout · route-aware

- Disposition macro-F1: **97.5%**
- Accuracy: 97.5%
- Complete precision Wilson 95% lower bound: 72.2%
- complete: precision 100.0%, recall 100.0%, F1 100.0% (predicted 10, gold 10)
- continue: precision 100.0%, recall 90.0%, F1 94.7% (predicted 9, gold 10)
- blocked: precision 100.0%, recall 100.0%, F1 100.0% (predicted 10, gold 10)
- inconclusive: precision 90.9%, recall 100.0%, F1 95.2% (predicted 11, gold 10)
- Confidence-routed any-attempt false-complete fixture IDs: none
- Raw Choice any-attempt false-complete fixture IDs (diagnostic, before fallback): h03
- Three-run disposition stability: 100.0%
- Accuracy by Route Context bucket:
  - fast: 87.5%
  - coding: 100.0%
  - reasoning: 100.0%
  - research: 100.0%
  - unrouted: 100.0%

### Frozen holdout · route-blind

- Disposition macro-F1: **97.5%**
- Accuracy: 97.5%
- Complete precision Wilson 95% lower bound: 72.2%
- complete: precision 100.0%, recall 100.0%, F1 100.0% (predicted 10, gold 10)
- continue: precision 100.0%, recall 90.0%, F1 94.7% (predicted 9, gold 10)
- blocked: precision 100.0%, recall 100.0%, F1 100.0% (predicted 10, gold 10)
- inconclusive: precision 90.9%, recall 100.0%, F1 95.2% (predicted 11, gold 10)
- Confidence-routed any-attempt false-complete fixture IDs: none
- Raw Choice any-attempt false-complete fixture IDs (diagnostic, before fallback): h03
- Three-run disposition stability: 97.5%
- Accuracy by Route Context bucket:
  - fast: 87.5%
  - coding: 100.0%
  - reasoning: 100.0%
  - research: 100.0%
  - unrouted: 100.0%

## Route Context ablation

- Holdout macro-F1 delta (route-aware minus route-blind): **0.0 percentage points**.
- This delta is descriptive, not a gate. Route Context is a bounded hint and must never be treated as evidence of completion.

## Gate

**PASS**

Required for the route-aware frozen holdout:

- complete precision ≥95%, recall ≥80%, at least 8 predicted-complete fixtures, and zero any-attempt false-complete fixtures;
- blocked and continue precision and recall each ≥80%;
- disposition macro-F1 ≥80%;
- 100% safe handling and ≥98% protocol-valid responses across both conditions;
- p95 latency ≤2500 ms across both conditions.

The direct-disposition empirical question passed. Product-experience and real Pi editor-lifecycle evidence are tracked separately in PRODUCT-WALKTHROUGH.md; this report alone does not authorize production implementation.
