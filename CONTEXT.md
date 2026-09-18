# Pi Jev Helm

Pi Jev Helm is a Pi extension context for using Jev judgments to classify incoming tasks while keeping model selection explicit and configurable.

## Language

**Pi Jev Helm**:
The canonical project name for this extension and its repository.
_Avoid_: pi-jev-router, Pi Jev Router

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
The optional Helm behavior that classifies a new Routed Run and applies Routing Policy when no Route Override is pending. Disabling it leaves explicit Route Overrides available.
_Avoid_: Extension enabled, mandatory routing

**Route Override**:
A one-shot user selection of the Route for the next Routed Run. It bypasses Task Classification but still resolves through that Route's configured Route Target.
_Avoid_: Model override, persistent route

**Routing Explanation**:
A structured, user-visible account of how a Routed Run selected or retained its model, including the relevant Task Classification, policy evaluation, Route Target, overrides, and fail-open outcome. It is derived from recorded decisions rather than free-form model reasoning.
_Avoid_: Chain of thought, Jev rationale

**Routed Run**:
A routing scope that begins when a user message starts work from Pi's idle state and ends after all of that work's turns and queued continuations settle; every turn in the scope shares one Route.
_Avoid_: Idle prompt, single-message route

**Baseline Model**:
The Pi model and thinking level selected before a Routed Run. They are restored after it settles unless an Explicit Model Override supersedes them.
_Avoid_: Default model, fallback model

**Explicit Model Override**:
A model selection not initiated by Pi Jev Helm during an active Routed Run. It immediately supersedes the Route Target and becomes the new Baseline Model together with its effective thinking level.
_Avoid_: Route Override, thinking-level adjustment

**Explicit Thinking Override**:
A thinking-level change not initiated by Pi Jev Helm during an active Routed Run. It updates the thinking-level component restored with the existing Baseline model without promoting the Route Target model to the Baseline.
_Avoid_: Explicit Model Override, Route Override
