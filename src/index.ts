import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
  OpenRouterJevClassificationProvider,
  CAPABILITY_SIGNAL_NAMES,
  type CapabilitySignalName,
  type ClassificationProvider,
  type TaskClassificationV1,
} from "./classification-provider.js";
import { loadHelmConfig, type ConfigLoadResult, type Route, type RouteTarget, ROUTES } from "./config.js";
import { selectRoute, type RoutingPolicyResult } from "./routing-policy.js";
import {
  formatRoutingExplanation,
  formatSource,
  recordRoutingExplanation,
  ROUTING_EXPLANATION_SCHEMA_VERSION,
  selectBranchRoutingExplanation,
  type AttemptClassification,
  type ExplainedConfidenceCheck,
  type ExplainedFailOpen,
  type ExplainedModelWithThinking,
  type ExplainedSignal,
  type ExplanationAttempt,
  type FailOpenReason,
  type RoutingAttemptExplanation,
} from "./routing-explanation.js";

const HELM_COMMANDS = ["auto", "route", "why"] as const;
const CHECKPOINT_ENTRY_TYPE = "pi-jev-helm-baseline-checkpoint";
const CHECKPOINT_SCHEMA_VERSION = 1;

type PiModel = NonNullable<ExtensionContext["model"]>;
type PiThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;

type TrackedBaseline = {
  baselineModel: PiModel;
  baselineThinkingLevel: PiThinkingLevel;
  checkpointId: string;
  helmSelectedModel: PiModel;
};

type ActiveRoutedRun = TrackedBaseline & { route: Route };

type CheckpointStatus = "pending" | "restoration_failed" | "complete";

type BaselineCheckpoint = {
  schemaVersion: typeof CHECKPOINT_SCHEMA_VERSION;
  checkpointId: string;
  status: CheckpointStatus;
  baseline: {
    provider: string;
    model: string;
    thinkingLevel: PiThinkingLevel;
  };
};

const THINKING_LEVELS: readonly PiThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

type RouteTargetAttempt = ExplanationAttempt & {
  route: Route;
  cancellationRevision: number;
};

type AttemptExplanationDetails =
  | {
      outcome: "routed";
      route: Route;
      target: ExplainedModelWithThinking;
      restorationRequired: boolean;
    }
  | {
      outcome: "fail-open";
      route?: Route;
      target?: ExplainedModelWithThinking;
      failOpen: ExplainedFailOpen;
      restorationRequired: boolean;
    };

type HelmModelSelectionOperation = {
  kind: "model";
  target: PiModel;
  thinkingClampPending: boolean;
};

type HelmThinkingSelectionOperation = {
  kind: "thinking";
  target: PiThinkingLevel;
};

const helmSelectionOperation = new AsyncLocalStorage<
  HelmModelSelectionOperation | HelmThinkingSelectionOperation
>();

interface HelmState {
  configuration: ConfigLoadResult;
  automaticRoutingOverride: boolean | undefined;
  pendingRouteOverride: Route | undefined;
  pendingIdleUserMessage: string | undefined;
  routingAttemptedForCurrentRun: boolean;
  activeRoutedRun: ActiveRoutedRun | undefined;
  pendingRouteTargetApplication: ActiveRoutedRun | undefined;
  pendingBaselineRestoration: TrackedBaseline | undefined;
  baselineRestorationInFlight: TrackedBaseline | undefined;
  pendingCheckpointRecovery: BaselineCheckpoint | undefined;
  checkpointRecoverySelectedModel: PiModel | undefined;
  routeTargetApplicationRevision: number;
  helmModelSelection: HelmModelSelectionOperation | undefined;
  helmThinkingSelection: HelmThinkingSelectionOperation | undefined;
}

function initialConfiguration(): ConfigLoadResult {
  return {
    ok: false,
    path: "",
    errors: ["configuration has not been loaded"],
  };
}

function effectiveAutomaticRouting(state: HelmState): boolean {
  if (!state.configuration.ok) return false;
  return state.automaticRoutingOverride ?? state.configuration.config.automaticRouting;
}

function formatBaselineModel(ctx: ExtensionContext): string {
  return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unavailable";
}

function formatConfigurationHealth(state: HelmState): string[] {
  if (state.configuration.ok) {
    const configured = state.configuration.config.automaticRouting ? "on" : "off";
    const effective = effectiveAutomaticRouting(state) ? "on" : "off";
    const sessionOverride =
      state.automaticRoutingOverride === undefined ? "none" : state.automaticRoutingOverride ? "on" : "off";

    return [
      "Configuration: healthy",
      `Configuration file: ${state.configuration.path}`,
      `Automatic Routing (configured): ${configured}`,
      `Automatic Routing (session): ${effective}`,
      `Session override: ${sessionOverride}`,
      `Confidence threshold: ${state.configuration.config.confidenceThreshold}`,
    ];
  }

  return [
    "Configuration: unhealthy",
    `Configuration file: ${state.configuration.path || "unresolved"}`,
    "Automatic Routing (configured): unavailable",
    "Automatic Routing (session): off",
    "Session override: none",
    ...state.configuration.errors.map((error) => `Configuration error: ${error}`),
  ];
}

