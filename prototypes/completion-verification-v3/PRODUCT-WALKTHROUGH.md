# Completion Verification V3 product walkthrough

> THROWAWAY PROTOTYPE EVIDENCE — not a product specification.

## Question

When Completion Verification finds established agent-actionable work after a Helm Run settles, what should Helm do that is useful without taking control away from the user?

## Compared experiences

The standalone walkthrough compared:

1. ordinary Pi settlement with no second opinion;
2. Shadow-only presentation of the Completion Disposition;
3. automatic follow-up delivery that starts another Turn;
4. an unsent Continuation Draft placed in Pi's editor.

## Decision

Use an **unsent Continuation Draft** for a confident `continue` disposition. Helm may place one generic draft into an empty interactive Pi editor after settlement; the user can edit it, send it, or delete it. Helm never sends the draft, starts a Turn, overwrites existing editor text, or creates a draft for `complete`, `blocked`, or `inconclusive`.

The draft remains generic because V3 validates a direct Completion Disposition, not a faithful explanation of the specific gap:

```text
请继续检查并完成原请求中尚未覆盖或缺乏证据的部分。
完成后只报告实际执行的工作、验证结果和仍存在的限制。
```

## Manual lifecycle acceptance

The user loaded `editor-draft-extension.ts` through Pi, armed the demo, completed an ordinary prompt, and confirmed that after `agent_settled` the draft appeared in the editor without being sent automatically.

## Verdict

**PASS.** The product experience gate and the V3 direct-disposition empirical gate both passed. Completion Verification may proceed to formal specification; the prototype does not itself authorize production implementation.
