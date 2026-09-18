# Pi request model scope prototype

> **PROTOTYPE — throwaway code for the decision ticket “验证 Pi 单请求模型切换与恢复”. Do not merge into the product.**

## Question

Can a Pi extension use only public APIs to choose a model before one user request, keep that model for the run, restore the user's baseline when the run settles, and avoid changing the next request?

The probe also exercises the awkward boundary: a follow-up queued while the routed run is active.

## Run

```bash
node prototypes/pi-request-model-scope/run-scope-probe.mjs
```

The harness starts Pi 0.85.1 in RPC mode with two deterministic in-process fake models. It makes no external model calls and needs no API key. It prints the assertions and the path to a detailed JSONL event log.

## Expected interpretation

- A separately submitted idle request after `agent_settled` should use the restored baseline model.
- A `followUp` queued during a routed run is part of that run from Pi's public lifecycle perspective; it has no independent `before_agent_start` boundary and inherits the routed model.
- Therefore the stable V1 boundary can be an **idle-run scope**, not strict per-user-message isolation.