function formatStatus(state: HelmState, ctx: ExtensionContext): string {
  const routedRun = state.activeRoutedRun ?? state.pendingBaselineRestoration;
  const baselineModel = routedRun
    ? `${routedRun.baselineModel.provider}/${routedRun.baselineModel.id}`
    : formatBaselineModel(ctx);

  return [
    "Pi Jev Helm",
    ...formatConfigurationHealth(state),
    "Routing capability: Automatic Routing and Route Override",
    `Pending Route Override: ${state.pendingRouteOverride ?? "none"}`,
    `Current or recent Route: ${state.activeRoutedRun?.route ?? "none"}`,
    `Baseline Model: ${baselineModel}`,
  ].join("\n");
}

function configurationError(state: HelmState, action: string): string {
  const detail = state.configuration.ok ? "" : `: ${state.configuration.errors.join("; ")}`;
  return `Pi Jev Helm cannot ${action} while configuration is unhealthy${detail}`;
}

function completions(argumentPrefix: string): Array<{ value: string; label: string }> | null {
  let candidates: string[];
  if (argumentPrefix.startsWith("auto ")) {
    candidates = ["auto on", "auto off"];
  } else if (argumentPrefix.startsWith("route ")) {
    candidates = ROUTES.map((route) => `route ${route}`).concat("route clear");
  } else if (!argumentPrefix.includes(" ")) {
    candidates = [...HELM_COMMANDS];
  } else {
    return null;
  }

  const matches = candidates.filter((candidate) => candidate.startsWith(argumentPrefix));
  return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
}

function isExactModel(model: PiModel, provider: string, id: string): boolean {
  return model.provider === provider && model.id === id;
}

function isModelInScope(ctx: ExtensionContext, model: PiModel): boolean {
  return (
    ctx.scopedModels.length === 0 ||
    ctx.scopedModels.some((scoped) => isExactModel(scoped.model, model.provider, model.id))
  );
}

function explainedSignals(classification: TaskClassificationV1): ExplainedSignal[] {
  return CAPABILITY_SIGNAL_NAMES.map((name) => ({
    name,
    value: classification.signals[name].value,
    confidence: classification.signals[name].confidence,
  }));
}

function confidenceCheck(
  threshold: number,
  relevantSignals: readonly CapabilitySignalName[],
  failedSignals: readonly CapabilitySignalName[],
): ExplainedConfidenceCheck {
  return { threshold, relevantSignals: [...relevantSignals], failedSignals: [...failedSignals] };
}

function trackedBaselineRef(run: TrackedBaseline): ExplainedModelWithThinking {
  return {
    provider: run.baselineModel.provider,
    model: run.baselineModel.id,
    thinkingLevel: run.baselineThinkingLevel,
  };
}

function recordAttemptExplanation(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  attempt: ExplanationAttempt,
  run: TrackedBaseline | undefined,
  details: AttemptExplanationDetails,
): void {
  const baseline: ExplainedModelWithThinking | undefined = run
    ? trackedBaselineRef(run)
    : ctx.model
      ? {
          provider: ctx.model.provider,
          model: ctx.model.id,
          thinkingLevel: pi.getThinkingLevel(),
        }
      : undefined;
  const shared: Pick<
    RoutingAttemptExplanation,
    | "schemaVersion"
    | "kind"
    | "runId"
    | "source"
    | "signals"
    | "confidenceCheck"
    | "policyBranch"
    | "baseline"
    | "appliedModel"
    | "appliedThinkingLevel"
    | "restorationRequired"
  > = {
    schemaVersion: ROUTING_EXPLANATION_SCHEMA_VERSION,
    kind: "routing-attempt",
    runId: attempt.runId,
    source: attempt.source,
    ...(attempt.classification?.signals.length
      ? { signals: attempt.classification.signals }
      : {}),
    ...(attempt.classification?.confidenceCheck
      ? { confidenceCheck: attempt.classification.confidenceCheck }
      : {}),
    ...(attempt.classification?.policyBranch
      ? { policyBranch: attempt.classification.policyBranch }
      : {}),
    ...(baseline ? { baseline } : {}),
    ...(ctx.model
      ? { appliedModel: { provider: ctx.model.provider, model: ctx.model.id } }
      : {}),
    appliedThinkingLevel: pi.getThinkingLevel(),
    restorationRequired: details.restorationRequired,
  };
  const entry: RoutingAttemptExplanation =
    details.outcome === "routed"
      ? { ...shared, outcome: "routed", route: details.route, target: details.target }
      : {
          ...shared,
          outcome: "fail-open" as const,
          ...(details.route ? { route: details.route } : {}),
          ...(details.target ? { target: details.target } : {}),
          failOpen: details.failOpen,
        };
  recordRoutingExplanation(pi, entry);
}

function notifyRoutingFailure(ctx: ExtensionContext, message: string): void {
  if (ctx.mode === "tui") ctx.ui.notify(message, "warning");
}

