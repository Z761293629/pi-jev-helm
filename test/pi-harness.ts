/**
 * Public-API black-box harness for Pi Jev Helm.
 *
 * This harness drives the real in-process Pi coding agent SDK: the extension
 * under test is loaded from `src/index.ts` through Pi's own extension loader,
 * lifecycle events flow through the real `ExtensionRunner`, and model responses
 * come from scripted in-process fake providers built exclusively with public
 * `@earendil-works/pi-ai` APIs. Nothing in this file imports Pi `dist`
 * internals or the extension's own modules: the only seam is the public
 * extension surface, which is exactly what the compatibility certification in
 * issue #23 is allowed to depend on.
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  createFauxCore,
  createProvider,
  fauxAssistantMessage,
  InMemoryCredentialStore,
  type AssistantMessage,
  type Model,
  type Provider,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  AgentSessionRuntime,
  DefaultResourceLoader,
  type AgentSessionEvent,
  type ExtensionUIContext,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

/** Absolute path of the shipped extension entry point, loaded via Pi's loader. */
export const HELM_EXTENSION_PATH = join(import.meta.dirname, "..", "src", "index.ts");

const HELM_CONFIG_FILE = "pi-jev-helm.json";
const AVAILABILITY_TIMEOUT_MS = 10_000;

export type HelmRouteName = "fast" | "coding" | "reasoning" | "research";

export interface RouteTargetSpec {
  provider: string;
  model: string;
  thinkingLevel: string;
}

/**
 * Route targets used by the suite. Thinking levels stay within the levels a
 * standard reasoning model supports (`off` through `high`) so expectations do
 * not depend on extended-level clamping.
 */
export const HELM_ROUTES: Record<HelmRouteName, RouteTargetSpec> = {
  fast: { provider: "helm-fast", model: "fast-model", thinkingLevel: "off" },
  coding: { provider: "helm-coding", model: "coding-model", thinkingLevel: "high" },
  reasoning: { provider: "helm-reasoning", model: "reasoning-model", thinkingLevel: "medium" },
  research: { provider: "helm-research", model: "research-model", thinkingLevel: "low" },
};

export const BASELINE_PROVIDER = "helm-baseline";
export const BASELINE_MODEL_ID = "baseline-model";
export const USER_PROVIDER = "helm-user";
export const USER_MODEL_ID = "user-model";

export interface RecordedUICall {
  method: string;
  args: unknown[];
}

export interface RecordingUI {
  ui: ExtensionUIContext;
  calls: RecordedUICall[];
  statuses(): string[];
  lastStatus(): string | undefined;
  notices(): Array<{ message: string; level: string }>;
}

/** Full ExtensionUIContext recorder; every method is recorded, none render. */
export function createRecordingUI(): RecordingUI {
  const calls: RecordedUICall[] = [];
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
    };
  const ui = {
    select: async () => undefined,
    confirm: async () => false,
    input: async () => undefined,
    editor: async () => undefined,
    custom: async () => undefined,
    notify: (message: string, type?: string) => {
      calls.push({ method: "notify", args: [message, type ?? "info"] });
    },
    onTerminalInput: () => () => {},
    setStatus: (key: string, text: string | undefined) => {
      calls.push({ method: "setStatus", args: [key, text] });
    },
    setWorkingMessage: record("setWorkingMessage"),
    setWorkingVisible: record("setWorkingVisible"),
    setWorkingIndicator: record("setWorkingIndicator"),
    setHiddenThinkingLabel: record("setHiddenThinkingLabel"),
    setWidget: record("setWidget"),
    setFooter: record("setFooter"),
    setHeader: record("setHeader"),
    setTitle: record("setTitle"),
    pasteToEditor: record("pasteToEditor"),
    setEditorText: record("setEditorText"),
    getEditorText: () => "",
    setEditorComponent: record("setEditorComponent"),
    getEditorComponent: () => undefined,
    // The runner spreads this context (evaluating getters), so the theme must be
    // a plain stub; Helm never reads it.
    theme: { fg: (tone: string, text: string) => text },
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: "not available" }),
    getToolsExpanded: () => false,
    setToolsExpanded: record("setToolsExpanded"),
    addAutocompleteProvider: record("addAutocompleteProvider"),
  } as unknown as ExtensionUIContext;
  return {
    ui,
    calls,
    statuses: () =>
      calls.filter((call) => call.method === "setStatus").map((call) => String(call.args[1])),
    lastStatus: () => {
      const statuses = calls.filter((call) => call.method === "setStatus");
      return statuses.length > 0 ? String(statuses.at(-1)?.args[1]) : undefined;
    },
    notices: () =>
      calls
        .filter((call) => call.method === "notify")
        .map((call) => ({
          message: String(call.args[0]),
          level: String(call.args[1] ?? "info"),
        })),
  };
}

