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
