# Routing evaluation protocol — PROTOTYPE (throwaway)

Answers one question: **what evidence is enough to adopt a cheaper candidate
routing strategy without reducing task-result quality**, when initial
misclassification, Capability Drift, and Prompt Cache loss all affect the result?

The current decision target is cost-first: at least 20% lower average total cost
than both current Helm and the always-strong-model control, with no statistically
detected quality regression and no new critical objective failure. This rule can
miss small degradations; the prototype includes that case explicitly.

Two review surfaces over the same logic:

- **`index.html`** — self-contained, double-clickable. Open it on a machine with
  a browser. Free-play buttons plus five guided scenarios (cost target met,
  cache loss erasing savings, aggregate parity hiding Drift harm, a small decline
  that is not statistically detected, and objective regression).
- **`review.mjs`** — terminal reviewer for SSH sessions. Extracts the same
  protocol logic and scenario presets from `index.html`, so there is one source
  of truth.

```bash
node prototypes/routing-evaluation-protocol/review.mjs
node prototypes/routing-evaluation-protocol/review.mjs --sweep-cost
node prototypes/routing-evaluation-protocol/review.mjs --max-current-cost 0.75 --min-decisive 40
```

Not production code. No tests, no persistence, no install. Delete the whole
directory once the protocol question is settled.
