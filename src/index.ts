import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
  JevClassificationProvider,
  OpenRouterJevClient,
  CAPABILITY_SIGNAL_NAMES,
  type CapabilitySignalName,
  type ClassificationProvider,
  type ClassificationResult,
  type TaskClassificationV1,
} from "./classification-provider.js";
import { loadHelmConfig, DEFAULT_CLASSIFICATION_PROVIDER, type ClassificationProviderSelection, type ConfigLoadResult, type Route, type RouteTarget, ROUTES } from "./config.js";
import { selectRoute, type RoutingPolicyResult } from "./routing-policy.js";
import { TypeSafeJevClient } from "./typesafe-jev-client.js";
import {
  formatRoutingExplanation,
  formatSource,
  recordRoutingExplanation,
  ROUTING_EXPLANATION_SCHEMA_VERSION,
  selectBranchRecentRoute,
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

const HELM_COMMANDS = ["auto", "client", "route", "why"] as const;
const HELM_STATUS_KEY = "pi-jev-helm";
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
  classificationProviderOverride: ClassificationProviderSelection | undefined;
  /** The Jev Client snapshotted for the automatic attempt serving the current run. */
  activeJevClient: ClassificationProviderSelection | undefined;
  pendingRouteOverride: Route | undefined;
  pendingIdleUserMessage: string | undefined;
  routingAttemptedForCurrentRun: boolean;
  activeRoutedRun: ActiveRoutedRun | undefined;
  pendingRouteTargetApplication: ActiveRoutedRun | undefined;
  pendingBaselineRestoration: TrackedBaseline | undefined;
  explicitlySupersededRun: TrackedBaseline | undefined;
  baselineRestorationInFlight: TrackedBaseline | undefined;
  pendingCheckpointRecovery: BaselineCheckpoint | undefined;
  checkpointRecoverySelectedModel: PiModel | undefined;
  routeTargetApplicationRevision: number;
  helmModelSelection: HelmModelSelectionOperation | undefined;
  helmThinkingSelection: HelmThinkingSelectionOperation | undefined;
  classificationInFlight: boolean;
  runFailOpen: FailOpenReason | undefined;
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

/** Human labels for the Jev Clients a footer can attribute a state to. */
const JEV_CLIENT_LABELS: Record<ClassificationProviderSelection, string> = {
  openrouter: "OpenRouter",
  typesafe: "TypeSafe",
};

function effectiveClassificationSelection(
  state: HelmState,
): ClassificationProviderSelection {
  // Callers guard on a healthy configuration; the fallback keeps the helper
  // total for the unhealthy case where no selection is effective.
  if (!state.configuration.ok) return DEFAULT_CLASSIFICATION_PROVIDER;
  return (
    state.classificationProviderOverride ?? state.configuration.config.classificationProvider
  );
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
    `Current or recent Route: ${
      state.activeRoutedRun?.route ??
      selectBranchRecentRoute(ctx.sessionManager.getBranch()) ??
      "none"
    }`,
    `Baseline Model: ${baselineModel}`,
  ].join("\n");
}