export interface ScriptedProvider {
  provider: Provider;
  /** Queue exactly one assistant reply for the next request. */
  respond(content: string, options?: { stopReason?: AssistantMessage["stopReason"] }): void;
  /**
   * Queue a gated reply: streaming stalls until `release()` is called, which
   * lets tests observe or race with an in-flight model request.
   */
  respondGated(content: string): { release(): void; released: Promise<void> };
  callCount(): number;
  model(providerModelId: string): Model<string>;
  /**
   * Toggle whether the provider's auth resolves. Public effect: the next
   * availability snapshot (and every `setModel` availability gate) sees the
   * provider as unconfigured until toggled back.
   */
  setConfigured(configured: boolean): void;
}

/**
 * Build a fake provider with resolving API-key auth so Pi treats every model
 * as available. Responses are scripted with the public pi-ai faux core.
 */
export function createScriptedProvider(
  providerId: string,
  modelIds: string[],
  options: { tokensPerSecond?: number } = {},
): ScriptedProvider {
  const core = createFauxCore({
    provider: providerId,
    models: modelIds.map((id) => ({ id, reasoning: true })),
    ...(options.tokensPerSecond === undefined ? {} : { tokensPerSecond: options.tokensPerSecond }),
  });
  let configured = true;
  const provider = createProvider({
    id: providerId,
    auth: {
      apiKey: {
        name: `${providerId} test key`,
        resolve: async () =>
          configured
            ? { auth: { apiKey: `test-key-${providerId}` }, source: "test" }
            : undefined,
      },
    },
    models: core.models,
    api: { stream: core.stream, streamSimple: core.streamSimple },
  });
  return {
    provider,
    respond(content, responseOptions) {
      core.appendResponses([fauxAssistantMessage(content, responseOptions)]);
    },
    respondGated(content) {
      let releaseGate!: () => void;
      const released = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      core.appendResponses([
        async () => {
          await released;
          return fauxAssistantMessage(content);
        },
      ]);
      return { release: releaseGate, released };
    },
    callCount: () => core.state.callCount,
    model: (providerModelId: string) => {
      const model = core.getModel(providerModelId);
      if (!model) throw new Error(`unknown faux model ${providerId}/${providerModelId}`);
      return model;
    },
    setConfigured(next: boolean) {
      configured = next;
    },
  };
}

export interface ClassificationDecision {
  codeWork: number;
  deepReasoning: number;
  externalResearch: number;
}

export interface FetchLogEntry {
  url: string;
  body: unknown;
}

export interface ClassificationStub {
  /** Queue the next OpenRouter Decisions response body. */
  decide(decision: ClassificationDecision): void;
  /** Queue a raw Response for the next classification request. */
  respondWith(response: Response): void;
  /** Queue a transport error for the next classification request. */
  failWith(error: unknown): void;
  /** Queue a response that only settles once `release()` is called. */
  gate(): { release(): void };
  requests: FetchLogEntry[];
  callCount(): number;
  restore(): void;
}

const DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
const DECISIONS_MODEL = "typesafe/jev-1.13-20260917";

/**
 * Replace `globalThis.fetch` with a stub that answers OpenRouter Decisions
 * requests from a scripted queue and records request metadata. This is the
 * sanctioned Classification Provider transport seam: it is external to Pi and
 * to Helm, and no real network request is ever made.
 */
