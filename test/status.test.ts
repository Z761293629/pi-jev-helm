import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  checkpointData,
  createDecisionsResponse,
  deferred,
  explanationData,
  restoreAgentDirectory,
} from "./fixtures.js";
import { createHarness, modelKey, writeHelmConfig } from "./harness.js";

const HELM_STATUS_KEY = "pi-jev-helm";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
let agentDir: string;

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), "pi-jev-helm-status-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
  restoreAgentDirectory(originalAgentDir);
  vi.unstubAllGlobals();
});

function writeConfig(overrides: Record<string, unknown> = {}): Promise<void> {
  return writeHelmConfig(agentDir, overrides);
}

function lastStatus(harness: ReturnType<typeof createHarness>): { key: string; text: string } {
  const status = harness.statuses.at(-1);
  if (!status) throw new Error("Helm did not render a footer status");
  return status;
}

describe("Helm footer status slot", () => {
  it("uses exactly one footer slot for every state transition", async () => {
    await writeConfig({ automaticRouting: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        createDecisionsResponse({ codeWork: 0.9, deepReasoning: 0.1, externalResearch: 0.1 }),
      ),
    );
    const harness = createHarness();
    await harness.emit("session_start", { reason: "startup" });
    await harness.emit("input", { text: "change this code", source: "interactive" });
    await harness.emit("before_agent_start", { prompt: "change this code" });
    await harness.emit("agent_settled");

    expect(harness.statuses.length).toBeGreaterThan(0);
    expect(harness.statuses.every((status) => status.key === HELM_STATUS_KEY)).toBe(true);
  });

  it("shows the idle automatic state after startup and honors runtime toggles", async () => {
    await writeConfig({ automaticRouting: true });
    const harness = createHarness();
    await harness.emit("session_start", { reason: "startup" });

    expect(lastStatus(harness).text).toContain("auto");

    await harness.command("auto off");
    expect(lastStatus(harness).text).toContain("off");

    await harness.command("auto on");
    expect(lastStatus(harness).text).toContain("auto");
  });

  it("shows the idle off state when Automatic Routing is configured off", async () => {
    await writeConfig({ automaticRouting: false });
    const harness = createHarness();
    await harness.emit("session_start", { reason: "startup" });

    expect(lastStatus(harness).text).toContain("off");
  });

  it("represents a pending Route Override and returns to idle after it is cleared", async () => {
    await writeConfig({ automaticRouting: false });
    const harness = createHarness();
    await harness.emit("session_start", { reason: "startup" });

    await harness.command("route coding");
    expect(lastStatus(harness).text).toContain("override");
    expect(lastStatus(harness).text).toContain("coding");

    await harness.command("route reasoning");
    expect(lastStatus(harness).text).toContain("reasoning");

    await harness.command("route clear");
    expect(lastStatus(harness).text).toContain("off");
  });

  it("shows classification in progress while the Classification Provider is in flight", async () => {
    await writeConfig({ automaticRouting: true });
    const classificationStarted = deferred<void>();
    const classificationResponse = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        classificationStarted.resolve(undefined);
        return classificationResponse.promise;
      }),
    );
    const harness = createHarness();
    await harness.emit("session_start", { reason: "startup" });
    await harness.emit("input", { text: "classify this", source: "interactive" });

    const routing = harness.emit("before_agent_start", { prompt: "classify this" });
    await classificationStarted.promise;

    expect(lastStatus(harness).text).toContain("classifying");

    classificationResponse.resolve(
      createDecisionsResponse({ codeWork: 0.1, deepReasoning: 0.1, externalResearch: 0.1 }),
    );
    await routing;
  });

  it("shows the active Route and Route Target for the whole Routed Run", async () => {
    await writeConfig({ automaticRouting: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        createDecisionsResponse({ codeWork: 0.9, deepReasoning: 0.1, externalResearch: 0.1 }),
      ),
    );
    const harness = createHarness();
    await harness.emit("session_start", { reason: "startup" });

    await harness.emit("input", { text: "change this code", source: "interactive" });
    await harness.emit("before_agent_start", { prompt: "change this code" });

    expect(lastStatus(harness).text).toContain("coding");
    expect(lastStatus(harness).text).toContain("anthropic/coding/model");
  });

  it("marks an Explicit Model Override during the run and resets after settlement", async () => {
    await writeConfig({ automaticRouting: false });
    const harness = createHarness();
    await harness.emit("session_start", { reason: "startup" });
    await harness.command("route coding");
    await harness.emit("before_agent_start", { prompt: "implement this" });

    await harness.selectModel();
    expect(lastStatus(harness).text).toContain("explicit");
    expect(lastStatus(harness).text).toContain("user-provider/user-model");

    await harness.emit("agent_settled");
    expect(lastStatus(harness).text).toContain("off");
    expect(lastStatus(harness).text).not.toContain("explicit");
  });

  it("shows low-confidence fail-open in the status and Routing Explanation without a popup", async () => {
    await writeConfig({ automaticRouting: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        createDecisionsResponse({ codeWork: 0.49, deepReasoning: 0.49, externalResearch: 0.49 }),
      ),
    );
    const harness = createHarness();
    await harness.emit("session_start", { reason: "startup" });

    await harness.emit("input", { text: "unclear request", source: "interactive" });
    await harness.emit("before_agent_start", { prompt: "unclear request" });

    expect(lastStatus(harness).text).toContain("fail-open");
    expect(harness.notices).toEqual([]);
    expect(explanationData(harness.sessionEntries).at(-1)).toEqual(
      expect.objectContaining({
        kind: "routing-attempt",
        outcome: "fail-open",
        failOpen: expect.objectContaining({ reason: "low-confidence" }),
      }),
    );

    await harness.emit("agent_settled");
    expect(lastStatus(harness).text).toContain("auto");
  });

  it("shows fail-open status and a warning when the Route Target is unavailable, then resets", async () => {
    await writeConfig({ automaticRouting: false });
    const harness = createHarness("tui", { unavailableModels: ["anthropic/coding/model"] });
    await harness.emit("session_start", { reason: "startup" });
    await harness.command("route coding");

    await harness.emit("before_agent_start", { prompt: "first attempt" });
    expect(lastStatus(harness).text).toContain("fail-open");
    expect(harness.notices.at(-1)).toMatchObject({ level: "warning" });

    await harness.emit("agent_settled");
    expect(lastStatus(harness).text).toContain("off");
  });

  it("returns to the current idle or pending state after restoration instead of the previous result", async () => {
    await writeConfig({ automaticRouting: false });
    const harness = createHarness();
    await harness.emit("session_start", { reason: "startup" });
    await harness.command("route coding");
    await harness.emit("before_agent_start", { prompt: "implement this" });
    expect(lastStatus(harness).text).toContain("anthropic/coding/model");

    await harness.command("route research");
    await harness.emit("agent_settled");

    expect(lastStatus(harness).text).toContain("override");
    expect(lastStatus(harness).text).toContain("research");
    expect(lastStatus(harness).text).not.toContain("coding");
    expect(lastStatus(harness).text).not.toContain("anthropic/coding/model");
  });

  it("shows the transient restoration state while settlement restoration is in flight", async () => {
    await writeConfig({ automaticRouting: false });
    const restorationStarted = deferred<void>();
    const releaseRestoration = deferred<void>();
    const harness = createHarness("tui", {
      beforeModelApplication: {
        "baseline-provider/baseline-model": async () => {
          restorationStarted.resolve(undefined);
          await releaseRestoration.promise;
        },
      },
    });
    await harness.emit("session_start", { reason: "startup" });
    await harness.command("route coding");
    await harness.emit("before_agent_start", { prompt: "implement this" });

    const settlement = harness.emit("agent_settled");
    await restorationStarted.promise;
    expect(lastStatus(harness).text).toContain("restoring");
    expect(lastStatus(harness).text).not.toContain("restore failed");

    releaseRestoration.resolve(undefined);
    await settlement;
    expect(lastStatus(harness).text).toContain("off");
  });

  it("reports a retained restoration failure in the footer with a warning", async () => {
    await writeConfig({ automaticRouting: false });
    const harness = createHarness("tui", {
      modelResults: { "baseline-provider/baseline-model": [false] },
    });
    await harness.emit("session_start", { reason: "startup" });
    await harness.command("route coding");
    await harness.emit("before_agent_start", { prompt: "routed work" });

    await harness.emit("agent_settled");
    expect(lastStatus(harness).text).toContain("restore failed");
    expect(harness.notices.at(-1)).toMatchObject({ level: "warning" });

    await harness.emit("before_agent_start", { prompt: "retry restoration" });
    expect(lastStatus(harness).text).not.toContain("restore failed");
    expect(checkpointData(harness.sessionEntries).at(-1)).toEqual(
      expect.objectContaining({ status: "complete" }),
    );
  });

  it.each(["rpc", "json", "print"] as const)(
    "emits no footer status, notification, or Helm stdout text in %s mode",
    async (mode) => {
      await writeConfig({ automaticRouting: true });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          createDecisionsResponse({ codeWork: 0.9, deepReasoning: 0.1, externalResearch: 0.1 }),
        ),
      );
      const harness = createHarness(mode);
      await harness.emit("session_start", { reason: "startup" });
      await harness.emit("input", { text: "routed request", source: "interactive" });
      await harness.emit("before_agent_start", { prompt: "routed request" });

      expect(harness.currentModel && modelKey(harness.currentModel)).toBe("anthropic/coding/model");
      expect(harness.statuses).toEqual([]);
      expect(harness.notices).toEqual([]);

      await harness.emit("agent_settled");

      expect(harness.notices).toEqual([]);
      expect(harness.statuses).toEqual([]);
      expect(
        explanationData(harness.sessionEntries).some(
          (entry) =>
            typeof entry === "object" &&
            entry !== null &&
            (entry as { outcome?: string }).outcome === "routed",
        ),
      ).toBe(true);
      expect(
        explanationData(harness.sessionEntries).some(
          (entry) =>
            typeof entry === "object" &&
            entry !== null &&
            (entry as { outcome?: string }).outcome === "restored",
        ),
      ).toBe(true);
    },
  );
});