function helmFooterText(ctx: ExtensionContext, state: HelmState): string {
  // Footer tokens map to glossary terms: "auto"/"off" = Automatic Routing,
  // "override <route>" = pending Route Override, "explicit" = Explicit Model
  // Override, "fail-open" = fail-open outcome, "<route> → <model>" = active
  // Route with its Route Target. A healthy configuration always has an
  // effective selection, so every state carries the Jev Client's human label:
  // the run's snapshotted Client while one is in flight, otherwise the
  // selection that would serve the next automatic classification. The label
  // never marks whether the selection came from configuration or a Session
  // Classification Provider Override; "config error" stays unprefixed because
  // an unhealthy configuration has no effective selection.
  if (!state.configuration.ok) return `${HELM_STATUS_KEY}: config error`;
  const label = JEV_CLIENT_LABELS[state.activeJevClient ?? effectiveClassificationSelection(state)];
  const prefixed = (text: string): string => `${HELM_STATUS_KEY}: ${label} · ${text}`;
  // Only an Explicit Model Override ends Helm's model control, so it is the
  // override the footer reports; an Explicit Thinking Override keeps the
  // Routed Run on its Route Target and stays in the routed state.
  if (state.explicitlySupersededRun !== undefined && ctx.model) {
    return prefixed(`explicit ${ctx.model.provider}/${ctx.model.id}`);
  }
  if (state.pendingBaselineRestoration) {
    return state.baselineRestorationInFlight === state.pendingBaselineRestoration
      ? prefixed("restoring")
      : prefixed("restore failed");
  }
  if (state.pendingCheckpointRecovery) {
    return state.pendingCheckpointRecovery.status === "restoration_failed"
      ? prefixed("restore failed")
      : prefixed("restoring");
  }
  if (state.runFailOpen) return prefixed(`fail-open (${state.runFailOpen})`);
  const run = state.activeRoutedRun ?? state.pendingRouteTargetApplication;
  if (run) {
    const target = run.helmSelectedModel;
    return prefixed(`${run.route} → ${target.provider}/${target.id}`);
  }
  if (state.classificationInFlight) return prefixed("classifying");
  if (state.pendingRouteOverride) return prefixed(`override ${state.pendingRouteOverride}`);
  return prefixed(effectiveAutomaticRouting(state) ? "auto" : "off");
}

function isInteractive(ctx: ExtensionContext): boolean {
  return ctx.mode === "tui";
}

/**
 * Maintain the single Helm footer slot. The slot renders only in the
 * interactive TUI; machine-readable modes keep stdout and stderr free of
 * Helm text and rely on session entries for auditing.
 */
function renderHelmFooter(ctx: ExtensionContext, state: HelmState): void {
  if (!isInteractive(ctx)) return;
  ctx.ui.setStatus(HELM_STATUS_KEY, helmFooterText(ctx, state));
}

function configurationError(state: HelmState, action: string): string {
  const detail = state.configuration.ok ? "" : `: ${state.configuration.errors.join("; ")}`;
  return `Pi Jev Helm cannot ${action} while configuration is unhealthy${detail}`;
}

