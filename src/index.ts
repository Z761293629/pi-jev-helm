import { AsyncLocalStorage } from "node:async_hooks";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
  OpenRouterJevClassificationProvider,
  type ClassificationProvider,
} from "./classification-provider.js";
import { loadHelmConfig, type ConfigLoadResult, type Route, ROUTES } from "./config.js";
import { selectRoute } from "./routing-policy.js";

const HELM_COMMANDS = ["auto", "route"] as const;

type PiModel = NonNullable<ExtensionContext["model"]>;

type ActiveRoutedRun = {
  route: Route;
  baselineModel: PiModel;
  baselineThinkingLevel: ReturnType<ExtensionAPI["getThinkingLevel"]>;
};

type RouteTargetAttempt = {
  route: Route;
  source: "Automatic Routing" | "Route Override";
  cancellationRevision: number;
};

interface HelmState {
  configuration: ConfigLoadResult;
  automaticRoutingOverride: boolean | undefined;
  pendingRouteOverride: Route | undefined;
  pendingIdleUserMessage: string | undefined;
  routingAttemptedForCurrentRun: boolean;
  activeRoutedRun: ActiveRoutedRun | undefined;
  pendingRouteTargetApplication: ActiveRoutedRun | undefined;
  pendingBaselineRestoration: ActiveRoutedRun | undefined;
  routeTargetApplicationRevision: number;
}

const helmSelectionOperation = new AsyncLocalStorage<HelmState>();

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

function notifyRoutingFailure(ctx: ExtensionContext, message: string): void {
  if (ctx.mode === "tui") ctx.ui.notify(message, "warning");
}

async function selectModelFromHelm(
  pi: ExtensionAPI,
  state: HelmState,
  model: PiModel,
): Promise<boolean> {
  return helmSelectionOperation.run(state, () => pi.setModel(model));
}

function selectThinkingLevelFromHelm(
  pi: ExtensionAPI,
  state: HelmState,
  level: ReturnType<ExtensionAPI["getThinkingLevel"]>,
): void {
  helmSelectionOperation.run(state, () => pi.setThinkingLevel(level));
}

async function restoreBaseline(
  pi: ExtensionAPI,
  run: ActiveRoutedRun,
  ctx: ExtensionContext,
  state: HelmState,
): Promise<boolean> {
  for (;;) {
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
    }

    return modelRestored && thinkingRestored;
  }
}

async function restoreTrackedBaseline(
  pi: ExtensionAPI,
  run: ActiveRoutedRun,
  ctx: ExtensionContext,
  state: HelmState,
  retainFailedRestoration: boolean,
): Promise<boolean> {
  state.pendingBaselineRestoration = run;
  const restored = await restoreBaseline(pi, run, ctx, state);
  if (restored || !retainFailedRestoration) {
    if (state.pendingBaselineRestoration === run) state.pendingBaselineRestoration = undefined;
  } else {
    state.pendingBaselineRestoration = run;
  }
  return restored;
}

async function failAfterRouteTargetApplication(
  pi: ExtensionAPI,
  run: ActiveRoutedRun,
  ctx: ExtensionContext,
  state: HelmState,
  message: string,
): Promise<void> {
  state.pendingRouteTargetApplication = undefined;
  await restoreTrackedBaseline(pi, run, ctx, state, true);
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

  return restoreTrackedBaseline(pi, run, ctx, state, retainFailedRestoration);
}

