import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import helmExtension from "../src/index.js";
import { completeRoutes, deferred } from "./fixtures.js";

export type EventHandler = (event: never, ctx: ExtensionContext) => Promise<unknown> | unknown;
export type HelmCommand = {
  getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string }> | null | Promise<Array<{ value: string; label: string }> | null>;
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
};

export type Notice = { message: string; level: string };
export type FakeModel = { provider: string; id: string };
export type FakeSessionEntry = {
  type: "custom";
  id: string;
  parentId: string | null;
  timestamp: string;
  customType: string;
  data?: unknown;
};
export type HarnessOptions = {
  appendEntryError?: boolean;
  appendEntryErrors?: boolean[];
  appliedModels?: Record<string, FakeModel[]>;
  initialModel?: FakeModel;
  initialThinkingLevel?: string;
  beforeModelApplication?: Record<string, () => Promise<void>>;
  beforeModelSelectDispatch?: (
    model: FakeModel,
    selectModel: (model?: FakeModel, level?: string) => Promise<void>,
  ) => Promise<void>;
  beforeThinkingLevelSelectDispatch?: (level: string) => Promise<void>;
  unavailableModels?: string[];
  modelResults?: Record<string, boolean[]>;
  mutateModelBeforeFailure?: string[];
  registryErrors?: string[];
  registryResults?: Record<string, FakeModel | null>;
  scopedModels?: string[];
  signal?: AbortSignal;
  sessionEntries?: FakeSessionEntry[];
  thinkingLevelByModel?: Record<string, string>;
  thinkingLevelOnModelSelect?: Record<string, string>;
};

export function modelKey(model: FakeModel): string {
  return `${model.provider}/${model.id}`;
}

