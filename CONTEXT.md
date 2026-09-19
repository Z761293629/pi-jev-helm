# Pi Jev Helm

Pi Jev Helm is a Pi extension context for using Jev judgments to classify incoming tasks and assess completion evidence while keeping model selection and control flow explicit and configurable.

## Language

**Pi Jev Helm**:
The canonical project name for this extension and its repository.
_Avoid_: pi-jev-router, Pi Jev Router

**Public Preview**:
An externally installable pre-stable release of Pi Jev Helm. Within one minor release line, patch releases preserve the user-facing configuration schema and command grammar; breaking changes require a new minor version and migration notes. Support is best-effort rather than subject to a response-time commitment.
_Avoid_: Stable release, private build

**Task Classification**:
A structured, model-independent description of every capability required to complete an incoming user task. For a compound request, it preserves the union of required capabilities rather than only the dominant intent.
_Avoid_: Model selection, route decision

**Classification Provider**:
An adapter that classifies the current user message and returns a Task Classification. It hides vendor-specific evaluation protocols and never chooses a Route or applies Routing Policy confidence thresholds.
_Avoid_: Provider, router

**Capability Signal**:
An independent Boolean judgment in a Task Classification, paired with confidence that the judgment is correct. V1 uses `codeWork`, `deepReasoning`, and `externalResearch`.
_Avoid_: Task type, route label

**Code Work**:
Work that requires reading, writing, modifying, debugging, or reviewing source code or code-engineering artifacts. General software knowledge does not qualify by itself.
_Avoid_: Software topic

**Deep Reasoning**:
Work whose quality depends on multi-step inference, constraint trade-offs, proof, diagnosis, or non-obvious planning. Length and requested detail do not qualify by themselves.
_Avoid_: Long answer, complex wording

**External Research**:
Work that requires retrieving or verifying external evidence, documentation, or time-sensitive facts beyond the current request. Local repository exploration and stable general knowledge do not qualify by themselves.
_Avoid_: Local code search, ordinary recall

**Route**:
A named capability class used to select a configured Pi model; it is not itself a concrete model.
_Avoid_: Model, provider

**Routing Policy**:
The deterministic rules that map a Task Classification to a Route and resolve that Route to configured model choices.
_Avoid_: Jev model choice, dynamic model selection

**Route Target**:
The user-configured binding from one Route to a Pi provider, model, and thinking level. All four standard Routes have exactly one Route Target.
_Avoid_: Route, default model

**Automatic Routing**:
The optional Helm behavior that classifies a new Helm Run and applies Routing Policy when no Route Override is pending, making that Helm Run a Routed Run. Disabling it leaves explicit Route Overrides available.
_Avoid_: Extension enabled, mandatory routing

**Route Override**:
A one-shot user selection of the Route for the next Helm Run. It bypasses Task Classification but still resolves through that Route's configured Route Target, making the Helm Run a Routed Run.
_Avoid_: Model override, persistent route

**Routing Explanation**:
A structured, user-visible account of how a Routed Run selected or retained its model, including the relevant Task Classification, policy evaluation, Route Target, overrides, and fail-open outcome. It is derived from recorded decisions rather than free-form model reasoning.
_Avoid_: Chain of thought, Jev rationale

**Helm Run**:
A lifecycle scope that begins when genuine user input starts work from Pi's idle state and ends after all of that work's turns, retries, compaction retries, and queued continuations settle. It exists independently of whether routing or verification is enabled.
_Avoid_: Conversation, low-level agent run

**Routed Run**:
A Helm Run for which Automatic Routing or a Route Override attempts to select a Route. Its turns share the selected Route Target, or the retained Baseline Model when routing fails open.
_Avoid_: Helm Run, single-message route

**Helm Run Record**:
A minimal, branch-aware record of a Helm Run's identity, boundaries, and settlement status. It contains no copied message or tool content and supplies the shared identifier used by routing and verification records.
_Avoid_: Verification Record, conversation snapshot

**Baseline Model**:
The Pi model and thinking level selected before a Routed Run. They are restored after it settles unless an Explicit Model Override supersedes them.
_Avoid_: Default model, fallback model

**Baseline Checkpoint**:
A versioned, non-context session record of the latest Baseline Model while temporary routing is active. It remains incomplete until restoration succeeds and supports recovery after ordinary lifecycle interruption.
_Avoid_: Route Target snapshot, global default