function isBaselineCheckpoint(value: unknown): value is BaselineCheckpoint {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<BaselineCheckpoint>;
  const baseline = candidate.baseline as Partial<BaselineCheckpoint["baseline"]> | undefined;
  return (
    candidate.schemaVersion === CHECKPOINT_SCHEMA_VERSION &&
    typeof candidate.checkpointId === "string" &&
    candidate.checkpointId.length > 0 &&
    (candidate.status === "pending" ||
      candidate.status === "restoration_failed" ||
      candidate.status === "complete") &&
    typeof baseline === "object" &&
    baseline !== null &&
    typeof baseline.provider === "string" &&
    baseline.provider.length > 0 &&
    typeof baseline.model === "string" &&
    baseline.model.length > 0 &&
    THINKING_LEVELS.includes(baseline.thinkingLevel as PiThinkingLevel)
  );
}

function latestIncompleteCheckpoint(ctx: ExtensionContext): BaselineCheckpoint | undefined {
  const branch = ctx.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry?.type !== "custom" || entry.customType !== CHECKPOINT_ENTRY_TYPE) continue;
    if (!isBaselineCheckpoint(entry.data) || entry.data.status === "complete") return undefined;
    return entry.data;
  }
  return undefined;
}

function appendCheckpointData(pi: ExtensionAPI, checkpoint: BaselineCheckpoint): void {
  pi.appendEntry(CHECKPOINT_ENTRY_TYPE, checkpoint);
}

function checkpointData(
  run: TrackedBaseline,
  status: CheckpointStatus,
): BaselineCheckpoint {
  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    checkpointId: run.checkpointId,
    status,
    baseline: {
      provider: run.baselineModel.provider,
      model: run.baselineModel.id,
      thinkingLevel: run.baselineThinkingLevel,
    },
  };
}

function appendCheckpoint(
  pi: ExtensionAPI,
  run: TrackedBaseline,
  status: CheckpointStatus,
): void {
  appendCheckpointData(pi, checkpointData(run, status));
}

async function selectModelFromHelm(
  pi: ExtensionAPI,
  state: HelmState,
  model: PiModel,
): Promise<boolean> {
  const operation: HelmModelSelectionOperation = {
    kind: "model",
    target: model,
    thinkingClampPending: true,
  };
  state.helmModelSelection = operation;
  try {
    return await helmSelectionOperation.run(operation, () => pi.setModel(model));
  } finally {
    if (state.helmModelSelection === operation) state.helmModelSelection = undefined;
  }
}

function selectThinkingLevelFromHelm(
  pi: ExtensionAPI,
  state: HelmState,
  level: ReturnType<ExtensionAPI["getThinkingLevel"]>,
): void {
  const operation: HelmThinkingSelectionOperation = { kind: "thinking", target: level };
  state.helmThinkingSelection = operation;
  try {
    helmSelectionOperation.run(operation, () => pi.setThinkingLevel(level));
    operation.target = pi.getThinkingLevel();
  } finally {
    if (state.helmThinkingSelection === operation) state.helmThinkingSelection = undefined;
  }
}

async function restoreBaseline(
  pi: ExtensionAPI,
  run: TrackedBaseline,
  ctx: ExtensionContext,
  state: HelmState,
): Promise<boolean> {
  for (;;) {
    state.pendingBaselineRestoration = run;
    const restorationRevision = state.routeTargetApplicationRevision;
    const baselineModel = run.baselineModel;
    let modelRestored = false;
    try {
      modelRestored =
        (await selectModelFromHelm(pi, state, baselineModel)) &&
        !!ctx.model &&
        isExactModel(ctx.model, baselineModel.provider, baselineModel.id);
    } catch {
      modelRestored = false;
    }
    if (state.routeTargetApplicationRevision !== restorationRevision) continue;
    if (!modelRestored) {
      notifyRoutingFailure(ctx, "Pi Jev Helm could not restore the Baseline Model");
    }

    let thinkingRestored = false;
    try {
      selectThinkingLevelFromHelm(pi, state, run.baselineThinkingLevel);
      thinkingRestored = true;
    } catch {
      thinkingRestored = false;
    }
    if (state.routeTargetApplicationRevision !== restorationRevision) continue;
    if (!thinkingRestored) {
      notifyRoutingFailure(ctx, "Pi Jev Helm could not restore the Baseline thinking level");
    } else if (modelRestored) {
      run.baselineThinkingLevel = pi.getThinkingLevel();
    }

    return modelRestored && thinkingRestored;
  }
}

type RestorationOptions = {
  /** Keep the run pending for a later retry when restoration fails. */
  retainFailedRestoration: boolean;
  /** Record the run's restoration outcome as a Routing Explanation entry. */
  recordRestorationEntry: boolean;
};