describe("Helm notification severity boundaries", () => {
  it("reports invalid configuration once as an error notification at startup", async () => {
    await writeFile(join(agentDir, "pi-jev-helm.json"), JSON.stringify({ schemaVersion: 1, routes: {} }));
    const harness = createHarness();
    await harness.emit("session_start", { reason: "startup" });

    expect(harness.notices).toEqual([expect.objectContaining({ level: "error" })]);
    expect(harness.notices[0]?.message).toContain("Pi Jev Helm configuration is invalid");
    expect(lastStatus(harness).text).toContain("config error");
  });

  it.each(["rpc", "json", "print"] as const)(
    "keeps invalid-configuration reporting silent in %s mode",
    async (mode) => {
      await writeFile(
        join(agentDir, "pi-jev-helm.json"),
        JSON.stringify({ schemaVersion: 1, routes: {} }),
      );
      const harness = createHarness(mode);
      await harness.emit("session_start", { reason: "startup" });

      expect(harness.notices).toEqual([]);
    },
  );

  it("warns without leaking details when a protocol failure fails open", async () => {
    await writeConfig({ automaticRouting: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("private malformed body", { status: 200 })),
    );
    const harness = createHarness();
    await harness.emit("session_start", { reason: "startup" });

    await harness.emit("input", { text: "private user message", source: "interactive" });
    await harness.emit("before_agent_start", { prompt: "private user message" });

    expect(harness.notices).toEqual([
      { message: "Automatic Routing classification failed", level: "warning" },
    ]);
    expect(lastStatus(harness).text).toContain("fail-open");
    expect(explanationData(harness.sessionEntries).at(-1)).toEqual(
      expect.objectContaining({
        kind: "routing-attempt",
        outcome: "fail-open",
        failOpen: expect.objectContaining({
          reason: "classification-failed",
          classification: expect.objectContaining({ kind: "protocol" }),
        }),
      }),
    );
    expect(JSON.stringify(harness.notices)).not.toContain("private malformed body");
  });

  it("warns and shows fail-open when the model switch fails, then resets after settlement", async () => {
    await writeConfig({ automaticRouting: false });
    const harness = createHarness("tui", { modelResults: { "anthropic/coding/model": [false] } });
    await harness.emit("session_start", { reason: "startup" });
    await harness.command("route coding");

    await harness.emit("before_agent_start", { prompt: "keep working" });

    expect(harness.notices.at(-1)).toMatchObject({ level: "warning" });
    expect(lastStatus(harness).text).toContain("fail-open");

    await harness.emit("agent_settled");
    expect(lastStatus(harness).text).toContain("off");
  });

  it("stays completely silent for successful routing and restoration", async () => {
    await writeConfig({ automaticRouting: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        createDecisionsResponse({ codeWork: 0.9, deepReasoning: 0.1, externalResearch: 0.1 }),
      ),
    );
    const harness = createHarness();
    await harness.emit("session_start", { reason: "startup" });

    await harness.emit("input", { text: "change this code", source: "interactive" });
    await harness.emit("before_agent_start", { prompt: "change this code" });
    expect(harness.notices).toEqual([]);

    await harness.emit("agent_settled");
    expect(harness.notices).toEqual([]);
    expect(lastStatus(harness).text).toContain("auto");
  });
});