async function beginRoutedRun(
  pi: ExtensionAPI,
  attempt: RouteTargetAttempt,
  ctx: ExtensionContext,
  state: HelmState,
): Promise<void> {
  if (!state.configuration.ok) return;
  const { route, source, cancellationRevision } = attempt;
  if (state.routeTargetApplicationRevision !== cancellationRevision) return;
  if (!ctx.model) {
    notifyRoutingFailure(ctx, `${source} ${route} could not capture the Baseline Model`);
    return;
  }

  const run: ActiveRoutedRun = {
    route,
    baselineModel: ctx.model,
    baselineThinkingLevel: pi.getThinkingLevel(),
  };
  const target = state.configuration.config.routes[route];
  let model: PiModel | undefined;
  try {
    model = ctx.modelRegistry.find(target.provider, target.model);
  } catch {
    notifyRoutingFailure(ctx, `${source} ${route} Route Target is unavailable`);
    return;
  }
  if (!model || !isExactModel(model, target.provider, target.model) || !isModelInScope(ctx, model)) {
    notifyRoutingFailure(ctx, `${source} ${route} Route Target is unavailable`);
    return;
  }

  state.pendingRouteTargetApplication = run;
  try {
    const modelSelected = await selectModelFromHelm(pi, state, model);
    if (state.routeTargetApplicationRevision !== cancellationRevision) {
      state.pendingRouteTargetApplication = undefined;
      await restoreTrackedBaseline(pi, run, ctx, state, true);
      return;
    }
    if (!modelSelected) {
      await failAfterRouteTargetApplication(
        pi,
        run,
        ctx,
        state,
        `${source} ${route} Route Target is unavailable`,
      );
      return;
    }
    if (!ctx.model || !isExactModel(ctx.model, target.provider, target.model)) {
      await failAfterRouteTargetApplication(
        pi,
        run,
        ctx,
        state,
        `${source} ${route} Route Target could not be applied exactly`,
      );
      return;
    }

    selectThinkingLevelFromHelm(pi, state, target.thinkingLevel);
    if (pi.getThinkingLevel() !== target.thinkingLevel) {
      await failAfterRouteTargetApplication(
        pi,
        run,
        ctx,
        state,
        `${source} ${route} Route Target thinking level could not be applied`,
      );
      return;
    }

    state.pendingRouteTargetApplication = undefined;
    state.activeRoutedRun = run;
  } catch {
    await failAfterRouteTargetApplication(
      pi,
      run,
      ctx,
      state,
      `${source} ${route} Route Target could not be applied`,
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

  try {
    const classificationProvider = await createClassificationProvider(ctx);
    if (state.routeTargetApplicationRevision !== cancellationRevision) return;
    if (!classificationProvider) {
      notifyRoutingFailure(ctx, "Automatic Routing could not authenticate the Classification Provider");
      return;
    }

    const result = await classificationProvider.classify(
      prompt,
      ctx.signal ? { signal: ctx.signal } : undefined,
    );
    if (state.routeTargetApplicationRevision !== cancellationRevision) return;
    if (!result.ok) {
      if (result.failure.kind !== "aborted") {
        notifyRoutingFailure(ctx, "Automatic Routing classification failed");
      }
      return;
    }

    const decision = selectRoute(
      result.classification,
      state.configuration.config.confidenceThreshold,
    );
    if (!decision.ok) return;

    await beginRoutedRun(
      pi,
      {
        route: decision.route,
        source: "Automatic Routing",
        cancellationRevision,
      },
      ctx,
      state,
    );
  } catch {
    notifyRoutingFailure(ctx, "Automatic Routing classification failed");
  }
}

function notifyInvalidUsage(ctx: ExtensionCommandContext): void {
  ctx.ui.notify(
    "Usage: /helm | /helm auto on|off | /helm route fast|coding|reasoning|research|clear",
    "warning",
  );
}

async function handleCommand(args: string, ctx: ExtensionCommandContext, state: HelmState): Promise<void> {
  const tokens = args.trim().length === 0 ? [] : args.trim().split(/\s+/);
  if (tokens.length === 0) {
    ctx.ui.notify(formatStatus(state, ctx), "info");
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
    routeTargetApplicationRevision: 0,
  };

  pi.on("session_start", async () => {
    state.configuration = await loadHelmConfig();
    state.automaticRoutingOverride = undefined;
    state.pendingRouteOverride = undefined;
    state.pendingIdleUserMessage = undefined;
    state.routingAttemptedForCurrentRun = false;
    state.activeRoutedRun = undefined;
    state.pendingRouteTargetApplication = undefined;
    state.pendingBaselineRestoration = undefined;
    state.routeTargetApplicationRevision = 0;
  });

  pi.on("model_select", (event) => {
    if (helmSelectionOperation.getStore() === state) return;

    state.routeTargetApplicationRevision += 1;
    const run =
      state.pendingRouteTargetApplication ??
      state.activeRoutedRun ??
      state.pendingBaselineRestoration;
    if (run) {
      run.baselineModel = event.model;
      run.baselineThinkingLevel = pi.getThinkingLevel();
    }

    state.activeRoutedRun = undefined;
    state.pendingBaselineRestoration = undefined;
  });

  pi.on("thinking_level_select", (event) => {
    if (helmSelectionOperation.getStore() === state) return;

    state.routeTargetApplicationRevision += 1;
    const run =
      state.activeRoutedRun ??
      state.pendingRouteTargetApplication ??
      state.pendingBaselineRestoration;
    if (run) run.baselineThinkingLevel = event.level;
  });

  pi.on("input", (event) => {
    if (event.streamingBehavior === undefined) state.pendingIdleUserMessage = event.text;
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    if (state.pendingBaselineRestoration && !(await finishRoutedRun(pi, state, ctx, true))) return;
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
          source: "Route Override",
          cancellationRevision: state.routeTargetApplicationRevision,
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
    await finishRoutedRun(pi, state, ctx, false);
  });

  pi.registerCommand("helm", {
    description: "Inspect and control Pi Jev Helm",
    getArgumentCompletions: completions,
    handler: async (args, ctx) => handleCommand(args, ctx, state),
  });
}