async function restoreTrackedBaseline(
  pi: ExtensionAPI,
  run: TrackedBaseline,
  ctx: ExtensionContext,
  state: HelmState,
  options: RestorationOptions,
): Promise<boolean> {
  state.pendingBaselineRestoration = run;
  state.baselineRestorationInFlight = run;
  let restored: boolean;
  try {
    restored = await restoreBaseline(pi, run, ctx, state);
  } finally {
    if (state.baselineRestorationInFlight === run) state.baselineRestorationInFlight = undefined;
  }
  let checkpointRecorded = true;
  try {
    appendCheckpoint(pi, run, restored ? "complete" : "restoration_failed");
  } catch {
    checkpointRecorded = false;
    if (restored) {
      restored = false;
      notifyRoutingFailure(ctx, "Pi Jev Helm restored the Baseline but could not complete its checkpoint");
    } else {
      notifyRoutingFailure(ctx, "Pi Jev Helm could not record the checkpoint restoration failure");
    }
  }
  if (options.recordRestorationEntry) {
    recordRoutingExplanation(pi, {
      schemaVersion: ROUTING_EXPLANATION_SCHEMA_VERSION,
      kind: "restoration",
      runId: run.checkpointId,
      outcome: restored ? "restored" : "failed",
      ...(restored ? { baseline: trackedBaselineRef(run) } : {}),
    });
  }
  if (restored || (!options.retainFailedRestoration && checkpointRecorded)) {
    if (state.pendingBaselineRestoration === run) state.pendingBaselineRestoration = undefined;
  } else {
    state.pendingBaselineRestoration = run;
  }
  return restored;
}

async function recoverCheckpoint(
  pi: ExtensionAPI,
  checkpoint: BaselineCheckpoint,
  ctx: ExtensionContext,
  state: HelmState,
): Promise<boolean> {
  let model: PiModel | undefined;
  try {
    model = ctx.modelRegistry.find(checkpoint.baseline.provider, checkpoint.baseline.model);
  } catch {
    model = undefined;
  }
  if (
    !model ||
    !isExactModel(model, checkpoint.baseline.provider, checkpoint.baseline.model)
  ) {
    const failedCheckpoint: BaselineCheckpoint = {
      ...checkpoint,
      status: "restoration_failed",
    };
    state.pendingCheckpointRecovery = failedCheckpoint;
    try {
      appendCheckpointData(pi, failedCheckpoint);
    } catch {
      notifyRoutingFailure(ctx, "Pi Jev Helm could not record the checkpoint restoration failure");
    }
    notifyRoutingFailure(ctx, "Pi Jev Helm could not resolve the checkpoint Baseline Model");
    return false;
  }

  const run: TrackedBaseline = {
    baselineModel: model,
    baselineThinkingLevel: checkpoint.baseline.thinkingLevel,
    checkpointId: checkpoint.checkpointId,
    helmSelectedModel: ctx.model ?? model,
  };
  return restoreTrackedBaseline(pi, run, ctx, state, { retainFailedRestoration: true, recordRestorationEntry: true });
}

async function attemptCheckpointRecovery(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: HelmState,
): Promise<boolean> {
  const checkpoint = state.pendingCheckpointRecovery;
  if (!checkpoint) return true;

  const recovered = await recoverCheckpoint(pi, checkpoint, ctx, state);
  if (recovered || state.pendingBaselineRestoration) {
    state.pendingCheckpointRecovery = undefined;
    state.checkpointRecoverySelectedModel = undefined;
  }
  return recovered;
}

async function failAfterRouteTargetApplication(
  pi: ExtensionAPI,
  run: ActiveRoutedRun,
  attempt: ExplanationAttempt,
  ctx: ExtensionContext,
  state: HelmState,
  reason: FailOpenReason,
  message: string,
): Promise<void> {
  state.pendingRouteTargetApplication = undefined;
  const restored = await restoreTrackedBaseline(pi, run, ctx, state, { retainFailedRestoration: true, recordRestorationEntry: false });
  recordAttemptExplanation(pi, ctx, attempt, run, {
    outcome: "fail-open",
    route: run.route,
    failOpen: { reason, baselineRetained: restored },
    restorationRequired: true,
  });
  notifyRoutingFailure(ctx, message);
}

async function finishRoutedRun(
  pi: ExtensionAPI,
  state: HelmState,
  ctx: ExtensionContext,
  retainFailedRestoration: boolean,
): Promise<boolean> {
  const run = state.activeRoutedRun ?? state.pendingBaselineRestoration;
  state.activeRoutedRun = undefined;
  if (!run) return true;

  return restoreTrackedBaseline(pi, run, ctx, state, { retainFailedRestoration, recordRestorationEntry: true });
}

async function prepareForNewWork(
  pi: ExtensionAPI,
  state: HelmState,
  ctx: ExtensionContext,
): Promise<boolean> {
  if (!(await attemptCheckpointRecovery(pi, ctx, state))) return false;
  if (state.pendingBaselineRestoration) {
    return finishRoutedRun(pi, state, ctx, true);
  }
  return true;
}

function findExactScopedModel(ctx: ExtensionContext, target: RouteTarget): PiModel | undefined {
  try {
    const model = ctx.modelRegistry.find(target.provider, target.model);
    if (!model || !isExactModel(model, target.provider, target.model) || !isModelInScope(ctx, model)) {
      return undefined;
    }
    return model;
  } catch {
    return undefined;
  }
}