**Explicit Model Override**:
A model selection not initiated by Pi Jev Helm during an active Routed Run. It immediately supersedes the Route Target and becomes the new Baseline Model together with its effective thinking level.
_Avoid_: Route Override, thinking-level adjustment

**Explicit Thinking Override**:
A thinking-level change not initiated by Pi Jev Helm during an active Routed Run. It updates the thinking-level component restored with the existing Baseline model without promoting the Route Target model to the Baseline.
_Avoid_: Explicit Model Override, Route Override

**Completion Verification**:
An optional Helm assessment of whether the available evidence is sufficient to stop work on a Helm Run. It considers coverage of the user's explicit request, verification evidence, and unresolved errors; it does not claim to prove that the result is correct.
_Avoid_: Correctness proof, completion score

**Shadow Verification**:
Completion Verification that records and presents its Completion Disposition without continuing, blocking, or otherwise changing the Helm Run. It is evidence for evaluating the verifier itself, not authority over the agent or a security control.
_Avoid_: Completion gate, automatic retry

**Run Request**:
The ordered set of genuine user inputs that belong to one Helm Run: its initial idle prompt and any user-authored steer or follow-up added before settlement. It excludes extension-generated custom messages and internal continuation instructions.
_Avoid_: Initial prompt, conversation transcript

**Completion Evidence**:
The bounded, privacy-conscious facts supplied to Completion Verification: the Run Request, the final response, and only deterministically selected tool identities, outcomes, and sanitized evidence needed to assess stopping. Unknown tools contribute identity and outcome metadata only; evidence that cannot be safely extracted is marked unavailable rather than replaced with raw content. It excludes the full Helm Run transcript and source-file contents.
_Avoid_: Full conversation, verifier context

**Completion Disposition**:
The direct mutually exclusive Jev Choice of `complete`, `continue`, `blocked`, or `inconclusive` for a Helm Run. It distinguishes completed work, established agent-actionable unfinished work, work waiting on user or external action, and evidence that cannot establish which of the other states applies; it is not a correctness score or model explanation.
_Avoid_: Verification Outcome, completion probability, quality score

**Verification Record**:
A compact, branch-aware, non-context record of one Completion Verification linked to its Helm Run Record. It preserves the raw and confidence-routed Completion Disposition plus safe evaluation metadata without copying Completion Evidence.
_Avoid_: Verification log, Routing Explanation

**Verification Feedback**:
A local, explicit user label of `agree`, `disagree`, or `unsure` linked to the latest Verification Record on the active conversation branch. It is never uploaded automatically; sanitized feedback leaves the session only through a separate user-requested export.
_Avoid_: Telemetry, correctness label

**Verification Export**:
A user-requested JSONL export of Verification Records and Verification Feedback from the active conversation branch to an explicit output path. It contains policy and template versions, raw and confidence-routed dispositions, confidence, labels, latency, and safe failure categories, but no Completion Evidence or other original content.
_Avoid_: Telemetry upload, session export

**Automatic Verification**:
The optional Helm behavior that performs Completion Verification after every normally settled Helm Run. Cancelled or interrupted runs and runs without a final response are skipped rather than judged from incomplete evidence.
_Avoid_: Automatic Routing, completion gate

**Manual Verification**:
A user-requested Completion Verification of the latest eligible Helm Run on the active conversation branch. It remains available while Automatic Verification is off and represents explicit consent for that external request.
_Avoid_: Automatic Verification, retry

**Verification Provider**:
An adapter that evaluates Completion Evidence and returns one direct Completion Disposition Choice with confidence. It hides the external Jev protocol and never changes Helm Run control flow or composes an explanation from separate judgments.
_Avoid_: Classification Provider, completion gate

**Verification Confidence Policy**:
The deterministic rule that accepts a direct Completion Disposition only at or above its calibrated confidence threshold and otherwise routes it to `inconclusive`. Provider and protocol failures do not produce a Completion Disposition.
_Avoid_: Verification score, signal thresholds

**Continuation Draft**:
An unsent, user-editable prompt Helm offers after a confident `continue` disposition so the user can ask the agent to complete remaining work. It may fill an empty Pi editor after settlement, but it never overwrites user text, sends itself, starts a Turn, or appears for `complete`, `blocked`, or `inconclusive`.
_Avoid_: Automatic retry, follow-up, nudge, continuation message
