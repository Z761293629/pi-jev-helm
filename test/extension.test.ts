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

function createHarness(mode: "tui" | "rpc" | "json" | "print" = "tui") {
  const events = new Map<string, EventHandler[]>();
  const commands = new Map<string, HelmCommand>();
  const notices: Notice[] = [];

  const pi = {
    on(name: string, handler: EventHandler) {
      const handlers = events.get(name) ?? [];
      handlers.push(handler);
      events.set(name, handlers);
    },
    registerCommand(name: string, command: HelmCommand) {
      commands.set(name, command);
    },
  } as unknown as ExtensionAPI;

  const context = {
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    model: { provider: "baseline-provider", id: "baseline-model" },
    ui: {
      notify(message: string, level = "info") {
        notices.push({ message, level });
      },
    },
  } as unknown as ExtensionCommandContext;

  helmExtension(pi);

  return {
    commands,
    events,
    notices,
    context,
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

    expect([...harness.events.keys()]).toEqual(["session_start"]);
    expect(harness.notices).toEqual([]);
    expect(harness.commands.has("helm")).toBe(true);
  });

  it("does not emit invalid-configuration notifications in machine-readable modes", async () => {
    const harness = createHarness("json");

    await harness.emit("session_start", { reason: "startup" });

    expect(harness.notices).toEqual([]);
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