async function beginRoutedRun(
  pi: ExtensionAPI,
  attempt: RouteTargetAttempt,
  ctx: ExtensionContext,
  state: HelmState,
): Promise<void> {
  if (!state.configuration.ok) return;
  const { route, cancellationRevision, runId } = attempt;
  const sourceLabel = formatSource(attempt.source);
  if (state.routeTargetApplicationRevision !== cancellationRevision) {
    recordAttemptExplanation(pi, ctx, attempt, undefined, {
      outcome: "fail-open",
      route,
      failOpen: { reason: "superseded-by-explicit-choice", baselineRetained: true },
      restorationRequired: false,
    });
    return;
  }
  if (!ctx.model) {
    recordAttemptExplanation(pi, ctx, attempt, undefined, {
      outcome: "fail-open",
      route,
      failOpen: { reason: "baseline-unavailable", baselineRetained: false },
      restorationRequired: false,
    });
    notifyRoutingFailure(ctx, `${sourceLabel} ${route} could not capture the Baseline Model`);
    return;
  }

  const run: ActiveRoutedRun = {
    route,
    baselineModel: ctx.model,
    baselineThinkingLevel: pi.getThinkingLevel(),
    checkpointId: runId,
    helmSelectedModel: ctx.model,
  };
  const target = state.configuration.config.routes[route];
  const model = findExactScopedModel(ctx, target);
  if (!model) {
    recordAttemptExplanation(pi, ctx, attempt, run, {
      outcome: "fail-open",
      route,
      failOpen: { reason: "target-unavailable", baselineRetained: true },
      restorationRequired: false,
    });
    notifyRoutingFailure(ctx, `${sourceLabel} ${route} Route Target is unavailable`);
    return;
  }

  run.helmSelectedModel = model;
  const targetExplanation: ExplainedModelWithThinking = {
    provider: target.provider,
    model: target.model,
    thinkingLevel: target.thinkingLevel,
  };
  state.pendingRouteTargetApplication = run;
  try {
    appendCheckpoint(pi, run, "pending");
  } catch {
    state.pendingRouteTargetApplication = undefined;
    recordAttemptExplanation(pi, ctx, attempt, run, {
      outcome: "fail-open",
      route,
      failOpen: { reason: "checkpoint-unavailable", baselineRetained: true },
      restorationRequired: false,
    });
    notifyRoutingFailure(ctx, `${sourceLabel} ${route} could not store the Baseline checkpoint`);
    return;
  }
  try {
    const modelSelected = await selectModelFromHelm(pi, state, model);
    if (state.routeTargetApplicationRevision !== cancellationRevision) {
      state.pendingRouteTargetApplication = undefined;
      const restored = await restoreTrackedBaseline(pi, run, ctx, state, { retainFailedRestoration: true, recordRestorationEntry: false });
      recordAttemptExplanation(pi, ctx, attempt, run, {
        outcome: "fail-open",
        route,
        failOpen: { reason: "superseded-by-explicit-choice", baselineRetained: restored },
        restorationRequired: true,
      });
      return;
    }
    if (!modelSelected) {
      await failAfterRouteTargetApplication(
        pi,
        run,
        attempt,
        ctx,
        state,
        "target-unavailable",
        `${sourceLabel} ${route} Route Target is unavailable`,
      );
      return;
    }
    if (!ctx.model || !isExactModel(ctx.model, target.provider, target.model)) {
      await failAfterRouteTargetApplication(
        pi,
        run,
        attempt,
        ctx,
        state,
        "target-apply-failed",
        `${sourceLabel} ${route} Route Target could not be applied exactly`,
      );
      return;
    }

    selectThinkingLevelFromHelm(pi, state, target.thinkingLevel);
    if (pi.getThinkingLevel() !== target.thinkingLevel) {
      await failAfterRouteTargetApplication(
        pi,
        run,
        attempt,
        ctx,
        state,
        "target-thinking-apply-failed",
        `${sourceLabel} ${route} Route Target thinking level could not be applied`,
      );
      return;
    }

    state.pendingRouteTargetApplication = undefined;
    state.activeRoutedRun = run;
    recordAttemptExplanation(pi, ctx, attempt, run, {
      outcome: "routed",
      route,
      target: targetExplanation,
      restorationRequired: true,
    });
  } catch {
    await failAfterRouteTargetApplication(
      pi,
      run,
      attempt,
      ctx,
      state,
      "target-apply-failed",
      `${sourceLabel} ${route} Route Target could not be applied`,
    );
  }
}

async function createClassificationProvider(
  ctx: ExtensionContext,
): Promise<ClassificationProvider | undefined> {
  const apiKey = await ctx.modelRegistry.getApiKeyForProvider("openrouter");
  return apiKey ? new OpenRouterJevClassificationProvider({ apiKey }) : undefined;
}

