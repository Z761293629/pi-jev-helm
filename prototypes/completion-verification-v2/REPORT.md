# Completion Verification Prototype V2 Report

> THROWAWAY PROTOTYPE. This report tests whether three narrow Choice judgments over bounded synthetic Completion Evidence can support a four-way Completion Disposition. It is not product code or a security evaluation.

- Template: `completion-verification-prototype-v2`
- Model: `typesafe/jev-1.13` through OpenRouter Decisions with ZDR
- Fixtures: 80 (40 calibration, 40 frozen holdout; 20 English and 20 Chinese per split; four dispositions balanced)
- Repetitions: 3 per fixture (240 expected requests)
- Attempt coverage complete: yes
- Safe failure handling: 100%
- Valid responses: 233/240 (97.1%; gate ≥98.0%)
- Failures: protocol:verification_sufficiency_probability_sum=3, protocol:blocker_status_probability_sum=3, protocol:request_coverage_probability_sum=1
- Safe protocol diagnostics: c23:r1=verification_sufficiency_probability_sum[blockerStatus,requestCoverage,verificationSufficiency]; c33:r1=verification_sufficiency_probability_sum[blockerStatus,requestCoverage,verificationSufficiency]; h12:r1=blocker_status_probability_sum[blockerStatus,requestCoverage,verificationSufficiency]; h12:r2=request_coverage_probability_sum[blockerStatus,requestCoverage,verificationSufficiency]; c37:r3=verification_sufficiency_probability_sum[blockerStatus,requestCoverage,verificationSufficiency]; h25:r3=blocker_status_probability_sum[blockerStatus,requestCoverage,verificationSufficiency]; h31:r3=blocker_status_probability_sum[blockerStatus,requestCoverage,verificationSufficiency]
- Latency: median 338 ms, p95 446 ms, deadline 2500 ms
- Reported provider cost: $0.010270

## Selected calibration policy

```json
{
  "requestCoverage": 0.5,
  "verificationSufficiency": 0.6,
  "blockerStatus": 0.85
}
```

### Calibration

- Disposition macro-F1: **100.0%**
- complete: precision 100.0%, recall 100.0%, F1 100.0% (predicted 10, gold 10)
- continue: precision 100.0%, recall 100.0%, F1 100.0% (predicted 10, gold 10)
- blocked: precision 100.0%, recall 100.0%, F1 100.0% (predicted 10, gold 10)
- inconclusive: precision 100.0%, recall 100.0%, F1 100.0% (predicted 10, gold 10)
- Any-attempt false-complete fixture IDs: none
- Critical any-attempt false-complete fixture IDs: none
- Three-run disposition stability: 95.0%
- Signal macro-F1:
  - Request Coverage: 40.2%
  - Verification Sufficiency: 57.6%
  - Blocker Status: 70.3%

### Frozen holdout

- Disposition macro-F1: **87.6%**
- complete: precision 100.0%, recall 90.0%, F1 94.7% (predicted 9, gold 10)
- continue: precision 90.0%, recall 90.0%, F1 90.0% (predicted 10, gold 10)
- blocked: precision 100.0%, recall 70.0%, F1 82.4% (predicted 7, gold 10)
- inconclusive: precision 71.4%, recall 100.0%, F1 83.3% (predicted 14, gold 10)
- Any-attempt false-complete fixture IDs: none
- Critical any-attempt false-complete fixture IDs: none
- Three-run disposition stability: 92.5%
- Signal macro-F1:
  - Request Coverage: 44.6%
  - Verification Sufficiency: 49.7%
  - Blocker Status: 73.2%

## Gate

**FAIL**

Required:

- frozen-holdout complete precision ≥95% and zero critical any-attempt false-complete fixtures;
- blocked and continue precision and recall each ≥80%;
- disposition macro-F1 ≥80%;
- each Verification Signal macro-F1 ≥75%;
- 100% safe handling and ≥98% protocol-valid responses;
- p95 latency ≤2500 ms.

The empirical question did not pass. Stop here and return to design; do not proceed to a formal product specification without revising the evidence or template and adding a new frozen holdout.