export function createHarness(
  mode: "tui" | "rpc" | "json" | "print" = "tui",
  options: HarnessOptions = {},
) {
  const events = new Map<string, EventHandler[]>();
  const commands = new Map<string, HelmCommand>();
  const notices: Notice[] = [];
  const statuses: Array<{ key: string; text: string }> = [];
  const modelChanges: string[] = [];
  const thinkingLevelChanges: string[] = [];
  const sessionEntries = options.sessionEntries ?? [];
  const baselineModel = { provider: "baseline-provider", id: "baseline-model" };
  const explicitModel = { provider: "user-provider", id: "user-model" };
  const models = [
    baselineModel,
    explicitModel,
    ...(options.initialModel ? [options.initialModel] : []),
    ...Object.values(completeRoutes).map(({ provider, model }) => ({ provider, id: model })),
  ];
  let thinkingLevel = options.initialThinkingLevel ?? "medium";

  async function dispatch(name: string, event: unknown): Promise<unknown> {
    let result: unknown;
    for (const handler of events.get(name) ?? []) {
      result = await handler(event as never, context);
    }
    return result;
  }

  const contextValue = {
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    model: (options.initialModel ?? baselineModel) as FakeModel | undefined,
    signal: options.signal,
    scopedModels: (options.scopedModels ?? []).map((key) => ({
      model: models.find((model) => modelKey(model) === key),
    })),
    sessionManager: {
      getBranch() {
        return [...sessionEntries];
      },
    },
    modelRegistry: {
      find(provider: string, id: string) {
        const key = `${provider}/${id}`;
        if (options.registryErrors?.includes(key)) throw new Error("registry failed");
        if (Object.hasOwn(options.registryResults ?? {}, key)) {
          return options.registryResults?.[key] ?? undefined;
        }
        return models.find((model) => model.provider === provider && model.id === id);
      },
      async getApiKeyForProvider(provider: string) {
        return provider === "openrouter" ? "test-openrouter-key" : undefined;
      },
    },
    ui: {
      notify(message: string, level = "info") {
        notices.push({ message, level });
      },
      setStatus(key: string, text: string | undefined) {
        statuses.push({ key, text: text ?? "" });
      },
    },
  };
  const context = contextValue as unknown as ExtensionCommandContext;

  async function dispatchThinkingLevelSelection(level: string): Promise<void> {
    const previousLevel = thinkingLevel;
    thinkingLevel = level;
    if (level !== previousLevel) {
      await options.beforeThinkingLevelSelectDispatch?.(level);
      await dispatch("thinking_level_select", {
        type: "thinking_level_select",
        level,
        previousLevel,
      });
    }
  }

  async function dispatchModelSelection(model: FakeModel, previousModel: FakeModel | undefined): Promise<void> {
    if (!previousModel || modelKey(previousModel) !== modelKey(model)) {
      await options.beforeModelSelectDispatch?.(model, selectExplicitModel);
      await dispatch("model_select", {
        type: "model_select",
        model,
        previousModel,
        source: "set",
      });
    }
  }

  async function selectExplicitModel(
    model: FakeModel = explicitModel,
    level = "low",
  ): Promise<void> {
    const previousModel = contextValue.model;
    contextValue.model = model;
    await dispatchThinkingLevelSelection(level);
    await dispatchModelSelection(model, previousModel);
  }

  const pi = {
    on(name: string, handler: EventHandler) {
      const handlers = events.get(name) ?? [];
      handlers.push(handler);
      events.set(name, handlers);
    },
    registerCommand(name: string, command: HelmCommand) {
      commands.set(name, command);
    },
    appendEntry(customType: string, data?: unknown) {
      if (options.appendEntryErrors?.shift() ?? options.appendEntryError) {
        throw new Error("session storage unavailable");
      }
      const previous = sessionEntries.at(-1);
      sessionEntries.push({
        type: "custom",
        id: `entry-${sessionEntries.length + 1}`,
        parentId: previous?.id ?? null,
        timestamp: new Date(sessionEntries.length).toISOString(),
        customType,
        data,
      });
    },
    async setModel(model: FakeModel) {
      const key = modelKey(model);
      modelChanges.push(key);
      const configuredResult = options.modelResults?.[key]?.shift();
      if (configuredResult === false || options.unavailableModels?.includes(key)) {
        if (options.mutateModelBeforeFailure?.includes(key)) contextValue.model = model;
        return false;
      }
      await options.beforeModelApplication?.[key]?.();
      const previousModel = contextValue.model;
      const appliedModel = options.appliedModels?.[key]?.shift() ?? model;
      contextValue.model = appliedModel;
      const selectedThinkingLevel = options.thinkingLevelOnModelSelect?.[modelKey(appliedModel)];
      if (selectedThinkingLevel !== undefined) {
        await dispatchThinkingLevelSelection(selectedThinkingLevel);
      }
      await dispatchModelSelection(model, previousModel);
      return true;
    },
    getThinkingLevel() {
      return thinkingLevel;
    },
    setThinkingLevel(level: string) {
      thinkingLevelChanges.push(level);
      const key = contextValue.model ? modelKey(contextValue.model) : "";
      void dispatchThinkingLevelSelection(options.thinkingLevelByModel?.[key] ?? level);
    },
  } as unknown as ExtensionAPI;

  helmExtension(pi);

  return {
    commands,
    events,
    notices,
    statuses,
    context,
    modelChanges,
    thinkingLevelChanges,
    sessionEntries,
    get currentModel() {
      return contextValue.model;
    },
    get thinkingLevel() {
      return thinkingLevel;
    },
    async emit(name: string, event: unknown = {}) {
      return dispatch(name, event);
    },
    async selectModel(model: FakeModel = explicitModel, level = "low") {
      await selectExplicitModel(model, level);
    },
    async selectThinkingLevel(level: string) {
      await dispatchThinkingLevelSelection(level);
    },
    async command(args = "") {
      const command = commands.get("helm");
      if (!command) throw new Error("/helm was not registered");
      await command.handler(args, context);
    },
  };
}

export async function writeHelmConfig(
  agentDir: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await writeFile(
    join(agentDir, "pi-jev-helm.json"),
    JSON.stringify({ schemaVersion: 1, routes: completeRoutes, ...overrides }),
  );
}