async function beginAutomaticRouting(
  pi: ExtensionAPI,
  prompt: string,
  ctx: ExtensionContext,
  state: HelmState,
): Promise<void> {
  if (!state.configuration.ok) return;
  const cancellationRevision = state.routeTargetApplicationRevision;
  const runId = randomUUID();
  const attempt: ExplanationAttempt = { runId, source: "automatic" };
  let attemptRecorded = false;
  const recordFailOpen = (failOpen: ExplainedFailOpen, classification?: AttemptClassification): void => {
    attemptRecorded = true;
    recordAttemptExplanation(pi, ctx, { ...attempt, ...(classification ? { classification } : {}) }, undefined, {
      outcome: "fail-open",
      failOpen,
      restorationRequired: false,
    });
  };

  try {
    const classificationProvider = await createClassificationProvider(ctx);
    if (state.routeTargetApplicationRevision !== cancellationRevision) return;
    if (!classificationProvider) {
      recordFailOpen({ reason: "provider-unavailable", baselineRetained: true });
      notifyRoutingFailure(ctx, "Automatic Routing could not authenticate the Classification Provider");
      return;
    }

    const result = await classificationProvider.classify(
      prompt,
      ctx.signal ? { signal: ctx.signal } : undefined,
    );
    if (!result.ok) {
      const aborted = result.failure.kind === "aborted";
      recordFailOpen({
        reason: aborted ? "classification-aborted" : "classification-failed",
        baselineRetained: true,
        ...(aborted
          ? {}
          : {
              classification: {
                kind: result.failure.kind,
                ...(result.failure.status === undefined ? {} : { status: result.failure.status }),
              },
            }),
      });
      if (!aborted) {
        notifyRoutingFailure(ctx, "Automatic Routing classification failed");
      }
      return;
    }
    const decision = selectRoute(
      result.classification,
      state.configuration.config.confidenceThreshold,
    );
    if (state.routeTargetApplicationRevision !== cancellationRevision) {
      recordFailOpen(
        { reason: "superseded-by-explicit-choice", baselineRetained: true },
        automaticClassificationDetails(state, result.classification, decision),
      );
      return;
    }
    if (!decision.ok) {
      recordFailOpen(
        { reason: "low-confidence", baselineRetained: true },
        automaticClassificationDetails(state, result.classification, decision),
      );
      return;
    }

    await beginRoutedRun(
      pi,
      {
        route: decision.route,
        source: "automatic",
        cancellationRevision,
        runId,
        classification: automaticClassificationDetails(state, result.classification, decision),
      },
      ctx,
      state,
    );
  } catch {
    if (!attemptRecorded) {
      recordFailOpen({ reason: "unexpected-error", baselineRetained: true });
    }
    notifyRoutingFailure(ctx, "Automatic Routing classification failed");
  }
}

function automaticClassificationDetails(
  state: HelmState,
  classification: TaskClassificationV1,
  decision: RoutingPolicyResult,
): AttemptClassification {
  if (!state.configuration.ok) {
    return { signals: explainedSignals(classification) };
  }
  const threshold = state.configuration.config.confidenceThreshold;
  if (decision.ok) {
    return {
      signals: explainedSignals(classification),
      confidenceCheck: confidenceCheck(threshold, decision.relevantSignals, []),
      policyBranch: { candidateRoute: decision.route },
    };
  }
  return {
    signals: explainedSignals(classification),
    confidenceCheck: confidenceCheck(
      threshold,
      decision.relevantSignals,
      decision.lowConfidenceSignals,
    ),
    policyBranch: { candidateRoute: decision.candidateRoute },
  };
}

function notifyInvalidUsage(ctx: ExtensionCommandContext): void {
  ctx.ui.notify(
    "Usage: /helm | /helm auto on|off | /helm route fast|coding|reasoning|research|clear | /helm why",
    "warning",
  );
}

async function handleWhyCommand(ctx: ExtensionCommandContext): Promise<void> {
  const explanation = selectBranchRoutingExplanation(ctx.sessionManager.getBranch());
  ctx.ui.notify(
    explanation
      ? formatRoutingExplanation(explanation)
      : "Pi Jev Helm has no Routing Explanation recorded on the active branch.",
    "info",
  );
}

async function handleCommand(args: string, ctx: ExtensionCommandContext, state: HelmState): Promise<void> {
  const tokens = args.trim().length === 0 ? [] : args.trim().split(/\s+/);
  if (tokens.length === 0) {
    ctx.ui.notify(formatStatus(state, ctx), "info");
    return;
  }

  if (tokens[0] === "why" && tokens.length === 1) {
    await handleWhyCommand(ctx);
    return;
  }

  if (tokens[0] === "auto" && tokens.length === 2 && (tokens[1] === "on" || tokens[1] === "off")) {
    const enabled = tokens[1] === "on";
    if (enabled && !state.configuration.ok) {
      ctx.ui.notify(configurationError(state, "enable Automatic Routing"), "error");
      return;
    }

    state.automaticRoutingOverride = enabled;
    ctx.ui.notify(`Automatic Routing is ${enabled ? "on" : "off"} for this extension instance`, "info");
    return;
  }

  if (tokens[0] === "route" && tokens.length === 2 && tokens[1] === "clear") {
    const hadPendingOverride = state.pendingRouteOverride !== undefined;
    state.pendingRouteOverride = undefined;
    ctx.ui.notify(hadPendingOverride ? "Pending Route Override cleared" : "No pending Route Override", "info");
    return;
  }

  if (tokens[0] === "route" && tokens.length === 2 && ROUTES.includes(tokens[1] as Route)) {
    if (!state.configuration.ok) {
      ctx.ui.notify(configurationError(state, "set a Route Override"), "error");
      return;
    }

    state.pendingRouteOverride = tokens[1] as Route;
    ctx.ui.notify(`Next Routed Run will use the ${state.pendingRouteOverride} Route Override`, "info");
    return;
  }

  notifyInvalidUsage(ctx);
}

