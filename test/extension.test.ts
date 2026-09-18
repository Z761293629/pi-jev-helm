import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import helmExtension from "../src/index.js";
import { completeRoutes, restoreAgentDirectory } from "./fixtures.js";

type EventHandler = (event: never, ctx: ExtensionContext) => Promise<unknown> | unknown;
type HelmCommand = {
  getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string }> | null | Promise<Array<{ value: string; label: string }> | null>;
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
};

type Notice = { message: string; level: string };
type FakeModel = { provider: string; id: string };
type HarnessOptions = {
  unavailableModels?: string[];
  modelResults?: Record<string, boolean[]>;
  scopedModels?: string[];
  thinkingLevelByModel?: Record<string, string>;
};

function modelKey(model: FakeModel): string {
  return `${model.provider}/${model.id}`;
}

function createHarness(
  mode: "tui" | "rpc" | "json" | "print" = "tui",
  options: HarnessOptions = {},
) {
  const events = new Map<string, EventHandler[]>();
  const commands = new Map<string, HelmCommand>();
  const notices: Notice[] = [];
  const modelChanges: string[] = [];
  const thinkingLevelChanges: string[] = [];
  const baselineModel = { provider: "baseline-provider", id: "baseline-model" };
  const models = [
    baselineModel,
    ...Object.values(completeRoutes).map(({ provider, model }) => ({ provider, id: model })),
  ];
  let thinkingLevel = "medium";

  const contextValue = {
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    model: baselineModel as FakeModel | undefined,
    scopedModels: (options.scopedModels ?? []).map((key) => ({
      model: models.find((model) => modelKey(model) === key),
    })),
    modelRegistry: {
      find(provider: string, id: string) {
        return models.find((model) => model.provider === provider && model.id === id);
      },
    },
    ui: {
      notify(message: string, level = "info") {
        notices.push({ message, level });
      },
    },
  };
  const context = contextValue as unknown as ExtensionCommandContext;

  const pi = {
    on(name: string, handler: EventHandler) {
      const handlers = events.get(name) ?? [];
      handlers.push(handler);
      events.set(name, handlers);
    },
    registerCommand(name: string, command: HelmCommand) {
      commands.set(name, command);
    },
    async setModel(model: FakeModel) {
      const key = modelKey(model);
      modelChanges.push(key);
      const configuredResult = options.modelResults?.[key]?.shift();
      if (configuredResult === false || options.unavailableModels?.includes(key)) return false;
      contextValue.model = model;
      return true;
    },
    getThinkingLevel() {
      return thinkingLevel;
    },
    setThinkingLevel(level: string) {
      thinkingLevelChanges.push(level);
      const key = contextValue.model ? modelKey(contextValue.model) : "";
      thinkingLevel = options.thinkingLevelByModel?.[key] ?? level;
    },
  } as unknown as ExtensionAPI;

  helmExtension(pi);

  return {
    commands,
    events,
    notices,
    context,
    modelChanges,
    thinkingLevelChanges,
    get currentModel() {
      return contextValue.model;
    },
    get thinkingLevel() {
      return thinkingLevel;
    },
    async emit(name: string, event: unknown = {}) {
      for (const handler of events.get(name) ?? []) {
        await handler(event as never, context);
      }
    },
    async command(args = "") {
      const command = commands.get("helm");
      if (!command) throw new Error("/helm was not registered");
      await command.handler(args, context);
    },
  };
}

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
let agentDir: string;

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), "pi-jev-helm-extension-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
  restoreAgentDirectory(originalAgentDir);
});

async function writeConfig(overrides: Record<string, unknown> = {}): Promise<void> {
  await writeFile(
    join(agentDir, "pi-jev-helm.json"),
    JSON.stringify({ schemaVersion: 1, routes: completeRoutes, ...overrides }),
  );
}