export function stubClassificationTransport(): ClassificationStub {
  const queue: Array<() => Promise<Response> | Response> = [];
  const requests: FetchLogEntry[] = [];
  const realFetch = globalThis.fetch;
  const stub = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    let body: unknown = undefined;
    try {
      body = init?.body ? JSON.parse(String(init.body)) : undefined;
    } catch {
      body = String(init?.body ?? "");
    }
    const entry: FetchLogEntry = { url, body };
    requests.push(entry);
    const next = queue.shift();
    if (!next) throw new Error(`unexpected fetch in test: ${url}`);
    if (next instanceof Response) return next;
    return next();
  }) as typeof fetch;
  globalThis.fetch = stub;
  return {
    decide(decision) {
      queue.push(
        () =>
          new Response(
            JSON.stringify({
              id: "decision-1",
              model: DECISIONS_MODEL,
              provider: "TypeSafe",
              answers: {
                codeWork: { type: "noul", noul: decision.codeWork },
                deepReasoning: { type: "noul", noul: decision.deepReasoning },
                externalResearch: { type: "noul", noul: decision.externalResearch },
              },
              usage: { input_tokens: 12, output_tokens: 34 },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      );
    },
    respondWith(response: Response) {
      queue.push(() => response);
    },
    failWith(error) {
      queue.push(() => {
        throw error;
      });
    },
    gate() {
      let releaseGate!: () => void;
      const released = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      queue.push(async () => {
        await released;
        return new Response(
          JSON.stringify({
            id: "decision-gated",
            model: DECISIONS_MODEL,
            provider: "TypeSafe",
            answers: {
              codeWork: { type: "noul", noul: 0.95 },
              deepReasoning: { type: "noul", noul: 0.1 },
              externalResearch: { type: "noul", noul: 0.1 },
            },
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      });
      return { release: releaseGate };
    },
    requests,
    callCount: () => requests.length,
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}

export interface HelmHarnessOptions {
  mode?: "tui" | "rpc" | "json" | "print";
  /** Write a valid configuration file; omit or pass `false` for unhealthy config. */
  routes?: Record<HelmRouteName, RouteTargetSpec> | false;
  automaticRouting?: boolean;
  confidenceThreshold?: number;
  /** Restrict the session's scoped models (exact `provider/model` keys). */
  scopedModels?: string[];
  initialThinkingLevel?: string;
  /** Pace faux token streaming so tests can observe mid-run states. */
  tokensPerSecond?: number;
  /** Back the first session with a persistent file so it can be reopened. */
  persistent?: boolean;
  /** Drive sessions through an AgentSessionRuntime so replacement flows work. */
  runtimeSession?: boolean;
}

export interface HelmHarness {
  session: Awaited<ReturnType<typeof createAgentSession>>["session"];
  sessionManager: SessionManager;
  recorder: RecordingUI;
  events: AgentSessionEvent[];
  classification: ClassificationStub;
  baseline: ScriptedProvider;
  routes: Record<HelmRouteName, ScriptedProvider>;
  user: ScriptedProvider;
  modelRuntime: ModelRuntime;
  agentDir: string;
  sessionFile: string | undefined;
  /** Toggle Classification Provider credential availability (public auth effects only). */
  setOpenRouterConfigured(configured: boolean): void;
  /** Force a consistent model availability snapshot through the public API. */
  refreshAvailability(): Promise<void>;
  /** Replace the active session via AgentSessionRuntime (requires `runtimeSession`). */
  replaceSession(): Promise<HelmHarness["session"]>;
  /**
   * Open a fresh AgentSession over the same session file, as Pi does when a
   * session is resumed. Returns the new session; the old one is disposed.
   */
  reopenSession(): Promise<HelmHarness["session"]>;
  dispose(): Promise<void>;
}

async function waitForAvailability(
  modelRuntime: ModelRuntime,
  expected: Array<{ provider: string; id: string }>,
): Promise<void> {
  const deadline = Date.now() + AVAILABILITY_TIMEOUT_MS;
  for (;;) {
    // Public API: forces a consistent availability snapshot before returning.
    const available = await modelRuntime.getAvailable();
    const keys = new Set(available.map((model) => `${model.provider}/${model.id}`));
    if (expected.every((model) => keys.has(`${model.provider}/${model.id}`))) return;
    if (Date.now() > deadline) {
      throw new Error(
        `models never became available; saw ${[...keys].join(", ") || "(none)"}`,
      );
    }
    await delay(25);
  }
}

export async function startHelmHarness(options: HelmHarnessOptions = {}): Promise<HelmHarness> {
  const rootDir = await mkdtemp(join(tmpdir(), "pi-jev-helm-compat-"));
  const agentDir = join(rootDir, "agent");
  const sessionDir = join(rootDir, "sessions");
  await mkdir(agentDir, { recursive: true });
  await mkdir(sessionDir, { recursive: true });

  const routes = options.routes;
  if (routes !== false) {
    const routeTargets: Record<string, RouteTargetSpec> = {};
    for (const [name, target] of Object.entries(routes ?? HELM_ROUTES)) {
      routeTargets[name] = target;
    }
    await writeFile(
      join(agentDir, HELM_CONFIG_FILE),
      JSON.stringify({
        schemaVersion: 1,
        ...(options.automaticRouting === undefined ? {} : { automaticRouting: options.automaticRouting }),
        ...(options.confidenceThreshold === undefined
          ? {}
          : { confidenceThreshold: options.confidenceThreshold }),
        routes: routeTargets,
      }),
    );
  }
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    return await buildHarness(rootDir, agentDir, sessionDir, options, previousAgentDir);
  } catch (error) {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(rootDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function buildHarness(
  rootDir: string,
  agentDir: string,
  sessionDir: string,
  options: HelmHarnessOptions,
  previousAgentDir: string | undefined,
): Promise<HelmHarness> {
  const mode = options.mode ?? "tui";
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });

  const baseline = createScriptedProvider(BASELINE_PROVIDER, [BASELINE_MODEL_ID], {
    ...(options.tokensPerSecond === undefined ? {} : { tokensPerSecond: options.tokensPerSecond }),
  });
  const tokens = options.tokensPerSecond === undefined ? {} : { tokensPerSecond: options.tokensPerSecond };
  const routeProviders: Record<HelmRouteName, ScriptedProvider> = {
    fast: createScriptedProvider(HELM_ROUTES.fast.provider, [HELM_ROUTES.fast.model], tokens),
    coding: createScriptedProvider(HELM_ROUTES.coding.provider, [HELM_ROUTES.coding.model], tokens),
    reasoning: createScriptedProvider(HELM_ROUTES.reasoning.provider, [HELM_ROUTES.reasoning.model], tokens),
    research: createScriptedProvider(HELM_ROUTES.research.provider, [HELM_ROUTES.research.model], tokens),
  };
  const user = createScriptedProvider(USER_PROVIDER, [USER_MODEL_ID], tokens);

  /**
   * Override the built-in openrouter provider with a native provider whose
   * auth resolves from a test-controlled flag. Helm only reads the resolved
   * API key for the Classification Provider; no request ever streams.
   */
  let openrouterConfigured = true;
  const openrouterOverride: Provider = createProvider({
    id: "openrouter",
    auth: {
      apiKey: {
        name: "test OpenRouter key",
        resolve: async () =>
          openrouterConfigured
            ? { auth: { apiKey: "helm-test-openrouter-key" }, source: "test key" }
            : undefined,
      },
    },
    models: [],
    api: {
      stream: () => {
        throw new Error("classification provider must never stream model responses");
      },
      streamSimple: () => {
        throw new Error("classification provider must never stream model responses");
      },
    },
  });
  modelRuntime.registerNativeProvider(openrouterOverride);
  modelRuntime.registerNativeProvider(baseline.provider);
  modelRuntime.registerNativeProvider(user.provider);
  for (const scripted of Object.values(routeProviders)) {
    modelRuntime.registerNativeProvider(scripted.provider);
  }

  const expectedModels = [
    { provider: BASELINE_PROVIDER, id: BASELINE_MODEL_ID },
    { provider: USER_PROVIDER, id: USER_MODEL_ID },
    ...Object.values(HELM_ROUTES).map((target) => ({
      provider: target.provider,
      id: target.model,
    })),
  ];
  await waitForAvailability(modelRuntime, expectedModels);

  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const loader = new DefaultResourceLoader({
    cwd: rootDir,
    agentDir,
    settingsManager,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    additionalExtensionPaths: [HELM_EXTENSION_PATH],
  });
  await loader.reload();
  const extensionsResult = loader.getExtensions();
  if (extensionsResult.errors.length > 0) {
    throw new Error(
      `extension failed to load: ${extensionsResult.errors.map((error) => `${error.path}: ${error.error}`).join("; ")}`,
    );
  }

  const scopedModelKeys = options.scopedModels;
  const scopedModels = scopedModelKeys?.map((key: string) => {
    const [provider, id] = key.split("/");
    const model = modelRuntime.getModel(provider ?? "", id ?? "");
    if (!model) throw new Error(`scoped model ${key} is not registered`);
    return { model };
  });

  const recorder = createRecordingUI();
  const events: AgentSessionEvent[] = [];
  const classification = stubClassificationTransport();
  let harnessDisposed = false;

  const buildSession = async (manager: SessionManager, model?: Model<string>) => {
    const { session } = await createAgentSession({
      cwd: rootDir,
      agentDir,
      modelRuntime,
      settingsManager,
      resourceLoader: loader,
      sessionManager: manager,
      ...(model ? { model } : {}),
      thinkingLevel: (options.initialThinkingLevel as never) ?? "medium",
      ...(scopedModels && scopedModels.length > 0 ? { scopedModels } : {}),
      noTools: "all",
    });
    session.subscribe((event) => {
      events.push(event);
    });
    await session.bindExtensions({ uiContext: recorder.ui, mode });
    return session;
  };

  /**
   * Session replacement through the public AgentSessionRuntime flow: the same
   * layer Pi's interactive mode uses for /new, /resume, and reload.
   */
  const buildRuntime = async (): Promise<AgentSessionRuntime> => {
    const serviceOptions = {
      agentDir,
      settingsManager,
      modelRuntime,
      resourceLoaderOptions: {
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        additionalExtensionPaths: [HELM_EXTENSION_PATH],
      },
    };
    const createRuntime = async ({
      cwd,
      sessionManager: manager,
      sessionStartEvent,
    }: {
      cwd: string;
      sessionManager: SessionManager;
      sessionStartEvent: never;
    }) => {
      const services = await createAgentSessionServices({ ...serviceOptions, cwd });
      return {
        ...(await createAgentSessionFromServices({
          services,
          sessionManager: manager,
          sessionStartEvent,
          model: baseline.model(BASELINE_MODEL_ID),
          thinkingLevel: (options.initialThinkingLevel as never) ?? "medium",
          ...(scopedModels && scopedModels.length > 0 ? { scopedModels } : {}),
          noTools: "all",
        })),
        services,
        diagnostics: services.diagnostics,
      };
    };
    return createAgentSessionRuntime(createRuntime as never, {
      cwd: rootDir,
      agentDir,
      sessionManager: SessionManager.inMemory(rootDir),
    });
  };

  const bindRuntimeSession = async (runtimeSession: HelmHarness["session"]) => {
    runtimeSession.subscribe((event: AgentSessionEvent) => {
      events.push(event);
    });
    await runtimeSession.bindExtensions({ uiContext: recorder.ui, mode });
    return runtimeSession;
  };

  let runtime: AgentSessionRuntime | undefined;
  let firstManagerRef: SessionManager;
  let session: HelmHarness["session"];
  if (options.runtimeSession) {
    runtime = await buildRuntime();
    session = await bindRuntimeSession(runtime.session);
    firstManagerRef = runtime.session.sessionManager;
  } else {
    firstManagerRef = options.persistent
      ? SessionManager.create(rootDir, sessionDir)
      : SessionManager.inMemory(rootDir);
    session = await buildSession(firstManagerRef, baseline.model(BASELINE_MODEL_ID));
  }

  const setOpenRouterConfigured = (configured: boolean) => {
    openrouterConfigured = configured;
  };
  const harness: HelmHarness = {
    session,
    sessionManager: firstManagerRef,
    recorder,
    events,
    classification,
    baseline,
    routes: routeProviders,
    user,
    modelRuntime,
    agentDir,
    sessionFile: firstManagerRef.getSessionFile(),
    setOpenRouterConfigured,
    /** Force a consistent model availability snapshot (public API effect). */
    async refreshAvailability() {
      await modelRuntime.getAvailable();
    },
    /**
     * Replace the active session through AgentSessionRuntime.newSession():
     * the old session receives session_shutdown, a fresh extension runtime is
     * loaded for the replacement, and the recorder is rebound to it.
     */
    async replaceSession() {
      if (!runtime) throw new Error("replaceSession requires runtimeSession: true");
      await runtime.newSession();
      harness.session = await bindRuntimeSession(runtime.session);
      harness.sessionManager = harness.session.sessionManager;
      return harness.session;
    },
    async reopenSession() {
      const file = harness.sessionFile;
      if (!file) throw new Error("reopenSession requires a persistent session");
      harness.session.dispose();
      // Reload resources exactly like Pi's session replacement does, so the new
      // session gets a freshly loaded extension runtime instead of a stale one.
      await loader.reload();
      const manager = SessionManager.open(file, sessionDir);
      const reopened = await buildSession(manager);
      harness.session = reopened;
      harness.sessionManager = manager;
      return reopened;
    },
    async dispose() {
      if (harnessDisposed) return;
      harnessDisposed = true;
      classification.restore();
      harness.session.dispose();
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(rootDir, { recursive: true, force: true });
    },
  };
  return harness;
}

/** Assistant messages recorded in the session, with the model that produced them. */
export function assistantMessages(manager: SessionManager): Array<{
  provider: string;
  model: string;
  text: string;
}> {
  return manager
    .getBranch()
    .filter((entry) => entry.type === "message")
    .map((entry) => (entry as { message: { role: string } }).message)
    .filter((message) => message.role === "assistant")
    .map((message) => {
      const assistant = message as unknown as {
        provider: string;
        model: string;
        content: Array<{ type: string; text?: string }>;
      };
      return {
        provider: assistant.provider,
        model: assistant.model,
        text: assistant.content
          .filter((block) => block.type === "text")
          .map((block) => block.text ?? "")
          .join(""),
      };
    });
}