export default function helmExtension(pi: ExtensionAPI): void {
  const state: HelmState = {
    configuration: initialConfiguration(),
    automaticRoutingOverride: undefined,
    pendingRouteOverride: undefined,
    pendingIdleUserMessage: undefined,
    routingAttemptedForCurrentRun: false,
    activeRoutedRun: undefined,
    pendingRouteTargetApplication: undefined,
    pendingBaselineRestoration: undefined,
    baselineRestorationInFlight: undefined,
    pendingCheckpointRecovery: undefined,
    checkpointRecoverySelectedModel: undefined,
    routeTargetApplicationRevision: 0,
    helmModelSelection: undefined,
    helmThinkingSelection: undefined,
  };

  pi.on("session_start", async (_event, ctx) => {
    state.configuration = await loadHelmConfig();
    state.automaticRoutingOverride = undefined;
    state.pendingRouteOverride = undefined;
    state.pendingIdleUserMessage = undefined;
    state.routingAttemptedForCurrentRun = false;
    state.activeRoutedRun = undefined;
    state.pendingRouteTargetApplication = undefined;
    state.pendingBaselineRestoration = undefined;
    state.baselineRestorationInFlight = undefined;
    state.pendingCheckpointRecovery = undefined;
    state.checkpointRecoverySelectedModel = undefined;
    state.routeTargetApplicationRevision = 0;
    state.helmModelSelection = undefined;
    state.helmThinkingSelection = undefined;

    const checkpoint = latestIncompleteCheckpoint(ctx);
    if (checkpoint) {
      state.pendingCheckpointRecovery = checkpoint;
      state.checkpointRecoverySelectedModel = ctx.model;
      await attemptCheckpointRecovery(pi, ctx, state);
    }
  });

  pi.on("model_select", (event, ctx) => {
    const scopedSelection = helmSelectionOperation.getStore();
    if (
      scopedSelection?.kind === "model" &&
      isExactModel(event.model, scopedSelection.target.provider, scopedSelection.target.id)
    ) {
      if (state.helmModelSelection === scopedSelection) state.helmModelSelection = undefined;
      return;
    }

    state.routeTargetApplicationRevision += 1;
    let run: TrackedBaseline | undefined =
      state.pendingRouteTargetApplication ??
      state.activeRoutedRun ??
      state.pendingBaselineRestoration;
    const recoveryCheckpoint = run ? undefined : state.pendingCheckpointRecovery;
    const recoveryOverride = recoveryCheckpoint !== undefined;
    if (recoveryCheckpoint) {
      run = {
        baselineModel: event.model,
        baselineThinkingLevel: pi.getThinkingLevel(),
        checkpointId: recoveryCheckpoint.checkpointId,
        helmSelectedModel: event.model,
      };
      state.pendingCheckpointRecovery = checkpointData(run, "pending");
    }
    const completedByExplicitOverride =
      !!run &&
      (recoveryOverride ||
        state.activeRoutedRun === run ||
        (state.pendingBaselineRestoration === run && state.baselineRestorationInFlight !== run));
    let checkpointCompleted = false;
    if (run) {
      run.baselineModel = event.model;
      run.baselineThinkingLevel = pi.getThinkingLevel();
      try {
        appendCheckpoint(pi, run, "pending");
        if (completedByExplicitOverride) {
          appendCheckpoint(pi, run, "complete");
          checkpointCompleted = true;
        }
      } catch {
        notifyRoutingFailure(ctx, "Pi Jev Helm could not update the Baseline checkpoint");
        if (completedByExplicitOverride && !recoveryOverride) {
          state.pendingBaselineRestoration = run;
        }
      }
      if (completedByExplicitOverride) {
        const baseline = trackedBaselineRef(run);
        recordRoutingExplanation(pi, {
          schemaVersion: ROUTING_EXPLANATION_SCHEMA_VERSION,
          kind: "explicit-override",
          runId: run.checkpointId,
          override: {
            kind: "model",
            model: { provider: event.model.provider, model: event.model.id },
            thinkingLevel: pi.getThinkingLevel(),
          },
          baseline,
        });
        recordRoutingExplanation(pi, {
          schemaVersion: ROUTING_EXPLANATION_SCHEMA_VERSION,
          kind: "restoration",
          runId: run.checkpointId,
          outcome: "superseded",
          baseline,
        });
      }
    }

    state.activeRoutedRun = undefined;
    if (checkpointCompleted && recoveryOverride) {
      state.pendingCheckpointRecovery = undefined;
      state.checkpointRecoverySelectedModel = undefined;
    }
    if (checkpointCompleted && state.pendingBaselineRestoration === run) {
      state.pendingBaselineRestoration = undefined;
    } else if (!completedByExplicitOverride) {
      state.pendingBaselineRestoration = undefined;
    }
  });

  pi.on("thinking_level_select", (event, ctx) => {
    const scopedSelection = helmSelectionOperation.getStore();
    if (
      scopedSelection?.kind === "thinking" &&
      (state.helmThinkingSelection === scopedSelection || event.level === scopedSelection.target)
    ) {
      if (state.helmThinkingSelection === scopedSelection) {
        state.helmThinkingSelection = undefined;
      }
      return;
    }
    if (scopedSelection?.kind === "model" && scopedSelection.thinkingClampPending) {
      scopedSelection.thinkingClampPending = false;
      return;
    }

    state.routeTargetApplicationRevision += 1;
    const run =
      state.activeRoutedRun ??
      state.pendingRouteTargetApplication ??
      state.pendingBaselineRestoration;
    if (run) {
      if (ctx.model && !isExactModel(ctx.model, run.helmSelectedModel.provider, run.helmSelectedModel.id)) {
        run.baselineModel = ctx.model;
      }
      run.baselineThinkingLevel = event.level;
      try {
        appendCheckpoint(pi, run, "pending");
      } catch {
        notifyRoutingFailure(ctx, "Pi Jev Helm could not update the Baseline checkpoint");
      }
      if (state.activeRoutedRun === run) {
        recordRoutingExplanation(pi, {
          schemaVersion: ROUTING_EXPLANATION_SCHEMA_VERSION,
          kind: "explicit-override",
          runId: run.checkpointId,
          override: { kind: "thinking", thinkingLevel: event.level },
          baseline: trackedBaselineRef(run),
        });
      }
      return;
    }

    const recovery = state.pendingCheckpointRecovery;
    if (!recovery) return;
    const selectedModel = state.checkpointRecoverySelectedModel;
    const explicitModel =
      ctx.model &&
      selectedModel &&
      !isExactModel(ctx.model, selectedModel.provider, selectedModel.id)
        ? ctx.model
        : undefined;
    const updatedCheckpoint: BaselineCheckpoint = {
      ...recovery,
      status: "pending",
      baseline: {
        provider: explicitModel?.provider ?? recovery.baseline.provider,
        model: explicitModel?.id ?? recovery.baseline.model,
        thinkingLevel: event.level,
      },
    };
    state.pendingCheckpointRecovery = updatedCheckpoint;
    try {
      appendCheckpointData(pi, updatedCheckpoint);
    } catch {
      notifyRoutingFailure(ctx, "Pi Jev Helm could not update the Baseline checkpoint");
    }
  });

  pi.on("input", async (event, ctx) => {
    if (event.streamingBehavior !== undefined) return { action: "continue" };
    if (!(await prepareForNewWork(pi, state, ctx))) {
      notifyRoutingFailure(ctx, "Pi Jev Helm could not restore the Baseline; the request was not started");
      return { action: "handled" };
    }
    state.pendingIdleUserMessage = event.text;
    return { action: "continue" };
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    if (!(await prepareForNewWork(pi, state, ctx))) return;
    if (state.routingAttemptedForCurrentRun) return;

    const currentUserMessage = state.pendingIdleUserMessage;
    state.pendingIdleUserMessage = undefined;
    if (state.pendingRouteOverride) {
      state.routingAttemptedForCurrentRun = true;
      const route = state.pendingRouteOverride;
      state.pendingRouteOverride = undefined;
      await beginRoutedRun(
        pi,
        {
          route,
          source: "route-override",
          cancellationRevision: state.routeTargetApplicationRevision,
          runId: randomUUID(),
        },
        ctx,
        state,
      );
      return;
    }

    if (!effectiveAutomaticRouting(state) || currentUserMessage === undefined) return;
    state.routingAttemptedForCurrentRun = true;
    await beginAutomaticRouting(pi, currentUserMessage, ctx, state);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    await finishRoutedRun(pi, state, ctx, true);
    state.routingAttemptedForCurrentRun = false;
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    state.pendingRouteOverride = undefined;
    state.pendingIdleUserMessage = undefined;
    state.routingAttemptedForCurrentRun = false;
    state.routeTargetApplicationRevision += 1;
    const pendingApplication = state.pendingRouteTargetApplication;
    state.pendingRouteTargetApplication = undefined;
    if (pendingApplication) {
      await restoreTrackedBaseline(pi, pendingApplication, ctx, state, { retainFailedRestoration: false, recordRestorationEntry: false });
    }
    await attemptCheckpointRecovery(pi, ctx, state);
    await finishRoutedRun(pi, state, ctx, false);
  });

  pi.registerCommand("helm", {
    description: "Inspect and control Pi Jev Helm",
    getArgumentCompletions: completions,
    handler: async (args, ctx) => handleCommand(args, ctx, state),
  });
}
