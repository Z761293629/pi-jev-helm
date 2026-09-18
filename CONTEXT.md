# Pi Jev Helm

Pi Jev Helm is a Pi extension context for using Jev judgments to classify incoming tasks while keeping model selection explicit and configurable.

## Language

**Pi Jev Helm**:
The canonical project name for this extension and its repository.
_Avoid_: pi-jev-router, Pi Jev Router

**Task Classification**:
A structured, model-independent description of an incoming user task and the capabilities it requires.
_Avoid_: Model selection, route decision

**Route**:
A named capability class used to select a configured Pi model; it is not itself a concrete model.
_Avoid_: Model, provider

**Routing Policy**:
The deterministic rules that map a Task Classification to a Route and resolve that Route to configured model choices.
_Avoid_: Jev model choice, dynamic model selection

**Routed Run**:
A routing scope that begins when a user message starts work from Pi's idle state and ends after all of that work's turns and queued continuations settle; every turn in the scope shares one Route.
_Avoid_: Idle prompt, single-message route

**Baseline Model**:
The Pi model selected before a Routed Run and restored after it settles unless an explicit override supersedes it.
_Avoid_: Default model, fallback model
