# Research: Prompt-Cache Cost and Observability for Route-Target Switching

Resolves the research question in [issue #79](https://github.com/Z761293629/pi-jev-helm/issues/79)
(“研究 Route 切换的 Prompt Cache 成本与可观测性”, Wayfinder map).

**Question.** When an active Routed Run upgrades from one Route Target to another
provider / model / thinking level, how do Pi and major providers expose prompt-cache
hits, misses, writes, lifetimes, and costs? How should an experiment compute the net
utility of keeping the current Route Target versus switching for quality while paying
cache-loss/rebuild cost, and what conservative rule applies when cache data is absent?

**Scope and sources.** Primary sources only: the installed Pi docs and public
`pi-ai` / `pi-coding-agent` source on this machine, plus first-party caching and
usage documentation from Anthropic, OpenAI, Google (Gemini), and OpenRouter.
Facts are separated into *portable* (true across providers) and *provider-specific*
sections. Production code is unchanged; this is a research note only.

---

## 1. Observable Pi data

### 1.1 Per-response usage on every assistant message

Pi persists a `Usage` object on every assistant message, in memory, in session JSONL,
and in every extension event that carries the message
([docs/session-format.md](#pi-local-sources), “Base Message Types”).

Source of truth — `packages/ai/src/types.ts` in the pi monorepo (verified in the
installed copy at `node_modules/@earendil-works/pi-ai/dist/types.d.ts`, `interface Usage`):

```typescript
interface Usage {
  input: number;            // uncached input tokens (after reads/writes are removed)
  output: number;
  cacheRead: number;        // tokens served from a provider prompt cache
  cacheWrite: number;       // tokens written to a provider prompt cache
  cacheWrite1h?: number;    // subset of cacheWrite written with 1h retention
                            // ("Only Anthropic reports this split")
  reasoning?: number;       // subset of output, when the provider reports it
  totalTokens: number;
  cost: {
    input: number; output: number; cacheRead: number; cacheWrite: number; total: number;
  };                        // dollars, computed by pi from model metadata
}
```

`AssistantMessage` carries the model/provider identity next to that usage
(`pi-ai/dist/types.d.ts`, `interface AssistantMessage`):

```typescript
interface AssistantMessage {
  role: "assistant";
  api: string;              // e.g. "anthropic-messages" | "openai-completions"
  provider: string;         // e.g. "anthropic" | "openrouter" | "helm-route target provider"
  model: string;            // model id as invoked
  responseModel?: string;   // model id the provider reports back, when different
  responseId?: string;
  providerThinkingLevel?: string;
  usage: Usage;             // ← cacheRead / cacheWrite / cost per response
  stopReason: StopReason;
  timestamp: number;
  /* ... */
}
```

**Answer to the core observability question: yes.** A Pi extension can observe
per-response `usage.cacheRead`, `usage.cacheWrite`, `usage.cacheWrite1h`,
`usage.cost.*`, and the `(api, provider, model, thinkingLevel)` identity of each
response, without any privileged API:

- **Session JSONL** (`~/.pi/agent/sessions/…`): each assistant message line carries
  the full `usage` object ([docs/session-format.md], `SessionMessageEntry` example).
- **Extension events**: `message_end`, `turn_end`, and `message_update` deliver the
  `AssistantMessage`; `message_end` handlers may even rewrite `usage`/`cost`
  ([docs/extensions.md], “message_start / message_update / message_end”).
- **Session totals**: Pi's footer and `/session` totals “include assistant responses,
  usage reported by tools, and summary generation”
  ([docs/usage.md], “Interactive Mode”). Tools that make nested LLM calls return a
  `Usage` that Pi persists on the tool result and includes in footer, `/session`,
  and RPC totals ([docs/extensions.md], “Usage accounting”).

### 1.2 Cost computation is Pi-side, from model metadata

Pi computes `usage.cost` itself via `calculateCost(model, usage)`
(`pi-ai/dist/models.js`, verified in the installed copy):

- Tier selection uses total input `usage.input + usage.cacheRead + usage.cacheWrite`
  against `ModelCost.tiers[].inputTokensAbove` (e.g. GPT-5.6's 272K short/long
  context pricing boundary, [docs/models.md], “Per-model Overrides”).
- `cost.cacheRead = rates.cacheRead / 1e6 * cacheRead`
- `cost.cacheWrite = (rates.cacheWrite * shortWrite + rates.input * 2 * longWrite) / 1e6`
  — Anthropic 1-hour writes are charged at 2× the base input rate.
- Rates come from each model's `cost: { input, output, cacheRead, cacheWrite, tiers? }`
  metadata ([docs/models.md], “Model Configuration”; `ModelCostRates`/`ModelCost`
  in `pi-ai/dist/types.d.ts`). A model configured with all-zero cache rates makes
  cache costs invisible *in dollars* even when token counts are visible.

This means cache economics in Pi are **realized and exact per response** (token
counts come from the provider; dollar attribution uses Pi's catalog), not predicted.

### 1.3 Cache-warm usage entries and cache lifetime metadata

- **`UsageEntry`** (session entry type `"usage"`): records model-attributed usage
  that is not an assistant message. `kind` identifies the operation; **cache warming
  uses `kind: "cache_warm"`** ([docs/session-format.md], “UsageEntry”). The example
  entry shows `cacheRead: 50000` with a non-zero `cost.cacheRead`. “Usage entries
  contribute to session token and cost totals. Pi hides them from the conversation
  tree. Consumers should treat unknown `kind` values as normal usage rather than
  rejecting them.” So an experiment can read warming spend and warming hit rates
  per `(provider, model)` from the session file or `ctx.sessionManager.getEntries()`.
- **Cache lifetime metadata**: `Model.promptCache?: { short?: number; long?: number }`
  is a “best-effort prompt cache lifetime in seconds per retention tier”.
  “The built-in catalog fills this in for direct Anthropic (5 min / 1 h). Other
  providers, including direct OpenAI, have no built-in lifetime until their
  cache-expiry and replay behavior has been validated for warming. A model without a
  value for the tier a request used is never warmed”
  ([docs/models.md], “Prompt Cache Lifetimes”). `compat.supportsLongCacheRetention`
  gates the 1h (`anthropic-messages`) / 30m–24h (`openai-*`) retention requests;
  `PI_CACHE_RETENTION=long` selects the `long` tier.

### 1.4 Cache warming: the one place Pi already models cache economics

[docs/settings.md], “Cache Warming” (global setting `cacheWarming`: `"off" |
"streaming" | "idle"`):

- Warming “re-sends the last request with a one-token output budget shortly before
  expiry”, scheduled at **90 % of the cache lifetime** with ≥ 10 s remaining.
- A refresh fires only when “expected avoided cache-miss cost, minus the cost of the
  refresh, leaves at least **$0.05 of expected savings**”.
- “Each refresh is billed as a **cache read of the full context plus one output
  token**. Usage and cost show up in session totals but never enter model context.”
- **“Warming stops when the context changes (model switch, compaction, branch
  navigation).”** — directly relevant: a Route Target upgrade stops warming of the
  old target's prefix.
- Budget-based-thinking Claude models are skipped while thinking is on, “because
  Anthropic derives the thinking budget from `max_tokens` and **keys the message
  cache on it**, so a one-token request cannot reproduce the entry.” I.e. a
  thinking-level change is a cache-identity change for those models.
- `/session` shows the next warming decision, continuation probability, expected
  savings, threshold, and estimated costs; `showCacheMissNotices` surfaces cache
  misses and warm successes in the transcript.
- Extensions can override each decision through the
  **`cache_warming_decision`** event, which exposes Pi's own cost model:
  `event.warmCost` (price of the refresh), `event.missCost` (“extra price of the
  next request if the entry is lost”), `event.continuationProbability`, and
  `event.action` ([docs/extensions.md], “cache_warming_decision”).

### 1.5 Model/provider/thinking identity changes are recorded

- `model_change` / `thinking_level_change` session entries
  ([docs/session-format.md]) and `model_select` / `thinking_level_select` extension
  events (`event.model`, `event.previousModel`, `event.source`;
  `event.level`, `event.previousLevel`) mark exactly when cache identity changes.
  Helm already records richer, branch-aware versions of both as
  `pi-jev-helm-routing-explanation` custom entries (`routing-attempt`,
  `explicit-override`, `restoration`; `src/routing-explanation.ts`).
- Pi's system-prompt machinery is documented in cache terms: returning
  `systemPrompt` (or `forceSystemPrompt`) from `before_agent_start` means “every
  provider receives the forced text as its leading system prompt (**a cache miss
  when it changes**)”, whereas patching `sections` keeps the cached prefix for
  models that accept mid-conversation system messages ([docs/extensions.md],
  “before_agent_start”). Dynamic tool loading notes that providers which cannot
  represent a tool-set transition “receive a complete transcript checkpoint, which
  **may invalidate the cached prefix**”.

### 1.6 What an extension *cannot* see today

- **No direct cache-table introspection.** No provider exposes “which cache entries
  exist and when they expire”; lifetimes in Pi are declared per model
  (`promptCache`) and providers only publish ranges. Everything else must be
  inferred from per-response usage and wall-clock timing.
- **Gemini explicit caching is not exercised by Pi.** Pi's `google-generative-ai`
  adapter maps `usageMetadata.cachedContentTokenCount` → `cacheRead`
  (`pi-ai/dist/api/google-generative-ai.js`); it never creates `CachedContent`
  resources, so `cacheWrite` is always 0 on this API and hits come from implicit
  caching only.
- **Helm itself reads none of this today.** `src/index.ts` switches models via
  `pi.setModel()` + `pi.setThinkingLevel()` at `before_agent_start` and restores at
  `agent_settled`; it records routing decisions (`src/routing-explanation.ts`) but
  never inspects `usage`. The black-box harness's fake providers return only
  `input_tokens`/`output_tokens` (`test/pi-harness.ts:295,326`), so the lifecycle
  suite exercises no cache accounting yet.

---

## 2. Provider comparison (first-party documentation)

Portable facts first, provider-specific behavior clearly marked. “Min prefix” is the
minimum cacheable prompt length; shorter prompts are silently not cached (no error).

### 2.1 Portable facts (true on every first-party API surveyed)

1. **Cache identity is (provider endpoint × model × exact prefix).** A cache hit
   requires an exact prefix match *and* landing on infrastructure that holds the
   entry. Switching model, provider, or (on some providers) thinking parameters
   forfeits the old entry and starts a new one. Nothing carries across providers;
   nothing carries across different models.
2. **Writes can cost more than plain input; reads cost much less.** The universal
   shape is `write ≥ 1.0× input rate`, `read < 1.0× input rate` (0.1×–0.5× across
   the industry). A single unreused write therefore makes caching *net negative*
   for that prefix.
3. **Lifetimes are short and idle-based**, measured from the last write *or* hit;
   hits typically refresh the entry. Entries expire silently — the only observable
   is the next response's usage fields.
4. **Usage reporting is the observability surface**: every provider reports reads
   (and where applicable writes) in the response `usage`; streaming carries usage in
   the first/last stream event. Providers do not report “which prefix” or “expiry
   time” in the usage of a normal completion (Gemini's cache *resource* API is the
   exception).

### 2.2 Comparison table

| | Anthropic Messages | OpenAI (GPT-5.6+ family) | OpenAI (pre-5.6 families) | Google Gemini (AI Studio / Vertex) | OpenRouter (router) |
|---|---|---|---|---|---|
| **Automatic vs explicit** | Explicit `cache_control` breakpoints (≤ 4); plus top-level automatic caching mode | Implicit by default; explicit breakpoints supported (`prompt_cache_breakpoint`, `prompt_cache_options`) | Automatic only; `prompt_cache_key` for routing | Implicit by default (2.5+); explicit `CachedContent` resource API | Provider-dependent; `cache_control` passed through/translated to the upstream provider |
| **Min prefix** | Per model, 512–4,096 tokens (e.g. Sonnet 4.5/4.6 1,024; Opus 4.5/4.6 & Haiku 4.5 4,096; newest Opus/Fable/Mythos 512) | 1,024 tokens strict | 1,024–2,048 tokens by model; hits in 128-token increments | 2,048 (Gemini 2.5), 4,096 (Gemini 3 family); one Vertex preview tier 6,144 (implicit only) | Upstream provider's minimum |
| **TTL / lifetime** | 5 min default, refreshed on each hit; optional `ttl: "1h"` (1h entries must precede 5m) | ≥ 30 min after last write/reuse (`prompt_cache_options.ttl: "30m"`, the only value); may retain longer | In-memory ≈ 5–10 min inactive, up to 1 h; extended retention up to 24 h (`prompt_cache_retention: "24h"`) | Implicit: undocumented, not refreshed on read (per OpenRouter); explicit: TTL chosen per cache, default 1 h, no max (min expiry 1 min on Vertex) | Whatever the chosen upstream endpoint does; sticky routing tries to keep you there |
| **Read price** | 0.1× base input (0.025× on the newest Fable/Mythos 5.1 tier) | 0.1× uncached input rate | Model-dependent discount: 50 % (gpt-4o) to 90 % (gpt-5.x) off input | 90 % off cached tokens on 2.5+ (Vertex; 75 % on 2.0; developers-blog launched implicit at 75 %) | Upstream's read price; billed in credits via `cost` |
| **Write price** | 1.25× input (5 m), 2× input (1 h) | 1.25× uncached input rate, reported in `cache_write_tokens` | No write fee | Implicit: none (cache creation billed at standard input price; no storage fee). Explicit: storage billed by cached-token-count × TTL duration | Upstream's write price (negative `cache_discount` on write turns) |
| **Usage fields (reads/writes)** | `usage.cache_read_input_tokens`, `usage.cache_creation_input_tokens`, split `usage.cache_creation.{ephemeral_5m_input_tokens, ephemeral_1h_input_tokens}`; streaming: `message_start` | `usage.input_tokens_details.{cached_tokens, cache_write_tokens}` (Responses) / `usage.prompt_tokens_details.*` (Chat) | `usage.prompt_tokens_details.cached_tokens` (always present; 0 under min) | `usage_metadata.cachedContentTokenCount` (generateContent) / `usage.total_cached_tokens` (Interactions API) | `usage.prompt_tokens_details.{cached_tokens, cache_write_tokens}` + `usage.cost`, `usage.cost_details`, `cache_discount` |
| **Extra observability** | Both fields 0 ⇒ prompt was not cached (below minimum). Caching invalidators documented: tool changes invalidate all; thinking-parameter changes invalidate messages | Prompt cache diagnostics API (`cache_hit`/`cache_miss` with reason + `cache_missed_tokens`); Usage dashboard | Same fields; dashboard | Cache resource `usageMetadata`, `expireTime`; hits visible on create/get/list and generateContent | Activity page + `/api/v1/generation`; `cache_discount` per generation |
| **What breaks the cache** | Any byte change before a breakpoint; tool changes; thinking-parameter changes; expiry | Prefix change, tool/schema changes, reasoning-effort changes, expiry, machine routing (mitigate with `prompt_cache_key`) | Same; also naive truncation shifts the prefix | Prefix change; expiry; (explicit) creating a new cache resource | Provider drift across upstream endpoints (mitigated by sticky routing / `session_id`) |
| **Cache scope** | Organization-level, per endpoint | Organization-level, per machine; `prompt_cache_key` partitions accounting | Same | Per project/API surface; explicit caches are named resources | Per upstream provider account OpenRouter routes to |

Sources: [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) ·
[OpenAI prompt caching guide](https://developers.openai.com/api/docs/guides/prompt-caching) ·
[OpenAI Prompt Caching 101/201 cookbook](https://developers.openai.com/cookbook/examples/prompt_caching_201) ·
[OpenAI launch post (historical 5–10 min / 50 % baseline)](https://openai.com/index/api-prompt-caching/) ·
[Gemini context caching (generateContent)](https://ai.google.dev/gemini-api/docs/generate-content/caching) ·
[Gemini caching (Interactions API)](https://ai.google.dev/gemini-api/docs/caching) ·
[Vertex AI context caching overview](https://cloud.google.com/vertex-ai/generative-ai/docs/context-cache/context-cache-overview) ·
[Google Developers Blog: implicit caching](https://developers.googleblog.com/gemini-2-5-models-now-support-implicit-caching/) ·
[OpenRouter prompt caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching) ·
[OpenRouter usage accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting) ·
[OpenRouter chat completion reference](https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion) ·
[OpenRouter response caching](https://openrouter.ai/docs/guides/features/response-caching)

### 2.3 OpenRouter changes attribution materially — include it

OpenRouter is not a pass-through and must be part of the model:

- **Provider drift.** The same OpenRouter *model id* can be served by 70+ upstream
  provider endpoints. A cache written on one endpoint is invisible on another.
  OpenRouter mitigates with **provider sticky routing** (remembers the endpoint that
  served a cached request; activates when the endpoint's cache-read price is cheaper
  than plain input; keyed per account/model/conversation by hashing the first system
  + first non-system message, or exactly by an explicit `session_id`). Setting
  `provider.order` disables sticky routing — and Helm's `compat.openRouterRouting`
  (`only`/`order`, `src/index.ts` sibling config in `docs/models.md`) does exactly
  that. So a Helm Route Target pinned through OpenRouter trades price control for
  cache-locality control.
- **Attribution fields.** OpenRouter always returns native-tokenizer usage with
  `prompt_tokens_details.cached_tokens` / `cache_write_tokens`, a `cost` in credits,
  `cost_details` (including `upstream_inference_cost`, BYOK only via the generation
  API), and a **`cache_discount`** per generation (negative on Anthropic write
  turns, positive on read turns). `/api/v1/generation?id=` audits after the fact.
- **Router-layer response caching** (opt-in, separate from provider prompt caching)
  returns identical responses for identical requests with **all billable usage
  counters zeroed** — a source of “usage looks empty” records that an experiment
  must distinguish from “provider reports no cache data”.

### 2.4 Provider-specific cautions for Pi specifically

- Pi's built-in catalog declares cache lifetimes **only for direct Anthropic**
  (5 m / 1 h); every other provider/model has `promptCache` unset, which also
  **disables Pi cache warming** for it ([docs/models.md]). A Route-Target experiment
  must not read “no warming” as “no caching”.
- Pi maps OpenAI-family writes from `prompt_tokens_details.cache_write_tokens`,
  which per OpenAI's docs only GPT-5.6+ emits; pre-5.6 OpenAI has no write fee and
  Pi records `cacheWrite: 0` for it. Reads map from `cached_tokens`
  (`pi-ai/dist/api/openai-completions.js`, `parseChunkUsage`, with the documented
  DeepSeek/Kimi placement fallbacks).
- Anthropic's `cache_creation.ephemeral_1h_input_tokens` is the only source of Pi's
  `cacheWrite1h` split (`pi-ai/dist/api/anthropic-messages.js:420`), and Pi prices it
  at 2× input. Bedrock supports 5-minute caching only (Anthropic docs), which is
  invisible to Pi unless the model entry's `promptCache`/compat reflects it.
- Gemini through Pi: `cacheRead` only (implicit caching), never `cacheWrite`
  (§1.6); treat Gemini cacheWrite=0 as structural, not as a signal of “caching off”.

---

## 3. Cache-aware experiment accounting formula

Two distinct quantities must never be conflated:

- **Realized cache cost (RCC)** — measured after calls, exact, from Pi:
  for each assistant message `m`, with rates from model metadata,
  `cost(m) = usage.cost.total` and
  `cacheShare(m) = usage.cacheRead + usage.cacheWrite` over
  `input(m) + usage.cacheRead + usage.cacheWrite`. The realized cost of a run arm is
  `RCC(arm) = Σ_m cost(m) + Σ_u cost(u)` over assistant messages `m` and usage
  entries `u` (compaction, branch summaries, `cache_warm`) on that arm's branch.
  Every term is directly readable from session JSONL or `message_end` events (§1).
- **Predicted counterfactual cache loss (PCL)** — what the *un-run* alternative
  would have cost. Not observable in a single arm; requires either a model (below)
  or a replay/control arm (§3.3). Pi's warming threshold (`warmCost` vs `missCost`
  at ≥ $0.05 expected savings) is the only first-party counterfactual estimate Pi
  exposes, via `cache_warming_decision` (§1.4).

### 3.1 Two-axis switch accounting at a decision point

Quality scores and dollar costs have different units. They must not be subtracted
unless the experiment predeclares and justifies a quality-to-dollar utility
conversion. The Wayfinder map instead chose quality-first constrained optimization:
measure the two axes separately, require a statistically significant quality gain,
and apply the approximately 20% cost/latency guardrail.

At a decision point with prefix size `T` tokens, current target `A`, candidate
target `B`, and a remaining-run horizon of `k` provider calls:

```
QualityDelta(A→B) = Q_B − Q_A
CostDelta(A→B)    = ΔCache(A→B, T, k) + ΔTok(B vs A)

Eligible(A→B) = QualityDelta is statistically significant
                AND CostDelta stays within the predeclared guardrail
```

A candidate outside the guardrail requires a separately predeclared exception rule
for how much extra cost is acceptable for a measured quality gain; absent that rule,
the decision is **stay**. The cache term is decomposed using each side's own pricing
multipliers (`r_X` = read rate, `w_X` = write rate, `p_X` = base input rate of target X):

```
ΔCache(A→B, T, k) ≈ [ p_B·T·w_B − p_A·T·r_A ]             // call 1: rebuild on B vs read on A
                  + Σ_{i=2..k} p_B·T_i·(r_B − 1)·1[hit]   // forgone/changed read discounts while B's cache is cold
                  + idleLoss(A)                           // A's entry decays unrefreshed (hits stop)
```

Interpretation per provider (all numbers from §2):

- **Anthropic**: call 1 pays `T × 1.25 × p_B` (or `2 × p_B` at 1h TTL) where
  staying would pay `T × 0.1 × p_A`; a switch is ~12.5× the per-call input cost of
  staying until `B`'s first hit lands. Break-even on a 5-minute write is one
  subsequent read (Anthropic's own framing: 1.35× vs 2× for two uncached passes).
- **OpenAI GPT-5.6+**: same shape, 1.25× write vs 0.1× read (1.35× vs 2×).
- **OpenAI pre-5.6**: writes are free, so the call-1 term collapses to
  `p_B·T − p_A·T·r_A`; the loss is the forgone read discount (50–90 %) for `k` calls.
- **Gemini (implicit)**: no write fee and no storage fee; the loss is purely the
  forgone 90 % discount while the new prefix is cold (and Gemini's implicit cache
  does not refresh on read, so both sides decay faster than Anthropic/OpenAI).
- **OpenRouter**: evaluate per upstream endpoint (drift risk), and add
  `cost_discount`/`upstream_inference_cost` cross-checks (§2.3).

### 3.2 Experiment protocol

1. **Arm definition.** For each task `t`, run two arms on identical session forks:
   `stay` (no upgrade) and `switch` (upgrade A→B at the event trigger).
   Pi's JSONL tree + `/fork` makes both arms replay the same prefix.
2. **Measure realized costs** per arm from session entries, segmenting by target:
   group assistant messages by `(provider, model, providerThinkingLevel)`, bounded by
   Helm's existing `routing-attempt` / `explicit-override` / model-change entries.
   Report `RCC(arm)`, plus per-target `cacheRead`/`cacheWrite`/`cacheWrite1h` token
   totals and hit-rate `ΣcacheRead / (Σinput + ΣcacheRead + ΣcacheWrite)`.
3. **Counterfactual attribution.** `ΔCache` is *estimated* by the formula with
   measured `T` (prefix size = last context tokens) and provider multipliers, and
   *validated* by comparing arms: `RCC(switch) − RCC(stay)` on identical workloads is
   the realized cost of switching. Where they disagree, trust the measured
   difference and revise the multiplier assumptions.
4. **Quality term.** `Q` comes from the task-result evaluation protocol (the
   experiment family in the Wayfinder map, issues #66/#67). Keep it separate from
   dollar cost unless that protocol explicitly defines a conversion.
5. **Decision rule.** Upgrade only when the quality gain is statistically significant
   and `max(ΔCache_estimate, measured ΔCache prior)` plus residual token/price cost
   stays within the predeclared cost guardrail. If the cost increase exceeds the
   guardrail, require the protocol's explicit exception rule; absent that rule, or
   absent a quality difference, default to **stay**. This matches Helm's fail-open
   philosophy (routing failures never block; uncertainty retains the Baseline).

### 3.3 Realized vs predicted, explicitly

| Quantity | Kind | Source |
|---|---|---|
| Per-response `cacheRead/cacheWrite/cacheWrite1h`, `cost.*` | Realized | Pi `Usage` on assistant messages (§1.1–1.2) |
| Warming spend and warm hits (`kind: "cache_warm"`) | Realized | Pi `UsageEntry` (§1.3) |
| Hit rate per target per run | Realized, derived | Sum over the run's messages |
| “Cost if we had stayed / switched” | **Predicted** | §3.1 formula + provider multipliers (§2), or Pi's `cache_warming_decision` `warmCost`/`missCost` for the narrow keep-warm decision (§1.4) |
| True counterfactual of a one-way switch | Not observable | Requires replay/control arms (§3.2) — after a one-way upgrade, the “stay” path no longer exists in that run |

---

## 4. Conservative fallback when cache telemetry is absent or incomplete

Detection first, then a bounded cost model:

1. **Detect “no usable cache data”.** Mark a target's telemetry untrusted when any
   of: (a) `cacheRead == 0 && cacheWrite == 0` on `n ≥ 2` consecutive requests that
   share a rendered prefix and exceed the provider's documented minimum (on
   Anthropic, both fields 0 is the documented “was not cached” signal); (b) the
   provider never populates the fields for that API in Pi's adapter (e.g.
   pre-5.6 OpenAI writes are structurally 0; Gemini writes are structurally 0);
   (c) usage fields are missing entirely (streaming paths with
   `supportsUsageInStreaming: false`, local/proxy providers).
2. **Apply the no-cache upper bound.** When telemetry is untrusted, price the
   switch as if the new target never caches: every remaining call pays the full
   uncached input rate `p_B` (and, for Anthropic-style APIs, price the first call's
   prefix at the *write* multiplier `w_B ≥ 1`). That is,
   `ΔCache_conservative = p_B·T·w_B + Σ_{i=2..k} p_B·T_i`. This is the worst case
   because caching can only make the truth cheaper than the bound.
3. **Symmetrically floor the “stay” benefit.** Assume staying also achieves no
   further hits (its cache may expire anyway); i.e. do not credit `stay` with
   unverified read discounts either. Feed the resulting full-price input difference
   into the cost guardrail — do not convert it into a quality score.
4. **Prefer the run boundary when uncertain.** If quality is unknown or the
   conservative switch-cost bound exceeds the guardrail, defer the upgrade to the
   next Routed Run boundary. The boundary is lifecycle-safer and easier to measure,
   but it is **not cache-free**: an existing Baseline or prior-target prefix may
   still be warm, so the next-run decision must price its cache loss too.
5. **Record the uncertainty.** Append a custom (non-context) entry marking the arm's
   cache telemetry as untrusted, mirroring Helm's existing
   `pi-jev-helm-baseline-checkpoint` / routing-explanation entry pattern, so later
   analysis can separate “cache off” from “cache unmeasured”.

Rationale: every provider documents silent non-caching below minimum prefix sizes
and silent expiry; a zero reading is *always* consistent with both “feature
inactive” and “telemetry missing”. Treating zeros as “no discount available” is the
only assumption that cannot overstate savings. Pi's own designers made the same
choice for the complementary decision: models without a declared `promptCache`
lifetime are “never warmed” — refuse to act on unknown cache behavior
([docs/models.md], “Prompt Cache Lifetimes”).

---

## 5. Concrete implications for one-way event-triggered Route upgrades

Context: issue #77 (validating safe in-run Route upgrades) and #78 (re-check
contract) envision a one-way upgrade of an active Routed Run to a stronger Route
Target. Against the findings above:

1. **Every upgrade pays a full-prefix rebuild on the new target.** Portable fact
   (§2.1): cache identity is provider×model×prefix. The first post-upgrade call
   bills the entire context at the new target's write rate where writes are priced
   (Anthropic 1.25×/2×, GPT-5.6+ 1.25×) or at plain input where they are not —
   versus a 0.1×–0.25× read if the run had stayed. On a 100k-token context with a
   Sonnet-class Anthropic target, one avoided upgrade saves roughly
   `100k × (1.25 − 0.1) / 1e6 × $3 ≈ $0.35` per call at write time, plus the read
   discount on every later call of the run.
2. **The old target's cache is stranded, not saved.** One-way means no return, and
   Pi stops warming on model switch (§1.4); a 5-minute Anthropic entry is gone
   before the next Routed Run in all but back-to-back runs. Do not count
   “A is still warm afterwards” as an asset in the accounting — treat the old
   entry as written off at upgrade time. (If within its lifetime it would be
   *refreshed only by hits*, which a one-way switch forgoes.)
3. **Thinking-level changes are cache-relevant even without a model change.**
   Anthropic keys the message cache on the thinking budget for budget-thinking
   models (Pi skips warming for exactly this reason, §1.4), and OpenAI lists
   reasoning-effort changes among miss causes (§2.2). An upgrade “same model,
   thinking medium→high” can still invalidate the cached messages. The experiment
   must treat `(model, thinkingLevel)` as the joint cache identity for accounting.
4. **Switch timing within the run matters asymmetrically.** Earlier upgrades rebuild
   a smaller prefix but forgo the old discount for more calls; later upgrades pay a
   bigger rebuild for fewer remaining calls. The §3.1 formula makes the optimal
   switch point computable: upgrade when
   `(Q_B − Q_A) discounted over remaining calls > rebuild(T_now) + forgone reads(k)`.
   In practice: **upgrade right after a tool-call boundary** where the next prefix
   is still dominated by the stable system/tool prefix, and never mid-stream.
5. **Instrument with what Pi already records.** Boundary every run-segment with
   Helm's routing/explanation entries, read `message_end` usage per segment
   (§1.1), include `cache_warm` usage entries in arm totals (§1.3), and — if the
   upgrade moment is chosen by a background evaluation — use
   `cache_warming_decision`'s `missCost` as the live estimate of what staying is
   worth (§1.4). No production-code changes are needed to *measure*; only to *act*.
6. **Quality and cost must clear separate predeclared gates.** Because issue #77's
   upgrades are one-way, the “stay” counterfactual dies at the switch (§3.3): the
   experiment needs control arms to price `ΔCache`, then requires statistically
   significant quality improvement within the cost guardrail. The conservative rule
   (§4) governs any provider whose cache data is missing — with OpenRouter targets
   that means pinning `provider.order`/`only` (as Helm's Route Targets already can)
   so cache locality is not at the mercy of sticky-routing drift (§2.3).

---

## 6. Ranked recommendations for the Wayfinder map

1. **P0 — Instrument before acting.** Add read-only cache accounting to the
   experiment harness (not production routing): accumulate `usage.cacheRead`,
   `usage.cacheWrite`, `usage.cacheWrite1h`, `usage.cost.total` per
   `(provider, model, thinkingLevel)` segment between Helm's existing routing
   entries, from `message_end` events or session JSONL. This unblocks every later
   decision and requires no new Pi APIs (§1.1, §1.5).
2. **P0 — Adopt `(model, thinkingLevel)` as the accounting identity**, not model
   alone, and segment run costs at every recorded route/override boundary
   (§5.3).
3. **P1 — Implement the §3.1 two-axis accounting in the experiment scorer**, with
   provider multipliers drawn from the Route Targets' own `cost` metadata
   (`cacheRead`, `cacheWrite` rates Pi already carries) and `T` from the last
   assistant message's input totals; validate `ΔCache` estimates against stay/switch
   control arms (§3.2–3.3). Keep quality and dollars separate.
4. **P1 — Codify the conservative rule (§4) as a cost gate**: untrusted cache
   telemetry ⇒ no-cache upper bound for the switch and no read credit for staying ⇒
   upgrade only when quality improves significantly and the bound fits the
   predeclared guardrail; otherwise prefer staying or the next run boundary.
5. **P2 — Prefer run-boundary upgrades over mid-run upgrades** unless quality
   improves significantly and measured `ΔCache` fits the cost guardrail (most likely
   for short runs, small context, or free-write targets such as pre-5.6 OpenAI and
   implicit-caching Gemini, where the §3.1 write term vanishes).
6. **P2 — Pin OpenRouter-backed Route Targets** (`compat.openRouterRouting.only` /
   `order`) when measuring or optimizing cache, so sticky-routing drift cannot
   silently zero `cacheRead` between arms; prefer direct provider targets for
   cache experiments (§2.3).
7. **P3 — Optionally declare `promptCache` lifetimes** for experiment Route Targets
   whose backing cache behavior is validated (per [docs/models.md]), enabling Pi
   cache warming through those targets and giving the experiment Pi's own
   `warmCost`/`missCost` counterfactuals via `cache_warming_decision` (§1.3–1.4).
8. **P3 — Extend the black-box suite's fake providers** to emit non-zero
   `cacheRead`/`cacheWrite`/`cost` usage so lifecycle tests cover cache-aware
   accounting paths end to end (§1.6; `test/pi-harness.ts` currently returns bare
   `input_tokens`/`output_tokens`).

---

## Source index

### Pi local sources (read completely)

- `docs/models.md` — model `cost` (incl. `cacheRead`/`cacheWrite`, tiers),
  `promptCache` lifetimes, “Prompt Cache Lifetimes”, compat flags
  (`supportsLongCacheRetention`, `sendSessionAffinityHeaders`, `cacheControlFormat`).
- `docs/session-format.md` — `Usage`, `AssistantMessage` (provider/model identity),
  `UsageEntry` with `kind: "cache_warm"`, `model_change`/`thinking_level_change`,
  SessionManager API; links to `packages/ai/src/types.ts`,
  `packages/coding-agent/src/core/session-manager.ts` on GitHub
  (<https://github.com/earendil-works/pi>).
- `docs/settings.md` — “Cache Warming” (modes, 90 % scheduling, $0.05 threshold,
  refresh billing, stop-on-model-switch, `showCacheMissNotices`,
  `cache_warming_decision`).
- `docs/custom-provider.md` — `streamSimple` usage mapping (`cache_read_tokens`,
  `cache_write_tokens`, `calculateCost`), `promptCache` field (“Unset disables cache
  warming”), `cacheControlFormat`.
- `docs/extensions.md` (complete) — events (`message_end` usage rewrite,
  `cache_warming_decision`, `model_select`, `thinking_level_select`,
  `before_provider_request`, `after_provider_response`), system-prompt cache-miss
  semantics, tool-loadout cached-prefix caveat, nested tool usage accounting.
- `docs/usage.md` — footer/`/session` cache-usage and cost totals.
- Pi docs root: `/Users/z/.local/share/mise/installs/node/24.0.0/lib/node_modules/@earendil-works/pi-coding-agent/docs`
- Installed source verified:
  `node_modules/@earendil-works/pi-ai/dist/types.d.ts` (`Usage`, `AssistantMessage`,
  `Model`, `ModelCost`), `dist/models.js` (`calculateCost`),
  `dist/api/anthropic-messages.js` (`cacheWrite1h`),
  `dist/api/openai-completions.js` (`parseChunkUsage`),
  `dist/api/google-generative-ai.js` (`cachedContentTokenCount`).

### Helm anchors inspected

- `CONTEXT.md` — Route Target, Routed Run, Baseline Model/Checkpoint, override terms.
- `src/index.ts` — run lifecycle: route application at `before_agent_start`,
  restoration at `agent_settled`; no usage/cache reads today.
- `src/routing-explanation.ts` — versioned, branch-aware routing entries (the
  natural segmentation boundaries for cache accounting).
- `test/pi-black-box.test.ts` + `test/pi-harness.ts` — lifecycle certification;
  fakes emit no cache usage yet.
- `README.md` — V1 routing flow, data/cost disclosures, testing strategy.
- Issue context: #79 (this research), #77/#78 (in-run upgrade feasibility/contract),
  #66/#67/#75 (experiment direction/protocol).

### Provider first-party sources

- Anthropic: <https://platform.claude.com/docs/en/build-with-claude/prompt-caching>
  (breakpoints/automatic mode, min lengths per model, 5m/1h TTL, refresh-on-hit,
  1.25×/2×/0.1× pricing, usage fields incl. `cache_creation` split, invalidators,
  streaming `message_start`, Bedrock 5m-only).
- OpenAI: <https://developers.openai.com/api/docs/guides/prompt-caching> (automatic
  ≥1024 tokens, 128-token increments, GPT-5.6+ 0.1× read / 1.25× write with
  `cache_write_tokens`, `prompt_cache_options.ttl` 30m, `prompt_cache_retention`
  in-memory 5–10 min up to 1 h / `24h`, `prompt_cache_key` ~15 RPM guidance);
  <https://developers.openai.com/api/docs/guides/prompt-caching/diagnostics>
  (`cache_hit`/`cache_miss` diagnostics); cookbook 101/201 (discount history,
  miss causes incl. reasoning-effort changes).
- Google Gemini: <https://ai.google.dev/gemini-api/docs/generate-content/caching>
  and <https://ai.google.dev/gemini-api/docs/caching> (implicit default on 2.5+,
  minimums per model, explicit `CachedContent` TTL default 1 h, storage billed by
  TTL × cached tokens, `cachedContentTokenCount` / `total_cached_tokens`);
  <https://cloud.google.com/vertex-ai/generative-ai/docs/context-cache/context-cache-overview>
  (90 % / 75 % discount surface, 1-minute minimum expiry);
  <https://developers.googleblog.com/gemini-2-5-models-now-support-implicit-caching/>.
- OpenRouter: <https://openrouter.ai/docs/guides/best-practices/prompt-caching>
  (sticky routing, `session_id`, marker translation, `cache_discount`,
  per-provider multipliers and minimums);
  <https://openrouter.ai/docs/cookbook/administration/usage-accounting> and
  <https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion>
  (`usage.cost`, `cost_details`, native tokenizers, `/api/v1/generation`);
  <https://openrouter.ai/docs/guides/features/response-caching> (zeroed usage on
  router-layer hits).
