# Routing evaluation protocol — PROTOTYPE (throwaway)

Answers one question: **what evidence is enough to call a candidate routing
change better than current Helm**, when the candidate may fix initial
misclassification and Capability Drift but may also lose Prompt Cache and cost
more?

Two review surfaces over the same logic:

- **`index.html`** — self-contained, double-clickable. Open it on a machine with
  a browser. Free-play buttons plus five guided scenarios (valid win, cache cost
  breach, aggregate win hiding Drift harm, excessive ties, objective regression).
- **`review.mjs`** — terminal reviewer for SSH sessions. Extracts the same
  protocol logic and scenario presets from `index.html`, so there is one source
  of truth.

```bash
node prototypes/routing-evaluation-protocol/review.mjs
node prototypes/routing-evaluation-protocol/review.mjs --sweep-cost
node prototypes/routing-evaluation-protocol/review.mjs --max-cost 1.35 --min-decisive 40
```

Not production code. No tests, no persistence, no install. Delete the whole
directory once the protocol question is settled.