describe("/helm health and state reporting", () => {
  it("reports every specified health and state field", async () => {
    await writeConfig({ automaticRouting: true, confidenceThreshold: 0.8 });
    const harness = createHarness();
    await harness.emit("session_start", { reason: "startup" });
    await harness.command();

    const message = harness.notices.at(-1)?.message ?? "";
    expect(message).toContain("Configuration: healthy");
    expect(message).toContain("Automatic Routing (configured): on");
    expect(message).toContain("Automatic Routing (session): on");
    expect(message).toContain("Pending Route Override: none");
    expect(message).toContain("Current or recent Route: none");
    expect(message).toContain("Baseline Model: baseline-provider/baseline-model");
  });

  it("reports the current Route while a Routed Run is active", async () => {
    await writeConfig({ automaticRouting: false });
    const harness = createHarness();
    await harness.emit("session_start", { reason: "startup" });
    await harness.command("route coding");
    await harness.emit("before_agent_start", { prompt: "implement this" });

    await harness.command();
    expect(harness.notices.at(-1)?.message).toContain("Current or recent Route: coding");
    expect(harness.notices.at(-1)?.message).toContain("Baseline Model: baseline-provider/baseline-model");
  });

  it("reports the recent Route after restoration and reflects session-effective Automatic Routing", async () => {
    await writeConfig({ automaticRouting: false });
    const harness = createHarness();
    await harness.emit("session_start", { reason: "startup" });
    await harness.command("route coding");
    await harness.emit("before_agent_start", { prompt: "implement this" });
    await harness.emit("agent_settled");

    await harness.command("auto on");
    await harness.command();
    const message = harness.notices.at(-1)?.message ?? "";
    expect(message).toContain("Automatic Routing (configured): off");
    expect(message).toContain("Automatic Routing (session): on");
    expect(message).toContain("Session override: on");
    expect(message).toContain("Current or recent Route: coding");
    expect(message).toContain("Pending Route Override: none");
    expect(message).toContain("Baseline Model: baseline-provider/baseline-model");
  });
});
