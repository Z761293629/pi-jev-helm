# Research: pi-jev-router routing design and reusable evidence

**Question.** How does the independent implementation
[`mejiasd3v/pi-jev-router`](https://github.com/mejiasd3v/pi-jev-router) classify
requests and route them, what behavior surrounds that decision, what evidence
does it carry for routing quality, and which of its ideas should Pi Jev Helm
test or refuse — in service of an experiment to improve task-result quality?

**Method.** Primary sources only. Upstream read from a full clone at commit
`24043d0` (tag `v0.3.0`, 2026-09-18; entire public history is 9 commits,
2026-09-17 → 2026-09-18). Helm side read from this repository's anchors:
`CONTEXT.md`, `src/classification-provider.ts`, `src/routing-policy.ts`,
`src/classification-corpus.ts`, `src/real-jev-gate.ts`, `README.md`, and
`docs/adr/0001`–`0003`. Upstream file citations below use `index.ts` /
`index.test.mjs` / `README.md` at that commit. This report uses Helm's
glossary (`CONTEXT.md`) vocabulary for Helm concepts; "Jev Router" is the
upstream project's own name, kept as a proper noun.

**Headline.** Jev Router and Helm solve the same primitive — Jev judges an
incoming task — with nearly opposite contracts. Jev Router asks Jev one
`choice` question ("pick the model+effort") with **no confidence gate**, pins
the answer for the whole session, and **fails over** to a configured fallback
model. Helm asks three independent Boolean questions, applies a deterministic
Routing Policy with a confidence threshold, re-scopes every Routed Run, and
**fails open** to the Baseline Model. Jev Router contains **no empirical
routing-quality evidence** — its 35 tests are fully mocked and its metrics are
observability, not evaluation. Helm's corpus + real Jev gate is therefore the
only evaluation instrument in scope, and the highest-value imports from
upstream are measurement controls and instruction-language ideas, not
behavioral contracts.

---

## 1. How Jev Router classifies requests and maps judgments to routes

**One `choice` judgment, not capability decomposition.** Jev Router asks Jev a
single question named `route` of Vercel AI SDK type `choice` whose criteria are
the user-configured route descriptions: each candidate is a `provider/model`
reference plus a task description, a thinking level, and an effort description
(`index.ts:439-448`). The evaluation model is `typesafe-ai/jev` through the
Vercel AI Gateway (`index.ts:465`). Jev returns one choice; the code validates
only that the choice names an offered profile and then adopts its target and
thinking level verbatim (`index.ts:510-512`). Model and effort are chosen
together in one evaluation, not in separate steps (`README.md:67`).

**Candidate set = allowlisted, authenticated, modality-capable models.** Only
models listed in `options` that are also authenticated in Pi are eligible
(`index.ts:357-361`); image-bearing inputs drop candidates whose `input` lacks
`"image"` (`index.ts:556`). Thinking candidates come from four policies:
`"auto"` maps every level to a hand-written effort description
(`AUTO_THINKING`, `index.ts:39-48`), a fixed level is clamped to the model,
a per-level description map restricts and relabels choices, and omission
inherits Pi's current reasoning option (`index.ts:408-416`).

**No intermediate representation.** There is no capability signal layer, no
route taxonomy, and no deterministic policy: the description text *is* the
classifier. Helm instead decomposes into three Capability Signals
(`codeWork`, `deepReasoning`, `externalResearch`; `classification-provider.ts:57-72`)
and maps them to four Routes deterministically with precedence
research → coding → reasoning → fast (`routing-policy.ts:14-20`).

**Long-prompt handling.** Input is the latest user message plus up to 7 prior
user/assistant text messages, capped at 192,000 UTF-8 bytes, with a
SHA-256 content key over `[timestamp, text]` for dedupe
(`routingInput`, `index.ts:129-150`). If the serialized request exceeds the
28,000-byte evaluation budget (a conservative proxy for Jev's ~32K-token
budget, `README.md:85`), the latest user text is split into at most 8
overlapping chunks (128-char overlap, newline-boundary alignment, 2 in
parallel; `chunkRoutingText`, `index.ts:159-190`). Each chunk is judged in
isolation with 256-char opening/closing excerpts as context, then one final
"combined" evaluation weighs all chunk assessments with the explicit
instruction: "Do not average scores or take a majority vote: routine sections
must not drown out a demanding requirement" (`index.ts:459-462`). Oversized
inputs or excessive chunk plans raise a budget error and fall back *before any
evaluation* (`index.test.mjs:748-763`).

## 2. Confidence, fallback, lifecycle, configuration, model switching

**Confidence.** The route `choice` answer carries no confidence check — only
membership validation (`index.ts:510-512`). The only probability threshold in
the codebase is in the opt-in skill selector: skills with Jev probability
≥ 0.8 (top 3 by probability) get their full instructions injected, bounded at
50,000 bytes per turn (`index.ts:337-348`). The 0.8 value and the skill
injection behavior have no stated validation anywhere in the repo.

**Fallback and failure.** A configured `fallback` route (which must itself be
listed in `options`, `index.ts:112-113`) absorbs: initial-routing failures
(timeout after 3 attempts, HTTP errors with sanitized reasons, invalid
answers, budget errors — `index.ts:515-523`), empty or oversized input
(`index.ts:436`), and auxiliary (non-main-session) requests, which use
fallback without creating a pin (`index.ts:429`). Error reasons are
sanitized — "Never expose SDK error bodies: they may contain conversation text"
(`index.ts:516-517`) — convergent with Helm's safe-failure-summary taxonomy
(`classification-provider.ts:150-162`). Timeout policy: up to
`EVALUATION_ATTEMPTS = 3` retries per request under one shared ceiling of
`3 × timeoutMs` (default 15 s) covering auth, chunks, retries, and the final
decision (`index.ts:24, 450-452, 484`).

**Lifecycle — pin once, monitor, suggest.** The first main-session selection
pins model+thinking for the whole session (`index.ts:578-582`); the pin
survives tool calls, compaction, `/reload`, and `/resume` because it is
restored from session entries (`jev-pin`, `jev-route`, `jev-monitor`,
`jev-suggestion`, `jev-skills`) at `session_start`, keyed to the session ID
("Pins belong to the whole session, not a tree branch", `index.ts:612-632`).
`/new`, `/fork`, `/clone` choose afresh. While pinned, `monitor` (default on)
re-evaluates on new user text, deduplicated by the input key
(`index.ts:403-405`); if Jev would pick a different model, the extension only
*notifies a fork suggestion*, once per alternative model per session — it
never switches ("Suggest, never switch", `README.md:94`;
`index.ts:530-538`). If a pinned route becomes unavailable or unsupported,
the router errors instead of switching (`index.ts:397-401`).

**Configuration.** Global `~/.pi/agent/settings.json` key `jevRouter` only —
project settings cannot override routing; `parseConfig` strictly validates
options/fallback/timeoutMs (1–60,000)/monitor/skills (`index.ts:86-120`), and
invalid global settings fail startup rather than silently using other routes
(`index.test.mjs:948`). Defaults: two routes (Luna at `max`, Astra at
`xhigh`), Astra fallback, 5 s timeout, monitor on, skills off
(`index.ts:51-66`).

**Model switching mechanics.** Jev Router registers a synthetic Pi provider
`auto/jev` whose `streamSimple` delegates to the selected target, replacing
the credential envelope wholesale (`index.ts:363-386, 588-596`), refreshes the
registered model limits to follow the pinned backend (`index.ts:560-570`),
and refuses deferred generation. Selecting any concrete model bypasses model
routing entirely (`README.md:98`).

**Contrast with Helm's lifecycle.** Helm applies a Route Target for the
duration of one Routed Run, records a Baseline Checkpoint, restores the
Baseline Model when the run settles, and treats Explicit Model/Thinking
Overrides as authoritative supersessions (`CONTEXT.md` "Routed Run",
"Baseline Model", "Explicit Model Override"; `src/index.ts:700-810` fail-open
and restoration paths). Helm's fail-open outcomes — provider-unavailable,
classification failure, low-confidence, superseded-by-explicit-choice — all
retain the Baseline (`src/index.ts:900-970`).

## 3. Evidence inventory: measured vs. claimed

**Jev Router contains no empirical routing-quality evidence.** Concretely:

| Item | Status | Source |
| --- | --- | --- |
| Routing-quality / accuracy evaluation | **Absent.** No corpus, no golden set, no labeled tasks anywhere in the repo | full clone at `24043d0` (file list: `index.ts`, `index.test.mjs`, `README.md`, `package.json`, `lock.yaml` only) |
| Test suite | 35 deterministic tests over a **mocked** gateway and mocked `evaluate` responses; "Tests mock network responses; no API keys or paid requests are needed" | `index.test.mjs:38-60` (harness), `README.md` Development section |
| Latency/cost numbers | Per-decision observability only: `milliseconds`, `evaluationRequests`, `routingChunks`, `inputTokens`/`outputTokens`, `usageIncomplete`, and an estimated cost computed as `inputTokens × $0.042 / 1M` (input tokens only, hardcoded price) recorded to session entries and shown by `/jev` | `index.ts:24, 470-481, 528-530, 648-666` |
| Accuracy claims in README | None made — claims are honestly hedged as heuristics: chunked routing "is still a heuristic: relationships across sections may be missed" (`README.md:87`); skill probabilities are "heuristic relevance signals, not guarantees" (`README.md:73`); pinning "favors cache reuse but guarantees neither cache hits nor savings" (`README.md:106`) | `README.md:73-106` |
| Latency/cost claims | Budget arithmetic only (28 KB ≈ 32K tokens proxy; ≤ 9 chunk evaluations, ≤ 27 attempts worst case; 3×timeout ceiling) — derived from code constants, not measured runs | `index.ts:21-30`; `README.md:85-106` |

So every behavioral statement in the upstream README is a design claim or a
code-derived invariant, never a measurement. Even the cost estimate constant
($0.042/M input tokens) is an unexplained magic number, and it counts input
tokens only.

**Helm, by contrast, has the only evaluation instrument in this comparison:**
the versioned `classification-v1` corpus (24 canonical messages covering all
eight Boolean signal vectors twice plus four semantic boundaries, digest-bound
to the template version — `classification-corpus.ts:15-50, 69ff`;
`real-jev-gate.ts:180-215` prevents running a stale pairing), executed per
Jev Client leg with confidence threshold 0.75, three independent executions
per message, and a per-message two-of-three rule (`real-jev-gate.ts:21-26,
117-177`). Recorded gate evidence: OpenRouter leg 24/24; TypeSafe leg 24/24
in six of nine full-gate runs, with the designed boundary example
`classification-v1/024` failing its two-of-three vote in the other three runs
on genuine model variance (`README.md:65-68, 571-584`). That boundary-example
variance is the single most experiment-relevant empirical fact on either side.

## 4. Candidate interventions and controls for the Wayfinder map

Ranked by expected value for a task-result-quality experiment; all are
testable against the existing corpus/gate harness without adopting upstream
contracts.

1. **Per-classification measurement records (control infrastructure).** Import
   the *shape* of upstream's `jev-route`/`jev-monitor` entries — latency,
   request count, token usage, retry/chunk counters, keyed by an input-content
   hash (`index.ts:470-481, 528-530`). Helm validates envelope usage
   (`classification-provider.ts` `parseTaskClassificationResponse`) but
   discards it; recording it per classification attempt makes quality, cost,
   and latency measurable per experiment arm. The content-key dedupe
   (`checkedKey`, `index.ts:403`) doubles as a control against
   double-counting identical inputs. Purely additive; no contract impact.
2. **Threshold/boundary sweep as the first experiment.** Upstream's absence of
   any confidence evidence means Helm must produce its own. The natural
   first map node: sweep `confidenceThreshold` (default 0.75,
   `config.ts:8`) across gate runs and measure the `classification-v1/024`
   two-of-three variance and fail-open rate per threshold. Controls: pinned
   model identities (`jev-1.13` / `jev-1.13.0`), fixed 3-execution/2-of-3
   harness, unchanged template (digest-bound).
3. **Anti-averaging compound-union instruction language.** Upstream's
   combined-stage instruction — judge "minority requirements and possible
   cross-section dependencies… routine sections must not drown out a demanding
   requirement" (`index.ts:459-462`) — is a directly reusable formulation of
   Helm's union semantics for compound requests (`CONTEXT.md` "Task
   Classification"). Test as a `CLASSIFICATION_TEMPLATE_V1` instruction
   variant on the corpus's compound/boundary messages. Note the documented
   procedure: any substantive template change requires a new template version
   plus a complete corpus rerun per leg (`real-jev-gate.ts:207-221`;
   `README.md:594-597`).
4. **Modality-aware Route Target validation.** Before applying a Route, check
   the target model's declared input modalities against the request (images)
   and fail open explicitly with an explained reason when unsupported —
   upstream does this at candidate filtering (`index.ts:556`), Helm
   currently does not. Small, contract-aligned (fail-open is Helm's documented
   failure posture).
5. **Retry-on-timeout within a shared deadline (needs an ADR first).**
   Upstream's 3-attempt timeout retry under one `3 × timeoutMs` ceiling
   (`index.ts:24, 450-452, 484`) is a plausible availability improvement for
   classification, but it contradicts the current single-attempt seam
   guardrail (`docs/adr/0003`, SDK `maxRetries: 0` rationale). Only worth
   testing as a separately decided experiment arm measuring fail-open-rate
   reduction vs. added latency; it must not silently revise ADR-0003.
6. **Effort-description vocabulary (low priority).** `AUTO_THINKING`
   (`index.ts:39-48`) is a well-tested way to describe per-level effort to
   Jev. Relevant only if Helm ever resolves thinking levels per Run rather
   than statically per Route Target; if so, resolve deterministically from
   signal confidences to preserve the "deterministic rules" contract.

## 5. What not to copy, and why

1. **Fallback route on routing failure.** Conflicts with Helm's design
   principle "no fuzzy model matching, nearest-model substitution,
   cross-Route fallback" (`README.md` Design principles) and the fail-open
   posture that retains the Baseline Model on every failure path
   (`src/index.ts:900-970`). Upstream's fallback silently substitutes a
   *different model* with no per-request user signal beyond a warning; Helm's
   contract keeps the user's baseline authoritative. Also conflicts in spirit
   with ADR-0002's "Neither selection source permits fallback."
2. **Session-long pinning with advisory-only monitoring.** Conflicts with the
   Routed Run scope contract ("every turn in the scope shares one Route" —
   but a new independent request starts a new scope; `CONTEXT.md` "Routed
   Run") and with the Baseline Checkpoint/restoration lifecycle that Helm's
   black-box suite certifies (`README.md` Testing strategy, item 2).
   Upstream's pin also intentionally outlives compaction and branch
   navigation (`index.ts:612-632`), which Helm's branch-aware per-run records
   deliberately do not.
3. **Multi-message conversation history as classification input.** Upstream
   sends up to 8 recent messages / 192 KB of unredacted conversation text per
   evaluation (`index.ts:129-150`; `README.md:102`: "Conversation text is
   not redacted and may contain secrets"). Helm's contract classifies "the
   current user message" (`classification-provider.ts` `classify(message)`);
   expanding the privacy surface to history is an unvalidated, contract-level
   change requiring its own decision, not a default import.
4. **Confidence-free acceptance of the routing judgment.** Upstream adopts the
   `choice` answer with no probability gating; its only threshold (0.8 for
   skills) is unjustified by any evidence. Helm's per-signal confidence +
   low-confidence fail-open is the corpus-tested behavior; removing or
   bypassing it would discard Helm's only quality guard for exactly the
   boundary case the gate shows to be fragile (`classification-v1/024`).
5. **Opt-in skill auto-loading.** Out of Helm's domain (model routing), sends
   skill names/descriptions to the gateway, injects up to 50 KB of skill text
   into context on a heuristic ≥ 0.8 probability, and has no quality
   validation (`index.ts:292-360`). Not a routing-quality lever.
6. **Synthetic `auto/jev` provider registration.** An implementation strategy
   entangled with pin semantics and Pi's model registry that cannot express
   Helm's Route Override, Routing Explanation, or baseline-restore contracts;
   Helm's Route Target application path is already lifecycle-tested.
7. **Global-settings-only configuration and the hardcoded price constant.**
   Global-only config contradicts Helm's project-config design without
   evidence either way; the `$0.042/M` input-only estimate should not be
   imported as a fact — if Helm reports classification cost, it should use
   returned usage on both token kinds, which the Jev envelope already
   validates.

## Evidence table

| # | Claim | Source (upstream at `24043d0` unless noted) |
| --- | --- | --- |
| E1 | Single `choice` question; criteria are route descriptions; answer adopted verbatim | `index.ts:439-448, 511-512` |
| E2 | Effort descriptions per thinking level (`AUTO_THINKING`) | `index.ts:39-48` |
| E3 | Default config: 2 routes, Astra fallback, 5 s timeout, monitor on, skills off | `index.ts:51-66` |
| E4 | Strict config validation; fallback must be listed; timeoutMs 1–60,000 | `index.ts:86-120` |
| E5 | Routing input: last user msg + ≤7 prior messages, 192 KB cap, SHA-256 key | `index.ts:129-150` |
| E6 | Chunking: ≤8 chunks, 128-char overlap, 2 parallel, newline alignment | `index.ts:159-190` |
| E7 | Anti-averaging combined-stage instruction | `index.ts:459-462` |
| E8 | No confidence gate on route choice; 0.8 probability gate for skills only | `index.ts:337-348, 511-512` |
| E9 | Fallback absorbs initial failures, oversized input, auxiliary requests; sanitized reasons | `index.ts:429-436, 514-523` |
| E10 | 3 timeout retries under shared 3×timeoutMs ceiling | `index.ts:24, 450-452, 484` |
| E11 | Pin-per-session; restored from session entries; suggestions once per alternative | `index.ts:530-538, 578-582, 612-632` |
| E12 | Monitoring dedupe by input key | `index.ts:403-405` |
| E13 | Per-decision metrics and `$0.042/M` input-only cost estimate | `index.ts:470-481, 528-530, 648-666` |
| E14 | Modality filtering of candidates | `index.ts:556` |
| E15 | Tests fully mocked; no paid requests; no corpus or accuracy data anywhere | `index.test.mjs:38-60`; `README.md` Development; repo file list |
| E16 | README self-describes chunking/skill probabilities as unvalidated heuristics | upstream `README.md:73-106` |
| E17 | Privacy surface: up to 8 messages/192 KB unredacted text to Vercel/TypeSafe | upstream `README.md:102` |
| E18 | Helm: 3 Boolean signals, `value = p ≥ 0.5`, `confidence = max(p, 1−p)` | `src/classification-provider.ts:57-72, 244-247` (this repo) |
| E19 | Helm: deterministic precedence policy + threshold fail-open | `src/routing-policy.ts:14-45` (this repo) |
| E20 | Helm: corpus 24 messages, 8 vectors, 4 boundaries, digest+template binding | `src/classification-corpus.ts:15-50`; `src/real-jev-gate.ts:180-215` (this repo) |
| E21 | Helm: gate constants 0.75 / 3 executions / 2-of-3; recorded runs 24/24 and 24/24 in 6 of 9 with `/024` variance | `src/real-jev-gate.ts:21-26, 117-177`; `README.md:65-68, 571-584` (this repo) |
| E22 | Helm: fail-open retains Baseline on every failure path | `src/index.ts:900-970`; `CONTEXT.md` "Routed Run", "Baseline Model" |
| E23 | Helm: single-attempt SDK guardrail (ADR-0003); no-fallback provider selection (ADR-0002) | `docs/adr/0003-*.md`; `docs/adr/0002-*.md` (this repo) |

## Ranked recommendations (for the Wayfinder map)

1. **Measure first:** add per-classification cost/latency/usage records with
   input-hash dedupe (E13's shape, Helm's privacy rules). Prerequisite for
   every quality comparison.
2. **Threshold sweep experiment** over the existing corpus/gate harness,
   centered on the `/024` boundary variance (E21). Cheapest genuine quality
   evidence available.
3. **Template-language experiment:** port the anti-averaging compound-union
   instruction (E7) as a new template version with a full corpus rerun.
4. **Modality check on Route Targets** with explicit fail-open (E14).
5. **Timeout-retry arm** only after an ADR revisits the ADR-0003
   single-attempt guardrail (E10 vs E23).
6. **Do not adopt:** fallback routes, session pinning, history-based
   classification, confidence-free choice acceptance, skill auto-loading, or
   the synthetic-provider strategy (§5).