describe("Pi Jev Helm extension", () => {
  it("loads configuration on startup and reload and reports health through /helm", async () => {
    await writeConfig({ automaticRouting: false });
    const harness = createHarness();

    await harness.emit("session_start", { reason: "startup" });
    await harness.command();

    expect(harness.notices.at(-1)).toMatchObject({ level: "info" });
    expect(harness.notices.at(-1)?.message).toContain("Configuration: healthy");
    expect(harness.notices.at(-1)?.message).toContain("Automatic Routing (configured): off");
    expect(harness.notices.at(-1)?.message).toContain("Baseline Model: baseline-provider/baseline-model");

    await writeConfig({ automaticRouting: true, confidenceThreshold: 0.5 });
    await harness.emit("session_start", { reason: "reload" });
    await harness.command();

    expect(harness.notices.at(-1)?.message).toContain("Automatic Routing (configured): on");
    expect(harness.notices.at(-1)?.message).toContain("Confidence threshold: 0.5");
  });

  it("disables Automatic Routing and rejects enabling or Route Override when configuration is invalid", async () => {
    await writeFile(join(agentDir, "pi-jev-helm.json"), JSON.stringify({ schemaVersion: 1, routes: {} }));
    const harness = createHarness();

    await harness.emit("session_start", { reason: "startup" });
    expect(harness.notices).toEqual([]);

    await harness.command("auto on");
    expect(harness.notices.at(-1)).toMatchObject({ level: "error" });
    expect(harness.notices.at(-1)?.message).toContain("cannot enable Automatic Routing");

    await harness.command("route coding");
    expect(harness.notices.at(-1)).toMatchObject({ level: "error" });
    expect(harness.notices.at(-1)?.message).toContain("cannot set a Route Override");

    await harness.command();
    expect(harness.notices.at(-1)?.message).toContain("Configuration: unhealthy");
    expect(harness.notices.at(-1)?.message).toContain("Automatic Routing (session): off");
  });

  it("is inert for ordinary requests when Automatic Routing is disabled", async () => {
    await writeConfig({ automaticRouting: false });
    const harness = createHarness();

    await harness.emit("session_start", { reason: "startup" });

    await harness.emit("before_agent_start", { prompt: "ordinary request" });
    await harness.emit("agent_settled");

    expect(harness.modelChanges).toEqual([]);
    expect(harness.thinkingLevelChanges).toEqual([]);
    expect(harness.notices).toEqual([]);
    expect(harness.commands.has("helm")).toBe(true);
  });

  it("does not emit invalid-configuration notifications in machine-readable modes", async () => {
    const harness = createHarness("json");

    await harness.emit("session_start", { reason: "startup" });

    expect(harness.notices).toEqual([]);
  });

  it("sets, replaces, and clears the one-shot Route Override", async () => {
    await writeConfig();
    const harness = createHarness();
    await harness.emit("session_start", { reason: "startup" });

    await harness.command("route fast");
    await harness.command("route coding");
    await harness.command();
    expect(harness.notices.at(-1)?.message).toContain("Pending Route Override: coding");

    await harness.command("route clear");
    await harness.command();
    expect(harness.notices.at(-1)?.message).toContain("Pending Route Override: none");
  });

  it("applies an override before the first Turn, retains it for the Routed Run, and restores Baseline", async () => {
    await writeConfig({ automaticRouting: false, confidenceThreshold: 1 });
    const harness = createHarness();
    await harness.emit("session_start", { reason: "startup" });
    await harness.command("route coding");

    await harness.emit("before_agent_start", { prompt: "implement this" });
    expect(harness.currentModel).toMatchObject({
      provider: completeRoutes.coding.provider,
      id: completeRoutes.coding.model,
    });
    expect(harness.thinkingLevel).toBe(completeRoutes.coding.thinkingLevel);

    await harness.emit("turn_start", { turnIndex: 1 });
    await harness.emit("tool_execution_start", { toolName: "read" });
    await harness.emit("session_compact_failed", { reason: "overflow", willRetry: true });
    await harness.emit("input", { text: "steer", streamingBehavior: "steer" });
    await harness.emit("before_agent_start", { prompt: "queued follow-up" });
    expect(harness.modelChanges).toEqual(["anthropic/coding/model"]);

    await harness.emit("agent_settled");
    expect(harness.currentModel).toMatchObject({ provider: "baseline-provider", id: "baseline-model" });
    expect(harness.thinkingLevel).toBe("medium");

    await harness.emit("before_agent_start", { prompt: "independent request" });
    expect(harness.modelChanges).toEqual([
      "anthropic/coding/model",
      "baseline-provider/baseline-model",
    ]);
  });

  it("consumes an override even when its target cannot be applied", async () => {
    await writeConfig({ automaticRouting: false });
    const harness = createHarness("tui", { unavailableModels: ["anthropic/coding/model"] });
    await harness.emit("session_start", { reason: "startup" });
    await harness.command("route coding");

    await harness.emit("before_agent_start", { prompt: "first attempt" });
    await harness.emit("before_agent_start", { prompt: "next independent request" });

    expect(harness.modelChanges).toEqual(["anthropic/coding/model"]);
    expect(harness.currentModel).toMatchObject({ provider: "baseline-provider", id: "baseline-model" });
    expect(harness.notices.at(-1)).toMatchObject({ level: "warning" });
  });

  it("retries a failed settlement restoration before the next independent request", async () => {
    await writeConfig({ automaticRouting: false });
    const harness = createHarness("tui", {
      modelResults: { "baseline-provider/baseline-model": [false, true] },
    });
    await harness.emit("session_start", { reason: "startup" });
    await harness.command("route coding");
    await harness.emit("before_agent_start", { prompt: "routed run" });

    await harness.emit("agent_settled");
    expect(harness.currentModel).toMatchObject({
      provider: completeRoutes.coding.provider,
      id: completeRoutes.coding.model,
    });

    await harness.emit("before_agent_start", { prompt: "next independent request" });
    expect(harness.modelChanges).toEqual([
      "anthropic/coding/model",
      "baseline-provider/baseline-model",
      "baseline-provider/baseline-model",
    ]);
    expect(harness.currentModel).toMatchObject({ provider: "baseline-provider", id: "baseline-model" });
    expect(harness.thinkingLevel).toBe("medium");
  });

  it("does not emit routing-failure notifications in RPC mode", async () => {
    await writeConfig({ automaticRouting: false });
    const harness = createHarness("rpc", { unavailableModels: ["anthropic/coding/model"] });
    await harness.emit("session_start", { reason: "startup" });
    await harness.command("route coding");
    harness.notices.length = 0;

    await harness.emit("before_agent_start", { prompt: "route this" });

    expect(harness.notices).toEqual([]);
  });

  it("compensates to Baseline when the target thinking level cannot be applied", async () => {
    await writeConfig({ automaticRouting: false });
    const harness = createHarness("tui", {
      thinkingLevelByModel: { "anthropic/coding/model": "off" },
    });
    await harness.emit("session_start", { reason: "startup" });
    await harness.command("route coding");

    await harness.emit("before_agent_start", { prompt: "partial application" });

    expect(harness.modelChanges).toEqual([
      "anthropic/coding/model",
      "baseline-provider/baseline-model",
    ]);
    expect(harness.thinkingLevelChanges).toEqual(["high", "medium"]);
    expect(harness.currentModel).toMatchObject({ provider: "baseline-provider", id: "baseline-model" });
    expect(harness.thinkingLevel).toBe("medium");
  });

  it("rejects a Route Target outside the current scoped models", async () => {
    await writeConfig({ automaticRouting: false });
    const harness = createHarness("tui", { scopedModels: ["baseline-provider/baseline-model"] });
    await harness.emit("session_start", { reason: "startup" });
    await harness.command("route research");

    await harness.emit("before_agent_start", { prompt: "research this" });
    await harness.command();

    expect(harness.modelChanges).toEqual([]);
    expect(harness.currentModel).toMatchObject({ provider: "baseline-provider", id: "baseline-model" });
    expect(harness.notices.at(-1)?.message).toContain("Pending Route Override: none");
  });

  it.each(["reload", "new", "resume", "fork", "quit"])(
    "discards a pending Route Override on %s teardown",
    async (reason) => {
      await writeConfig();
      const harness = createHarness();
      await harness.emit("session_start", { reason: "startup" });
      await harness.command("route reasoning");

      await harness.emit("session_shutdown", { reason });
      await harness.command();

      expect(harness.notices.at(-1)?.message).toContain("Pending Route Override: none");
    },
  );

  it("keeps an override set during a Routed Run pending until the next independent run", async () => {
    await writeConfig({ automaticRouting: false });
    const harness = createHarness();
    await harness.emit("session_start", { reason: "startup" });
    await harness.command("route fast");
    await harness.emit("before_agent_start", { prompt: "first run" });

    await harness.command("route research");
    await harness.emit("before_agent_start", { prompt: "queued continuation" });
    expect(harness.modelChanges).toEqual(["openrouter/fast/model"]);

    await harness.emit("agent_settled");
    await harness.emit("before_agent_start", { prompt: "second run" });
    expect(harness.modelChanges).toEqual([
      "openrouter/fast/model",
      "baseline-provider/baseline-model",
      "google/research/model",
    ]);
  });

  it("restores Baseline during active-run teardown", async () => {
    await writeConfig({ automaticRouting: false });
    const harness = createHarness();
    await harness.emit("session_start", { reason: "startup" });
    await harness.command("route reasoning");
    await harness.emit("before_agent_start", { prompt: "reason" });

    await harness.emit("session_shutdown", { reason: "reload" });

    expect(harness.currentModel).toMatchObject({ provider: "baseline-provider", id: "baseline-model" });
    expect(harness.thinkingLevel).toBe("medium");
  });

  it("supports runtime Automatic Routing controls without writing configuration", async () => {
    await writeConfig({ automaticRouting: true });
    const harness = createHarness();
    await harness.emit("session_start", { reason: "startup" });

    await harness.command("auto off");
    await harness.command();
    expect(harness.notices.at(-1)?.message).toContain("Automatic Routing (session): off");
    expect(harness.notices.at(-1)?.message).toContain("Session override: off");

    await harness.emit("session_start", { reason: "reload" });
    await harness.command();
    expect(harness.notices.at(-1)?.message).toContain("Automatic Routing (session): on");
    expect(harness.notices.at(-1)?.message).toContain("Session override: none");
  });

  it("offers completions for the supported /helm command grammar", async () => {
    const harness = createHarness();
    const complete = harness.commands.get("helm")?.getArgumentCompletions;

    expect(await complete?.("")).toEqual([
      { value: "auto", label: "auto" },
      { value: "route", label: "route" },
    ]);
    expect(await complete?.("auto ")).toEqual([
      { value: "auto on", label: "auto on" },
      { value: "auto off", label: "auto off" },
    ]);
    expect(await complete?.("route c")).toEqual([
      { value: "route coding", label: "route coding" },
      { value: "route clear", label: "route clear" },
    ]);
  });
});