function completions(argumentPrefix: string): Array<{ value: string; label: string }> | null {
  let candidates: string[];
  if (argumentPrefix.startsWith("auto ")) {
    candidates = ["auto on", "auto off"];
  } else if (argumentPrefix.startsWith("client ")) {
    candidates = ["client openrouter", "client typesafe", "client clear"];
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

function recordRestorationExplanation(
  pi: ExtensionAPI,
  run: TrackedBaseline,
  restored: boolean,
): void {
  recordRoutingExplanation(pi, {
    schemaVersion: ROUTING_EXPLANATION_SCHEMA_VERSION,
    kind: "restoration",
    runId: run.checkpointId,
    outcome: restored ? "restored" : "failed",
    ...(restored ? { baseline: trackedBaselineRef(run) } : {}),
  });
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
    | "jevClient"
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
    ...(attempt.jevClient ? { jevClient: attempt.jevClient } : {}),
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
  renderHelmFooter(ctx, state);
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
    recordRestorationExplanation(pi, run, restored);
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
  state.runFailOpen = reason;
  recordAttemptExplanation(pi, ctx, attempt, run, {
    outcome: "fail-open",
    route: run.route,
    failOpen: { reason, baselineRetained: restored },
    restorationRequired: true,
  });
  recordRestorationExplanation(pi, run, restored);
  renderHelmFooter(ctx, state);
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

  const restored = await restoreTrackedBaseline(pi, run, ctx, state, { retainFailedRestoration, recordRestorationEntry: true });
  renderHelmFooter(ctx, state);
  return restored;
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
  const failOpenAttempt = (
    reason: FailOpenReason,
    run: TrackedBaseline | undefined,
    baselineRetained: boolean,
    message?: string,
  ): void => {
    state.runFailOpen = reason;
    recordAttemptExplanation(pi, ctx, attempt, run, {
      outcome: "fail-open",
      route,
      failOpen: { reason, baselineRetained },
      restorationRequired: false,
    });
    renderHelmFooter(ctx, state);
    if (message !== undefined) notifyRoutingFailure(ctx, message);
  };
  if (state.routeTargetApplicationRevision !== cancellationRevision) {
    failOpenAttempt("superseded-by-explicit-choice", undefined, true);
    return;
  }
  if (!ctx.model) {
    failOpenAttempt(
      "baseline-unavailable",
      undefined,
      false,
      `${sourceLabel} ${route} could not capture the Baseline Model`,
    );
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
    failOpenAttempt(
      "target-unavailable",
      run,
      true,
      `${sourceLabel} ${route} Route Target is unavailable`,
    );
    return;
  }

  run.helmSelectedModel = model;
  const targetExplanation: ExplainedModelWithThinking = {
    provider: target.provider,
    model: target.model,
    thinkingLevel: target.thinkingLevel,
  };
  state.pendingRouteTargetApplication = run;
  renderHelmFooter(ctx, state);
  try {
    appendCheckpoint(pi, run, "pending");
  } catch {
    state.pendingRouteTargetApplication = undefined;
    failOpenAttempt(
      "checkpoint-unavailable",
      run,
      true,
      `${sourceLabel} ${route} could not store the Baseline checkpoint`,
    );
    return;
  }
  try {
    const modelSelected = await selectModelFromHelm(pi, state, model);
    if (state.routeTargetApplicationRevision !== cancellationRevision) {
      state.pendingRouteTargetApplication = undefined;
      const restored = await restoreTrackedBaseline(pi, run, ctx, state, { retainFailedRestoration: true, recordRestorationEntry: false });
      state.runFailOpen = "superseded-by-explicit-choice";
      recordAttemptExplanation(pi, ctx, attempt, run, {
        outcome: "fail-open",
        route,
        failOpen: { reason: "superseded-by-explicit-choice", baselineRetained: restored },
        restorationRequired: true,
      });
      renderHelmFooter(ctx, state);
      recordRestorationExplanation(pi, run, restored);
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
    renderHelmFooter(ctx, state);
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

/**
 * Composes the selected Jev Client behind the single Classification Provider
 * (ADR 0003) and resolves its credential through the same registry call used
 * for OpenRouter: Pi's stored login first, `TYPESAFE_API_KEY` as the
 * environment fallback for the typesafe selection. A selection whose
 * credential is missing leaves Automatic Routing unavailable; the other Jev
 * Client is never substituted (ADR 0002).
 */
async function createClassificationProvider(
  ctx: ExtensionContext,
  selection: ClassificationProviderSelection,
): Promise<ClassificationProvider | undefined> {
  const apiKey = await ctx.modelRegistry.getApiKeyForProvider(selection);
  if (!apiKey) return undefined;
  const client =
    selection === "typesafe"
      ? new TypeSafeJevClient({ apiKey })
      : new OpenRouterJevClient({ apiKey });
  return new JevClassificationProvider({ client });
}

async function beginAutomaticRouting(
  pi: ExtensionAPI,
  prompt: string,
  ctx: ExtensionContext,
  state: HelmState,
): Promise<void> {
  if (!state.configuration.ok) return;
  // The Session Classification Provider Override supersedes the configured
  // Classification Provider Selection for future attempts only; the effective
  // selection is snapshotted here so the in-flight run stays attributable to
  // the Jev Client actually serving it.
  const classificationProviderSelection =
    state.classificationProviderOverride ?? state.configuration.config.classificationProvider;
  state.activeJevClient = classificationProviderSelection;
  const cancellationRevision = state.routeTargetApplicationRevision;
  const runId = randomUUID();
  const attempt: ExplanationAttempt = {
    runId,
    source: "automatic",
    // Attribution stays with the selected Jev Client even when the attempt
    // fails open on a missing credential: the other client is never tried.
    jevClient: classificationProviderSelection,
  };
  let attemptRecorded = false;
  const recordFailOpen = (failOpen: ExplainedFailOpen, classification?: AttemptClassification): void => {
    attemptRecorded = true;
    // An aborted classification ends quietly: the cancelled run leaves the
    // footer in its idle or pending state instead of a fail-open result.
    if (failOpen.reason !== "classification-aborted") state.runFailOpen = failOpen.reason;
    recordAttemptExplanation(pi, ctx, { ...attempt, ...(classification ? { classification } : {}) }, undefined, {
      outcome: "fail-open",
      failOpen,
      restorationRequired: false,
    });
  };

  try {
    const classificationProvider = await createClassificationProvider(ctx, classificationProviderSelection);
    if (state.routeTargetApplicationRevision !== cancellationRevision) return;
    if (!classificationProvider) {
      recordFailOpen({ reason: "provider-unavailable", baselineRetained: true });
      renderHelmFooter(ctx, state);
      notifyRoutingFailure(ctx, "Automatic Routing could not authenticate the Classification Provider");
      return;
    }

    state.classificationInFlight = true;
    let result: ClassificationResult;
    try {
      renderHelmFooter(ctx, state);
      result = await classificationProvider.classify(
        prompt,
        ctx.signal ? { signal: ctx.signal } : undefined,
      );
    } finally {
      state.classificationInFlight = false;
    }
    renderHelmFooter(ctx, state);
    if (!result.ok) {
      const aborted = result.failure.kind === "aborted";
      if (!aborted) {
        recordFailOpen({
          reason: "classification-failed",
          baselineRetained: true,
          classification: {
            kind: result.failure.kind,
            ...(result.failure.status === undefined ? {} : { status: result.failure.status }),
          },
        });
        renderHelmFooter(ctx, state);
        notifyRoutingFailure(ctx, "Automatic Routing classification failed");
      } else {
        recordFailOpen({ reason: "classification-aborted", baselineRetained: true });
        renderHelmFooter(ctx, state);
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
      renderHelmFooter(ctx, state);
      return;
    }
    if (!decision.ok) {
      recordFailOpen(
        { reason: "low-confidence", baselineRetained: true },
        automaticClassificationDetails(state, result.classification, decision),
      );
      renderHelmFooter(ctx, state);
      return;
    }

    await beginRoutedRun(
      pi,
      {
        route: decision.route,
        source: "automatic",
        jevClient: classificationProviderSelection,
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
      renderHelmFooter(ctx, state);
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
    "Usage: /helm | /helm auto on|off | /helm client openrouter|typesafe|clear | /helm route fast|coding|reasoning|research|clear | /helm why",
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

const CLIENT_OVERRIDE_ARGUMENTS = ["openrouter", "typesafe", "clear"] as const;
type ClientOverrideArgument = (typeof CLIENT_OVERRIDE_ARGUMENTS)[number];

async function handleClientCommand(
  argument: ClientOverrideArgument,
  ctx: ExtensionCommandContext,
  state: HelmState,
): Promise<void> {
  if (argument === "clear") {
    // Clear is always allowed: it may restore a configured selection whose
    // credential is missing, so that case warns instead of rejecting (ADR 0002).
    const hadOverride = state.classificationProviderOverride !== undefined;
    state.classificationProviderOverride = undefined;
    renderHelmFooter(ctx, state);
    if (!hadOverride) {
      ctx.ui.notify("No session Classification Provider Override", "info");
      return;
    }
    if (!state.configuration.ok) {
      ctx.ui.notify("Session Classification Provider Override cleared", "info");
      return;
    }
    const configured = state.configuration.config.classificationProvider;
    const apiKey = await ctx.modelRegistry.getApiKeyForProvider(configured);
    if (!apiKey) {
      ctx.ui.notify(
        `Session Classification Provider Override cleared; the configured ${JEV_CLIENT_LABELS[configured]} Jev Client has no credential, so Automatic Routing is unavailable`,
        "warning",
      );
      return;
    }
    ctx.ui.notify(
      `Session Classification Provider Override cleared; Task Classification uses the configured ${JEV_CLIENT_LABELS[configured]} Jev Client`,
      "info",
    );
    return;
  }

  if (!state.configuration.ok) {
    ctx.ui.notify(configurationError(state, "select a Jev Client"), "error");
    return;
  }
  // Credential lookup matches classification exactly (Pi's stored login
  // first, the provider's environment variable as fallback). A missing
  // credential rejects the change and preserves the effective selection.
  const selection: ClassificationProviderSelection = argument;
  const apiKey = await ctx.modelRegistry.getApiKeyForProvider(selection);
  if (!apiKey) {
    ctx.ui.notify(
      `Cannot select the ${JEV_CLIENT_LABELS[selection]} Jev Client for this session: no ${selection} credential is available (sign in with /login or set the provider's API key environment variable)`,
      "error",
    );
    return;
  }
  state.classificationProviderOverride = selection;
  renderHelmFooter(ctx, state);
  ctx.ui.notify(
    `Task Classification will use the ${JEV_CLIENT_LABELS[selection]} Jev Client for this extension instance`,
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
    renderHelmFooter(ctx, state);
    ctx.ui.notify(`Automatic Routing is ${enabled ? "on" : "off"} for this extension instance`, "info");
    return;
  }

  if (tokens[0] === "client" && tokens.length === 2 && CLIENT_OVERRIDE_ARGUMENTS.includes(tokens[1] as ClientOverrideArgument)) {
    await handleClientCommand(tokens[1] as ClientOverrideArgument, ctx, state);
    return;
  }

  if (tokens[0] === "route" && tokens.length === 2 && tokens[1] === "clear") {
    const hadPendingOverride = state.pendingRouteOverride !== undefined;
    state.pendingRouteOverride = undefined;
    renderHelmFooter(ctx, state);
    ctx.ui.notify(hadPendingOverride ? "Pending Route Override cleared" : "No pending Route Override", "info");
    return;
  }

  if (tokens[0] === "route" && tokens.length === 2 && ROUTES.includes(tokens[1] as Route)) {
    if (!state.configuration.ok) {
      ctx.ui.notify(configurationError(state, "set a Route Override"), "error");
      return;
    }

    state.pendingRouteOverride = tokens[1] as Route;
    renderHelmFooter(ctx, state);
    ctx.ui.notify(`Next Routed Run will use the ${state.pendingRouteOverride} Route Override`, "info");
    return;
  }

  notifyInvalidUsage(ctx);
}

export default function helmExtension(pi: ExtensionAPI): void {
  pi.registerProvider("typesafe", {
    name: "TypeSafe",
    apiKey: "$TYPESAFE_API_KEY",
    models: [],
  });

  const state: HelmState = {
    configuration: initialConfiguration(),
    automaticRoutingOverride: undefined,
    classificationProviderOverride: undefined,
    activeJevClient: undefined,
    pendingRouteOverride: undefined,
    pendingIdleUserMessage: undefined,
    routingAttemptedForCurrentRun: false,
    activeRoutedRun: undefined,
    pendingRouteTargetApplication: undefined,
    pendingBaselineRestoration: undefined,
    explicitlySupersededRun: undefined,
    baselineRestorationInFlight: undefined,
    pendingCheckpointRecovery: undefined,
    checkpointRecoverySelectedModel: undefined,
    routeTargetApplicationRevision: 0,
    helmModelSelection: undefined,
    helmThinkingSelection: undefined,
    classificationInFlight: false,
    runFailOpen: undefined,
  };

  pi.on("session_start", async (_event, ctx) => {
    state.configuration = await loadHelmConfig();
    state.automaticRoutingOverride = undefined;
    // A Session Classification Provider Override is session-scoped: every
    // session start (/reload, new, resume, fork) discards it.
    state.classificationProviderOverride = undefined;
    state.activeJevClient = undefined;
    state.pendingRouteOverride = undefined;
    state.pendingIdleUserMessage = undefined;
    state.routingAttemptedForCurrentRun = false;
    state.activeRoutedRun = undefined;
    state.pendingRouteTargetApplication = undefined;
    state.pendingBaselineRestoration = undefined;
    state.explicitlySupersededRun = undefined;
    state.baselineRestorationInFlight = undefined;
    state.pendingCheckpointRecovery = undefined;
    state.checkpointRecoverySelectedModel = undefined;
    state.routeTargetApplicationRevision = 0;
    state.helmModelSelection = undefined;
    state.helmThinkingSelection = undefined;
    state.classificationInFlight = false;
    state.runFailOpen = undefined;

    if (!state.configuration.ok && isInteractive(ctx)) {
      ctx.ui.notify(
        `Pi Jev Helm configuration is invalid: ${state.configuration.errors.join("; ")}`,
        "error",
      );
    }

    const checkpoint = latestIncompleteCheckpoint(ctx);
    if (checkpoint) {
      state.pendingCheckpointRecovery = checkpoint;
      state.checkpointRecoverySelectedModel = ctx.model;
      await attemptCheckpointRecovery(pi, ctx, state);
    }
    renderHelmFooter(ctx, state);
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
      state.pendingBaselineRestoration ??
      state.explicitlySupersededRun;
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
    const supersededActiveRun = !!run && state.activeRoutedRun === run;
    const alreadySuperseded = !!run && state.explicitlySupersededRun === run;
    const completedByExplicitOverride =
      !!run &&
      (recoveryOverride ||
        supersededActiveRun ||
        alreadySuperseded ||
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
      if (completedByExplicitOverride && !alreadySuperseded) {
        recordRoutingExplanation(pi, {
          schemaVersion: ROUTING_EXPLANATION_SCHEMA_VERSION,
          kind: "restoration",
          runId: run.checkpointId,
          outcome: "superseded",
          baseline,
        });
      }
      if (supersededActiveRun) state.explicitlySupersededRun = run;
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
    renderHelmFooter(ctx, state);
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
      state.pendingBaselineRestoration ??
      state.explicitlySupersededRun;
    if (run) {
      if (ctx.model && !isExactModel(ctx.model, run.helmSelectedModel.provider, run.helmSelectedModel.id)) {
        run.baselineModel = ctx.model;
      }
      run.baselineThinkingLevel = event.level;
      try {
        appendCheckpoint(
          pi,
          run,
          state.explicitlySupersededRun === run ? "complete" : "pending",
        );
      } catch {
        notifyRoutingFailure(ctx, "Pi Jev Helm could not update the Baseline checkpoint");
      }
      recordRoutingExplanation(pi, {
        schemaVersion: ROUTING_EXPLANATION_SCHEMA_VERSION,
        kind: "explicit-override",
        runId: run.checkpointId,
        override: { kind: "thinking", thinkingLevel: event.level },
        baseline: trackedBaselineRef(run),
      });
      renderHelmFooter(ctx, state);
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
    renderHelmFooter(ctx, state);
  });

  pi.on("input", async (event, ctx) => {
    if (event.streamingBehavior !== undefined) return { action: "continue" };
    if (!(await prepareForNewWork(pi, state, ctx))) {
      renderHelmFooter(ctx, state);
      notifyRoutingFailure(ctx, "Pi Jev Helm could not restore the Baseline; the request was not started");
      return { action: "handled" };
    }
    state.pendingIdleUserMessage = event.text;
    return { action: "continue" };
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    if (!(await prepareForNewWork(pi, state, ctx))) {
      renderHelmFooter(ctx, state);
      return;
    }
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
    // The run is over: drop its fail-open marker and its Jev Client snapshot
    // before restoration so the footer settles on the restoring/idle/pending
    // state attributed to the new effective selection instead of briefly
    // re-displaying the previous result.
    state.runFailOpen = undefined;
    state.activeJevClient = undefined;
    await finishRoutedRun(pi, state, ctx, true);
    state.explicitlySupersededRun = undefined;
    state.routingAttemptedForCurrentRun = false;
    renderHelmFooter(ctx, state);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    state.pendingRouteOverride = undefined;
    state.pendingIdleUserMessage = undefined;
    state.routingAttemptedForCurrentRun = false;
    state.explicitlySupersededRun = undefined;
    state.runFailOpen = undefined;
    state.activeJevClient = undefined;
    state.routeTargetApplicationRevision += 1;
    const pendingApplication = state.pendingRouteTargetApplication;
    state.pendingRouteTargetApplication = undefined;
    if (pendingApplication) {
      await restoreTrackedBaseline(pi, pendingApplication, ctx, state, { retainFailedRestoration: false, recordRestorationEntry: false });
    }
    await attemptCheckpointRecovery(pi, ctx, state);
    await finishRoutedRun(pi, state, ctx, false);
    renderHelmFooter(ctx, state);
  });

  pi.registerCommand("helm", {
    description: "Inspect and control Pi Jev Helm",
    getArgumentCompletions: completions,
    handler: async (args, ctx) => handleCommand(args, ctx, state),
  });
}
