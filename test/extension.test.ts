import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  checkpointData,
  completeRoutes,
  createDecisionsResponse,
  deferred,
  explanationData,
  restoreAgentDirectory,
} from "./fixtures.js";
import {
  createHarness,
  modelKey,
  writeHelmConfig,
  type FakeModel,
  type FakeSessionEntry,
} from "./harness.js";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
let agentDir: string;

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), "pi-jev-helm-extension-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
  restoreAgentDirectory(originalAgentDir);
  vi.unstubAllGlobals();
});

function writeConfig(overrides: Record<string, unknown> = {}): Promise<void> {
  return writeHelmConfig(agentDir, overrides);
}

async function interruptCodingRouteTarget(): Promise<FakeSessionEntry[]> {
  await writeConfig({ automaticRouting: false });
  const sessionEntries: FakeSessionEntry[] = [];
  const interrupted = createHarness("tui", { sessionEntries });
  await interrupted.emit("session_start", { reason: "startup" });
  await interrupted.command("route coding");
  await interrupted.emit("before_agent_start", { prompt: "interrupted work" });
  return sessionEntries;
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
    expect(harness.notices).toEqual([expect.objectContaining({ level: "error" })]);

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

    await harness.emit("input", { text: "ordinary request", source: "interactive" });
    await harness.emit("before_agent_start", { prompt: "ordinary request" });
    await harness.emit("agent_settled");

    expect(harness.modelChanges).toEqual([]);
    expect(harness.thinkingLevelChanges).toEqual([]);
    expect(harness.notices).toEqual([]);
    expect(harness.commands.has("helm")).toBe(true);
  });

  it.each([
    [{ codeWork: 0.1, deepReasoning: 0.1, externalResearch: 0.1 }, "openrouter/fast/model"],
    [{ codeWork: 0.1, deepReasoning: 0.9, externalResearch: 0.1 }, "openai/reasoning/model"],
    [{ codeWork: 0.9, deepReasoning: 0.9, externalResearch: 0.1 }, "anthropic/coding/model"],
    [{ codeWork: 0.9, deepReasoning: 0.9, externalResearch: 0.9 }, "google/research/model"],
  ] as const)(
    "automatically applies the configured Route Target for classification %j",
    async (probabilities, expectedModel) => {
      await writeConfig({ automaticRouting: true });
      const transport = vi.fn(async () => createDecisionsResponse(probabilities));
      vi.stubGlobal("fetch", transport);
      const harness = createHarness();
      await harness.emit("session_start", { reason: "startup" });

      await harness.emit("input", { text: "classify this exact request", source: "interactive" });
      await harness.emit("before_agent_start", { prompt: "classify this exact request" });

      expect(transport).toHaveBeenCalledTimes(1);
      expect(harness.currentModel && modelKey(harness.currentModel)).toBe(expectedModel);
    },
  );

  it("fails open to Baseline when an Automatic Routing target cannot be applied", async () => {
    await writeConfig({ automaticRouting: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        createDecisionsResponse({ codeWork: 0.9, deepReasoning: 0.1, externalResearch: 0.1 }),
      ),
    );
    const harness = createHarness("tui", { unavailableModels: ["anthropic/coding/model"] });
    await harness.emit("session_start", { reason: "startup" });

    await harness.emit("input", { text: "change this code", source: "interactive" });
    await harness.emit("before_agent_start", { prompt: "change this code" });

    expect(harness.modelChanges).toEqual([
      "anthropic/coding/model",
      "baseline-provider/baseline-model",
    ]);
    expect(harness.currentModel).toMatchObject({ provider: "baseline-provider", id: "baseline-model" });
    expect(harness.thinkingLevel).toBe("medium");
    expect(harness.notices.at(-1)).toMatchObject({ level: "warning" });
  });

  it("classifies the unexpanded current user message", async () => {
    await writeConfig({ automaticRouting: true });
    const transport = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      createDecisionsResponse({ codeWork: 0.1, deepReasoning: 0.1, externalResearch: 0.9 }),
    );
    vi.stubGlobal("fetch", transport);
    const harness = createHarness();
    await harness.emit("session_start", { reason: "startup" });

    const currentUserMessage = "/skill:research current OpenRouter docs";
    await harness.emit("input", {
      text: currentUserMessage,
      source: "interactive",
      streamingBehavior: undefined,
    });
    await harness.emit("before_agent_start", {
      prompt: "<expanded research skill> current OpenRouter docs",
    });

    const request = transport.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(JSON.parse(String(request?.body))).toMatchObject({ state: currentUserMessage });
  });

  it("classifies only the initial message of a Routed Run, including after low-confidence fail-open", async () => {
    await writeConfig({ automaticRouting: true, confidenceThreshold: 0.75 });
    const transport = vi.fn(async () =>
      createDecisionsResponse({ codeWork: 0.49, deepReasoning: 0.49, externalResearch: 0.49 }),
    );
    vi.stubGlobal("fetch", transport);
    const harness = createHarness();
    await harness.emit("session_start", { reason: "startup" });

    await harness.emit("input", { text: "initial message", source: "interactive" });
    await harness.emit("before_agent_start", { prompt: "initial message" });
    await harness.emit("input", {
      text: "queued continuation",
      source: "interactive",
      streamingBehavior: "followUp",
    });
    await harness.emit("before_agent_start", { prompt: "queued continuation" });

    expect(transport).toHaveBeenCalledTimes(1);
    expect(harness.modelChanges).toEqual([]);
    expect(harness.notices).toEqual([]);

    await harness.emit("agent_settled");
    await harness.emit("input", { text: "next independent request", source: "interactive" });
    await harness.emit("before_agent_start", { prompt: "next independent request" });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("fails open with a safe warning when classification is rejected", async () => {
    await writeConfig({ automaticRouting: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "authentication_failed",
              message: "account=user-123 key=upstream-secret",
            },
          }),
          { status: 401 },
        ),
      ),
    );
    const harness = createHarness();
    await harness.emit("session_start", { reason: "startup" });

    await harness.emit("input", { text: "private user message", source: "interactive" });
    await harness.emit("before_agent_start", { prompt: "private user message" });

    expect(harness.modelChanges).toEqual([]);
    expect(harness.currentModel).toMatchObject({ provider: "baseline-provider", id: "baseline-model" });
    expect(harness.notices).toEqual([
      { message: "Automatic Routing classification failed", level: "warning" },
    ]);
    expect(JSON.stringify(harness.notices)).not.toContain("private user message");
    expect(JSON.stringify(harness.notices)).not.toContain("user-123");
    expect(JSON.stringify(harness.notices)).not.toContain("upstream-secret");
  });

  it("forwards Routed Run cancellation and ends in-flight classification quietly", async () => {
    await writeConfig({ automaticRouting: true });
    const controller = new AbortController();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        markStarted();
        return await new Promise<Response>((resolve) => {
          controller.signal.addEventListener(
            "abort",
            () => resolve(
              createDecisionsResponse({ codeWork: 0.9, deepReasoning: 0.1, externalResearch: 0.1 }),
            ),
            { once: true },
          );
        });
      }),
    );
    const harness = createHarness("tui", { signal: controller.signal });
    await harness.emit("session_start", { reason: "startup" });
    await harness.emit("input", { text: "private user message", source: "interactive" });

    const pendingStart = harness.emit("before_agent_start", { prompt: "private user message" });
    await started;
    controller.abort();
    await pendingStart;

    expect(harness.modelChanges).toEqual([]);
    expect(harness.currentModel).toMatchObject({ provider: "baseline-provider", id: "baseline-model" });
    expect(harness.notices).toEqual([]);
  });

  it("warns when the transport aborts without Routed Run cancellation", async () => {
    await writeConfig({ automaticRouting: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("private cancellation reason", "AbortError");
      }),
    );
    const harness = createHarness();
    await harness.emit("session_start", { reason: "startup" });

    await harness.emit("input", { text: "private user message", source: "interactive" });
    await harness.emit("before_agent_start", { prompt: "private user message" });

    expect(harness.modelChanges).toEqual([]);
    expect(harness.currentModel).toMatchObject({ provider: "baseline-provider", id: "baseline-model" });
    expect(harness.notices).toEqual([
      { message: "Automatic Routing classification failed", level: "warning" },
    ]);
    expect(JSON.stringify(harness.notices)).not.toContain("private cancellation reason");
  });

  it.each(["rpc", "json", "print"] as const)(
    "fails open without a notification in %s mode",
    async (mode) => {
      await writeConfig({ automaticRouting: true });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("private malformed response", { status: 200 })),
      );
      const harness = createHarness(mode);
      await harness.emit("session_start", { reason: "startup" });

      await harness.emit("input", { text: "private user message", source: "interactive" });
      await harness.emit("before_agent_start", { prompt: "private user message" });

      expect(harness.modelChanges).toEqual([]);
      expect(harness.currentModel).toMatchObject({ provider: "baseline-provider", id: "baseline-model" });
      expect(harness.notices).toEqual([]);
    },
  );

  it("catches unexpected Classification Provider errors at the Routed Run boundary", async () => {
    await writeConfig({ automaticRouting: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("private programming detail");
      }),
    );
    const harness = createHarness();
    await harness.emit("session_start", { reason: "startup" });

    await harness.emit("input", { text: "private user message", source: "interactive" });
    await expect(
      harness.emit("before_agent_start", { prompt: "private user message" }),
    ).resolves.toBeUndefined();

    expect(harness.modelChanges).toEqual([]);
    expect(harness.currentModel).toMatchObject({ provider: "baseline-provider", id: "baseline-model" });
    expect(harness.notices).toEqual([
      { message: "Automatic Routing classification failed", level: "warning" },
    ]);
    expect(JSON.stringify(harness.notices)).not.toContain("private programming detail");
  });

  it("uses runtime Automatic Routing controls without persisting them", async () => {
    await writeConfig({ automaticRouting: true });
    const transport = vi.fn(async () =>
      createDecisionsResponse({ codeWork: 0.1, deepReasoning: 0.1, externalResearch: 0.1 }),
    );
    vi.stubGlobal("fetch", transport);
    const harness = createHarness();
    await harness.emit("session_start", { reason: "startup" });

    await harness.command("auto off");
    await harness.emit("input", { text: "bypassed request", source: "interactive" });
    await harness.emit("before_agent_start", { prompt: "bypassed request" });
    await harness.emit("agent_settled");
    expect(transport).not.toHaveBeenCalled();

    await harness.command("auto on");
    await harness.emit("input", { text: "automatically routed request", source: "interactive" });
    await harness.emit("before_agent_start", { prompt: "automatically routed request" });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("gives a pending Route Override priority over Automatic Routing", async () => {
    await writeConfig({ automaticRouting: true });
    const transport = vi.fn(async () =>
      createDecisionsResponse({ codeWork: 0.1, deepReasoning: 0.1, externalResearch: 0.9 }),
    );
    vi.stubGlobal("fetch", transport);
    const harness = createHarness();
    await harness.emit("session_start", { reason: "startup" });
    await harness.command("route coding");

    await harness.emit("before_agent_start", { prompt: "override this request" });

    expect(transport).not.toHaveBeenCalled();
    expect(harness.currentModel && modelKey(harness.currentModel)).toBe("anthropic/coding/model");
  });

  it.each(["rpc", "json", "print"] as const)(
    "does not emit invalid-configuration notifications in machine-readable %s mode",
    async (mode) => {
      const harness = createHarness(mode);

      await harness.emit("session_start", { reason: "startup" });

      expect(harness.notices).toEqual([]);
    },
  );

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

  it("persists and completes a recoverable Baseline checkpoint around a Routed Run", async () => {
    await writeConfig({ automaticRouting: false });
    const harness = createHarness();
    await harness.emit("session_start", { reason: "startup" });
    await harness.command("route coding");

    await harness.emit("before_agent_start", { prompt: "implement this" });
    expect(checkpointData(harness.sessionEntries)).toEqual([
      expect.objectContaining({
        schemaVersion: 1,
        status: "pending",
        baseline: {
          provider: "baseline-provider",
          model: "baseline-model",
          thinkingLevel: "medium",
        },
      }),
    ]);
    expect(explanationData(harness.sessionEntries)).toEqual([
      expect.objectContaining({
        kind: "routing-attempt",
        source: "route-override",
        outcome: "routed",
        route: "coding",
      }),
    ]);

    await harness.emit("agent_settled");
    expect(checkpointData(harness.sessionEntries)).toEqual([
      expect.objectContaining({ status: "pending" }),
      expect.objectContaining({ status: "complete" }),
    ]);
    expect(explanationData(harness.sessionEntries)).toEqual([
      expect.objectContaining({ kind: "routing-attempt", outcome: "routed" }),
      expect.objectContaining({ kind: "restoration", outcome: "restored" }),
    ]);
  });

  it("cancels pending Route Target application during teardown and restores Baseline", async () => {
    await writeConfig({ automaticRouting: false });
    const targetApplicationStarted = deferred<void>();
    const releaseTargetApplication = deferred<void>();
    const harness = createHarness("tui", {
      beforeModelApplication: {
        "anthropic/coding/model": async () => {
          targetApplicationStarted.resolve(undefined);
          await releaseTargetApplication.promise;
        },
      },
    });
    await harness.emit("session_start", { reason: "startup" });
    await harness.command("route coding");

    const routing = harness.emit("before_agent_start", { prompt: "interrupted startup" });
    await targetApplicationStarted.promise;
    await harness.emit("session_shutdown", { reason: "reload" });
    releaseTargetApplication.resolve(undefined);
    await routing;

    expect(harness.currentModel).toMatchObject({
      provider: "baseline-provider",
      id: "baseline-model",
    });
    expect(harness.thinkingLevel).toBe("medium");
    expect(checkpointData(harness.sessionEntries).at(-1)).toEqual(
      expect.objectContaining({ status: "complete" }),
    );
    expect(explanationData(harness.sessionEntries)).toEqual([
      expect.objectContaining({
        kind: "routing-attempt",
        outcome: "fail-open",
        failOpen: expect.objectContaining({
          reason: "superseded-by-explicit-choice",
          baselineRetained: true,
        }),
      }),
      expect.objectContaining({ kind: "restoration", outcome: "restored" }),
    ]);
  });

  it.each(["reload", "new", "resume", "fork", "quit"] as const)(
    "restores and completes the Baseline checkpoint before %s teardown",
    async (reason) => {
      await writeConfig({ automaticRouting: false });
      const harness = createHarness();
      await harness.emit("session_start", { reason: "startup" });
      await harness.command("route reasoning");
      await harness.emit("before_agent_start", { prompt: "reason" });

      await harness.emit("session_shutdown", { reason });

      expect(harness.currentModel).toMatchObject({
        provider: "baseline-provider",
        id: "baseline-model",
      });
      expect(harness.thinkingLevel).toBe("medium");
      expect(checkpointData(harness.sessionEntries).at(-1)).toEqual(
        expect.objectContaining({ status: "complete" }),
      );
      expect(explanationData(harness.sessionEntries).at(-1)).toEqual(
        expect.objectContaining({ kind: "restoration", outcome: "restored" }),
      );
    },
  );

  it("recovers an incomplete checkpoint before a restarted session accepts work", async () => {
    const sessionEntries = await interruptCodingRouteTarget();

    const restarted = createHarness("tui", {
      sessionEntries,
      initialModel: {
        provider: completeRoutes.coding.provider,
        id: completeRoutes.coding.model,
      },
      initialThinkingLevel: completeRoutes.coding.thinkingLevel,
    });
    await restarted.emit("session_start", { reason: "startup" });

    expect(restarted.modelChanges).toEqual(["baseline-provider/baseline-model"]);
    expect(restarted.currentModel).toMatchObject({
      provider: "baseline-provider",
      id: "baseline-model",
    });
    expect(restarted.thinkingLevel).toBe("medium");
    expect(checkpointData(sessionEntries)).toEqual([
      expect.objectContaining({ status: "pending" }),
      expect.objectContaining({ status: "complete" }),
    ]);
    expect(explanationData(sessionEntries)).toEqual([
      expect.objectContaining({ kind: "routing-attempt", source: "route-override", outcome: "routed" }),
      expect.objectContaining({ kind: "restoration", outcome: "restored" }),
    ]);
  });

  it("records an unresolvable recovery failure and lets an Explicit Model Override repair it", async () => {
    const sessionEntries = await interruptCodingRouteTarget();

    const restarted = createHarness("tui", {
      sessionEntries,
      initialModel: {
        provider: completeRoutes.coding.provider,
        id: completeRoutes.coding.model,
      },
      initialThinkingLevel: completeRoutes.coding.thinkingLevel,
      registryResults: { "baseline-provider/baseline-model": null },
    });
    await restarted.emit("session_start", { reason: "startup" });

    expect(checkpointData(sessionEntries).at(-1)).toEqual(
      expect.objectContaining({ status: "restoration_failed" }),
    );
    await restarted.selectThinkingLevel("xhigh");
    expect(checkpointData(sessionEntries).at(-1)).toEqual(
      expect.objectContaining({
        status: "pending",
        baseline: {
          provider: "baseline-provider",
          model: "baseline-model",
          thinkingLevel: "xhigh",
        },
      }),
    );

    await restarted.selectModel();
    expect(checkpointData(sessionEntries).at(-1)).toEqual(
      expect.objectContaining({
        status: "complete",
        baseline: {
          provider: "user-provider",
          model: "user-model",
          thinkingLevel: "low",
        },
      }),
    );
    expect(explanationData(sessionEntries).at(-2)).toEqual(
      expect.objectContaining({
        kind: "explicit-override",
        override: expect.objectContaining({ kind: "model" }),
      }),
    );
    expect(explanationData(sessionEntries).at(-1)).toEqual(
      expect.objectContaining({ kind: "restoration", outcome: "superseded" }),
    );
  });

  it("handles idle input without starting work until checkpoint recovery succeeds", async () => {
    const sessionEntries = await interruptCodingRouteTarget();
    const restarted = createHarness("tui", {
      sessionEntries,
      initialModel: {
        provider: completeRoutes.coding.provider,
        id: completeRoutes.coding.model,
      },
      initialThinkingLevel: completeRoutes.coding.thinkingLevel,
      modelResults: { "baseline-provider/baseline-model": [false, false, true] },
    });
    await restarted.emit("session_start", { reason: "startup" });

    await expect(
      restarted.emit("input", { text: "must wait", source: "interactive" }),
    ).resolves.toEqual({ action: "handled" });
    expect(restarted.currentModel).toMatchObject({
      provider: completeRoutes.coding.provider,
      id: completeRoutes.coding.model,
    });

    await expect(
      restarted.emit("input", { text: "can proceed", source: "interactive" }),
    ).resolves.toEqual({ action: "continue" });
    expect(restarted.currentModel).toMatchObject({
      provider: "baseline-provider",
      id: "baseline-model",
    });
    expect(checkpointData(sessionEntries).at(-1)).toEqual(
      expect.objectContaining({ status: "complete" }),
    );
    expect(explanationData(sessionEntries).at(-1)).toEqual(
      expect.objectContaining({ kind: "restoration", outcome: "restored" }),
    );
  });

  it("records a failed recovery explicitly and retries it before new work", async () => {
    const sessionEntries = await interruptCodingRouteTarget();

    const restarted = createHarness("tui", {
      sessionEntries,
      initialModel: {
        provider: completeRoutes.coding.provider,
        id: completeRoutes.coding.model,
      },
      initialThinkingLevel: completeRoutes.coding.thinkingLevel,
      modelResults: { "baseline-provider/baseline-model": [false, true] },
    });
    await restarted.emit("session_start", { reason: "startup" });

    expect(checkpointData(sessionEntries).at(-1)).toEqual(
      expect.objectContaining({ status: "restoration_failed" }),
    );
    expect(explanationData(sessionEntries).at(-1)).toEqual(
      expect.objectContaining({ kind: "restoration", outcome: "failed" }),
    );
    expect(sessionEntries.map((entry) => (entry.data as { status?: string }).status)).not.toContain(
      "complete",
    );
    expect(restarted.currentModel).toMatchObject({
      provider: completeRoutes.coding.provider,
      id: completeRoutes.coding.model,
    });
    expect(restarted.notices.at(-1)).toMatchObject({ level: "warning" });

    await restarted.emit("before_agent_start", { prompt: "new work" });
    expect(restarted.currentModel).toMatchObject({
      provider: "baseline-provider",
      id: "baseline-model",
    });
    expect(checkpointData(sessionEntries).at(-1)).toEqual(
      expect.objectContaining({ status: "complete" }),
    );
    expect(explanationData(sessionEntries).at(-1)).toEqual(
      expect.objectContaining({ kind: "restoration", outcome: "restored" }),
    );
  });

  it("keeps the pending checkpoint recoverable when recording restoration failure fails", async () => {
    await writeConfig({ automaticRouting: false });
    const sessionEntries: FakeSessionEntry[] = [];
    const interrupted = createHarness("tui", {
      sessionEntries,
      appendEntryErrors: [false, true, true, true],
      modelResults: { "baseline-provider/baseline-model": [false] },
    });
    await interrupted.emit("session_start", { reason: "startup" });
    await interrupted.command("route coding");
    await interrupted.emit("before_agent_start", { prompt: "interrupted work" });

    await interrupted.emit("session_shutdown", { reason: "quit" });

    expect(interrupted.notices.at(-1)?.message).toContain(
      "could not record the checkpoint restoration failure",
    );
    expect(checkpointData(sessionEntries).at(-1)).toMatchObject({ status: "pending" });
    expect(explanationData(sessionEntries)).toEqual([]);

    const restarted = createHarness("tui", {
      sessionEntries,
      initialModel: { provider: completeRoutes.coding.provider, id: completeRoutes.coding.model },
      initialThinkingLevel: completeRoutes.coding.thinkingLevel,
    });
    await restarted.emit("session_start", { reason: "startup" });

    expect(restarted.currentModel).toMatchObject({
      provider: "baseline-provider",
      id: "baseline-model",
    });
    expect(checkpointData(sessionEntries).at(-1)).toMatchObject({ status: "complete" });
    expect(explanationData(sessionEntries).at(-1)).toEqual(
      expect.objectContaining({ kind: "restoration", outcome: "restored" }),
    );
  });

  it("does not apply a Route Target when a recoverable checkpoint cannot be written", async () => {
    await writeConfig({ automaticRouting: false });
    const harness = createHarness("tui", { appendEntryError: true });
    await harness.emit("session_start", { reason: "startup" });
    await harness.command("route coding");

    await harness.emit("before_agent_start", { prompt: "do not risk temporary state" });

    expect(harness.modelChanges).toEqual([]);
    expect(harness.currentModel).toMatchObject({
      provider: "baseline-provider",
      id: "baseline-model",
    });
    expect(harness.notices.at(-1)).toMatchObject({ level: "warning" });
  });

  it("completes a failed restoration checkpoint when an Explicit Model Override supersedes it", async () => {
    await writeConfig({ automaticRouting: false });
    const harness = createHarness("tui", {
      modelResults: { "baseline-provider/baseline-model": [false] },
    });
    await harness.emit("session_start", { reason: "startup" });
    await harness.command("route coding");
    await harness.emit("before_agent_start", { prompt: "routed work" });
    await harness.emit("agent_settled");

    await harness.selectModel();

    expect(harness.currentModel).toMatchObject({ provider: "user-provider", id: "user-model" });
    expect(checkpointData(harness.sessionEntries).at(-1)).toEqual(
      expect.objectContaining({
        status: "complete",
        baseline: expect.objectContaining({
          provider: "user-provider",
          model: "user-model",
        }),
      }),
    );
    expect(explanationData(harness.sessionEntries).at(-1)).toEqual(
      expect.objectContaining({ kind: "restoration", outcome: "superseded" }),
    );

    const changesBeforeNextWork = [...harness.modelChanges];
    await harness.emit("before_agent_start", { prompt: "next work" });
    expect(harness.modelChanges).toEqual(changesBeforeNextWork);
  });

  it("updates the recoverable checkpoint for an Explicit Thinking Override", async () => {
    await writeConfig({ automaticRouting: false });
    const harness = createHarness();
    await harness.emit("session_start", { reason: "startup" });
    await harness.command("route coding");
    await harness.emit("before_agent_start", { prompt: "implement this" });

    await harness.selectThinkingLevel("xhigh");
    expect(checkpointData(harness.sessionEntries)).toEqual([
      expect.objectContaining({ status: "pending" }),
      expect.objectContaining({
        status: "pending",
        baseline: expect.objectContaining({ thinkingLevel: "xhigh" }),
      }),
    ]);
    expect(explanationData(harness.sessionEntries)).toEqual([
      expect.objectContaining({ kind: "routing-attempt", outcome: "routed" }),
      expect.objectContaining({
        kind: "explicit-override",
        override: { kind: "thinking", thinkingLevel: "xhigh" },
      }),
    ]);

    await harness.emit("agent_settled");
    expect(harness.thinkingLevel).toBe("xhigh");
    expect(checkpointData(harness.sessionEntries).at(-1)).toEqual(
      expect.objectContaining({
        status: "complete",
        baseline: expect.objectContaining({ thinkingLevel: "xhigh" }),
      }),
    );
    expect(explanationData(harness.sessionEntries).at(-1)).toEqual(
      expect.objectContaining({
        kind: "restoration",
        outcome: "restored",
        baseline: expect.objectContaining({ thinkingLevel: "xhigh" }),
      }),
    );
  });

  it("checkpoints an Explicit Model Override before its model_select notification", async () => {
    await writeConfig({ automaticRouting: false });
    const selectionReachedModelEvent = deferred<void>();
    const releaseModelEvent = deferred<void>();
    const harness = createHarness("tui", {
      beforeModelSelectDispatch: async (model) => {
        if (modelKey(model) === "user-provider/user-model") {
          selectionReachedModelEvent.resolve(undefined);
          await releaseModelEvent.promise;
        }
      },
    });
    await harness.emit("session_start", { reason: "startup" });
    await harness.command("route coding");
    await harness.emit("before_agent_start", { prompt: "implement this" });

    const selection = harness.selectModel();
    await selectionReachedModelEvent.promise;

    expect(checkpointData(harness.sessionEntries).at(-1)).toEqual(
      expect.objectContaining({
        status: "pending",
        baseline: {
          provider: "user-provider",
          model: "user-model",
          thinkingLevel: "low",
        },
      }),
    );

    releaseModelEvent.resolve(undefined);
    await selection;
  });

  it("updates and completes the recoverable checkpoint for an Explicit Model Override", async () => {
    await writeConfig({ automaticRouting: false });
    const harness = createHarness();
    await harness.emit("session_start", { reason: "startup" });
    await harness.command("route coding");
    await harness.emit("before_agent_start", { prompt: "implement this" });

    await harness.selectModel();

    expect(checkpointData(harness.sessionEntries)).toEqual([
      expect.objectContaining({ status: "pending" }),
      expect.objectContaining({
        status: "pending",
        baseline: {
          provider: "user-provider",
          model: "user-model",
          thinkingLevel: "low",
        },
      }),
      expect.objectContaining({
        status: "pending",
        baseline: {
          provider: "user-provider",
          model: "user-model",
          thinkingLevel: "low",
        },
      }),
      expect.objectContaining({
        status: "complete",
        baseline: {
          provider: "user-provider",
          model: "user-model",
          thinkingLevel: "low",
        },
      }),
    ]);
    expect(explanationData(harness.sessionEntries)).toEqual([
      expect.objectContaining({ kind: "routing-attempt", outcome: "routed", route: "coding" }),
      expect.objectContaining({
        kind: "explicit-override",
        override: { kind: "thinking", thinkingLevel: "low" },
      }),
      expect.objectContaining({
        kind: "explicit-override",
        override: expect.objectContaining({ kind: "model" }),
      }),
      expect.objectContaining({ kind: "restoration", outcome: "superseded" }),
    ]);
  });

  it("lets an Explicit Model Override supersede an active Routed Run and become the Baseline Model", async () => {
    await writeConfig({ automaticRouting: false });
    const harness = createHarness();
    await harness.emit("session_start", { reason: "startup" });
    await harness.command("route coding");
    await harness.emit("before_agent_start", { prompt: "implement this" });

    await harness.selectModel();
    await harness.emit("agent_settled");

    expect(harness.currentModel).toMatchObject({ provider: "user-provider", id: "user-model" });
    expect(harness.thinkingLevel).toBe("low");
    expect(harness.modelChanges).toEqual(["anthropic/coding/model"]);
  });

  it("preserves an Explicit Model Override that arrives during settlement restoration", async () => {
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
    await harness.selectModel();
    releaseRestoration.resolve(undefined);
    await settlement;

    expect(harness.currentModel).toMatchObject({ provider: "user-provider", id: "user-model" });
    expect(harness.thinkingLevel).toBe("low");
    expect(harness.modelChanges).toEqual([
      "anthropic/coding/model",
      "baseline-provider/baseline-model",
      "user-provider/user-model",
    ]);
  });

  it("does not treat a delayed Helm thinking event as an Explicit Thinking Override", async () => {
    await writeConfig({ automaticRouting: false });
    const targetThinkingSelectionStarted = deferred<void>();
    const releaseTargetThinkingSelection = deferred<void>();
    const targetThinkingEventObserved = deferred<void>();
    const harness = createHarness("tui", {
      beforeThinkingLevelSelectDispatch: async (level) => {
        if (level === completeRoutes.coding.thinkingLevel) {
          targetThinkingSelectionStarted.resolve(undefined);
          await releaseTargetThinkingSelection.promise;
        }
      },
    });
    harness.events.get("thinking_level_select")?.push(() => {
      targetThinkingEventObserved.resolve(undefined);
    });
    await harness.emit("session_start", { reason: "startup" });
    await harness.command("route coding");

    const routing = harness.emit("before_agent_start", { prompt: "implement this" });
    await targetThinkingSelectionStarted.promise;
    await routing;
    releaseTargetThinkingSelection.resolve(undefined);
    await targetThinkingEventObserved.promise;
    await harness.emit("agent_settled");

    expect(harness.thinkingLevel).toBe("medium");
    expect(checkpointData(harness.sessionEntries).at(-1)).toEqual(
      expect.objectContaining({
        status: "complete",
        baseline: expect.objectContaining({ thinkingLevel: "medium" }),
      }),
    );
    expect(explanationData(harness.sessionEntries)).toEqual([
      expect.objectContaining({ kind: "routing-attempt", outcome: "routed", route: "coding" }),
      expect.objectContaining({ kind: "restoration", outcome: "restored" }),
    ]);
  });

  it("does not treat Helm's model clamping as an Explicit Thinking Override", async () => {
    await writeConfig({ automaticRouting: false });
    const harness = createHarness("tui", {
      thinkingLevelOnModelSelect: { "anthropic/coding/model": "off" },
    });
    await harness.emit("session_start", { reason: "startup" });
    await harness.command("route coding");

    await harness.emit("before_agent_start", { prompt: "implement this" });
    await harness.emit("agent_settled");

    expect(harness.currentModel).toMatchObject({ provider: "baseline-provider", id: "baseline-model" });
    expect(harness.thinkingLevel).toBe("medium");
  });

  it("cancels pending automatic application for an Explicit Model Override during classification", async () => {
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
    await harness.selectModel();
    classificationResponse.resolve(
      createDecisionsResponse({ codeWork: 0.9, deepReasoning: 0.1, externalResearch: 0.1 }),
    );
    await routing;

    expect(harness.currentModel).toMatchObject({ provider: "user-provider", id: "user-model" });
    expect(harness.thinkingLevel).toBe("low");
    expect(harness.modelChanges).toEqual([]);
  });

  it("cancels pending automatic application for an Explicit Thinking Override during classification", async () => {
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
    await harness.selectThinkingLevel("high");
    classificationResponse.resolve(
      createDecisionsResponse({ codeWork: 0.9, deepReasoning: 0.1, externalResearch: 0.1 }),
    );
    await routing;

    expect(harness.currentModel).toMatchObject({ provider: "baseline-provider", id: "baseline-model" });
    expect(harness.thinkingLevel).toBe("high");
    expect(harness.modelChanges).toEqual([]);
  });

  it("restores an Explicit Model Override that arrives while Route Target application is pending", async () => {
    await writeConfig({ automaticRouting: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        createDecisionsResponse({ codeWork: 0.9, deepReasoning: 0.1, externalResearch: 0.1 }),
      ),
    );
    const modelApplicationStarted = deferred<void>();
    const releaseModelApplication = deferred<void>();
    const harness = createHarness("tui", {
      beforeModelApplication: {
        "anthropic/coding/model": async () => {
          modelApplicationStarted.resolve(undefined);
          await releaseModelApplication.promise;
        },
      },
    });
    await harness.emit("session_start", { reason: "startup" });
    await harness.emit("input", { text: "classify this", source: "interactive" });

    const routing = harness.emit("before_agent_start", { prompt: "classify this" });
    await modelApplicationStarted.promise;
    await harness.selectModel();
    releaseModelApplication.resolve(undefined);
    await routing;

    expect(harness.currentModel).toMatchObject({ provider: "user-provider", id: "user-model" });
    expect(harness.thinkingLevel).toBe("low");
    expect(harness.modelChanges).toEqual([
      "anthropic/coding/model",
      "user-provider/user-model",
    ]);
  });

  it("preserves the latest Explicit Model Override when another selection arrives during compensation", async () => {
    await writeConfig({ automaticRouting: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        createDecisionsResponse({ codeWork: 0.9, deepReasoning: 0.1, externalResearch: 0.1 }),
      ),
    );
    const targetApplicationStarted = deferred<void>();
    const releaseTargetApplication = deferred<void>();
    const compensationStarted = deferred<void>();
    const releaseCompensation = deferred<void>();
    const retryStarted = deferred<void>();
    const releaseRetry = deferred<void>();
    const harness = createHarness("tui", {
      beforeModelApplication: {
        "anthropic/coding/model": async () => {
          targetApplicationStarted.resolve(undefined);
          await releaseTargetApplication.promise;
        },
        "user-provider/user-model": async () => {
          compensationStarted.resolve(undefined);
          await releaseCompensation.promise;
        },
        "newer-provider/newer-model": async () => {
          retryStarted.resolve(undefined);
          await releaseRetry.promise;
        },
      },
    });
    await harness.emit("session_start", { reason: "startup" });
    await harness.emit("input", { text: "classify this", source: "interactive" });

    const routing = harness.emit("before_agent_start", { prompt: "classify this" });
    await targetApplicationStarted.promise;
    await harness.selectModel();
    releaseTargetApplication.resolve(undefined);
    await compensationStarted.promise;
    await harness.selectModel({ provider: "newer-provider", id: "newer-model" }, "high");
    releaseCompensation.resolve(undefined);
    await retryStarted.promise;
    await harness.selectModel({ provider: "latest-provider", id: "latest-model" }, "xhigh");
    releaseRetry.resolve(undefined);
    await routing;

    expect(harness.currentModel).toMatchObject({ provider: "latest-provider", id: "latest-model" });
    expect(harness.thinkingLevel).toBe("xhigh");
    expect(harness.modelChanges).toEqual([
      "anthropic/coding/model",
      "user-provider/user-model",
      "newer-provider/newer-model",
      "latest-provider/latest-model",
    ]);
  });

  it("recognizes a nested external selection from an earlier model_select handler", async () => {
    await writeConfig({ automaticRouting: false });
    let reacted = false;
    const harness = createHarness("tui", {
      beforeModelSelectDispatch: async (model, selectModel) => {
        if (!reacted && modelKey(model) === "anthropic/coding/model") {
          reacted = true;
          await selectModel();
        }
      },
    });
    await harness.emit("session_start", { reason: "startup" });
    await harness.command("route coding");

    await harness.emit("before_agent_start", { prompt: "implement this" });
    await harness.emit("agent_settled");

    expect(harness.currentModel).toMatchObject({ provider: "user-provider", id: "user-model" });
    expect(harness.thinkingLevel).toBe("low");
  });

  it("recognizes a nested external selection triggered by Helm's model_select event", async () => {
    await writeConfig({ automaticRouting: false });
    const harness = createHarness();
    const handlers = harness.events.get("model_select");
    handlers?.push(async (event) => {
      const selectedModel = (event as unknown as { model: FakeModel }).model;
      if (modelKey(selectedModel) === "anthropic/coding/model") await harness.selectModel();
    });
    await harness.emit("session_start", { reason: "startup" });
    await harness.command("route coding");

    await harness.emit("before_agent_start", { prompt: "implement this" });
    await harness.emit("agent_settled");

    expect(harness.currentModel).toMatchObject({ provider: "user-provider", id: "user-model" });
    expect(harness.thinkingLevel).toBe("low");
  });

  it("restores an Explicit Thinking Override that arrives while Route Target application is pending", async () => {
    await writeConfig({ automaticRouting: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        createDecisionsResponse({ codeWork: 0.9, deepReasoning: 0.1, externalResearch: 0.1 }),
      ),
    );
    const modelApplicationStarted = deferred<void>();
    const releaseModelApplication = deferred<void>();
    const harness = createHarness("tui", {
      beforeModelApplication: {
        "anthropic/coding/model": async () => {
          modelApplicationStarted.resolve(undefined);
          await releaseModelApplication.promise;
        },
      },
    });
    await harness.emit("session_start", { reason: "startup" });
    await harness.emit("input", { text: "classify this", source: "interactive" });

    const routing = harness.emit("before_agent_start", { prompt: "classify this" });
    await modelApplicationStarted.promise;
    await harness.selectThinkingLevel("high");
    releaseModelApplication.resolve(undefined);
    await routing;

    expect(harness.currentModel).toMatchObject({ provider: "baseline-provider", id: "baseline-model" });
    expect(harness.thinkingLevel).toBe("high");
    expect(harness.modelChanges).toEqual([
      "anthropic/coding/model",
      "baseline-provider/baseline-model",
    ]);
  });

  it("restores an Explicit Thinking Override with Baseline capability clamping", async () => {
    await writeConfig({ automaticRouting: false });
    const harness = createHarness("tui", {
      thinkingLevelByModel: { "baseline-provider/baseline-model": "low" },
    });
    await harness.emit("session_start", { reason: "startup" });
    await harness.command("route coding");
    await harness.emit("before_agent_start", { prompt: "implement this" });

    await harness.selectThinkingLevel("xhigh");
    expect(harness.currentModel).toMatchObject({ provider: "anthropic", id: "coding/model" });

    await harness.emit("agent_settled");
    await harness.emit("before_agent_start", { prompt: "next independent request" });

    expect(harness.currentModel).toMatchObject({ provider: "baseline-provider", id: "baseline-model" });
    expect(harness.thinkingLevel).toBe("low");
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
    await harness.emit("agent_settled");
    await harness.emit("input", { text: "next independent request", source: "interactive" });
    await harness.emit("before_agent_start", { prompt: "next independent request" });

    expect(harness.modelChanges).toEqual([
      "anthropic/coding/model",
      "baseline-provider/baseline-model",
    ]);
    expect(harness.currentModel).toMatchObject({ provider: "baseline-provider", id: "baseline-model" });
    expect(harness.notices.at(-1)).toMatchObject({ level: "warning" });
  });

  it("compensates a model mutation reported as failed before the request continues", async () => {
    await writeConfig({ automaticRouting: false });
    const harness = createHarness("tui", {
      modelResults: { "anthropic/coding/model": [false] },
      mutateModelBeforeFailure: ["anthropic/coding/model"],
    });
    await harness.emit("session_start", { reason: "startup" });
    await harness.command("route coding");

    await harness.emit("before_agent_start", { prompt: "first request" });
    await harness.emit("agent_settled");
    await harness.emit("input", { text: "next independent request", source: "interactive" });
    await harness.emit("before_agent_start", { prompt: "next independent request" });

    expect(harness.modelChanges).toEqual([
      "anthropic/coding/model",
      "baseline-provider/baseline-model",
    ]);
    expect(harness.thinkingLevelChanges).toEqual(["medium"]);
    expect(harness.currentModel).toMatchObject({ provider: "baseline-provider", id: "baseline-model" });
    expect(harness.thinkingLevel).toBe("medium");
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

  it("retries restoration when Pi reports success without restoring the exact Baseline Model", async () => {
    await writeConfig({ automaticRouting: false });
    const harness = createHarness("tui", {
      appliedModels: {
        "baseline-provider/baseline-model": [
          { provider: "baseline-provider", id: "baseline-model-latest" },
          { provider: "baseline-provider", id: "baseline-model" },
        ],
      },
    });
    await harness.emit("session_start", { reason: "startup" });
    await harness.command("route coding");
    await harness.emit("before_agent_start", { prompt: "routed run" });

    await harness.emit("agent_settled");
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

  it("attempts to restore the Baseline Model and thinking level before retrying on the next Routed Run", async () => {
    await writeConfig({ automaticRouting: false });
    const harness = createHarness("tui", {
      modelResults: { "baseline-provider/baseline-model": [false, true] },
      thinkingLevelByModel: { "anthropic/coding/model": "off" },
    });
    await harness.emit("session_start", { reason: "startup" });
    await harness.command("route coding");

    await harness.emit("before_agent_start", { prompt: "partial application" });
    expect(harness.thinkingLevelChanges).toEqual(["high", "medium"]);

    await harness.emit("agent_settled");
    await harness.emit("input", { text: "next independent request", source: "interactive" });
    await harness.emit("before_agent_start", { prompt: "next independent request" });

    expect(harness.modelChanges).toEqual([
      "anthropic/coding/model",
      "baseline-provider/baseline-model",
      "baseline-provider/baseline-model",
    ]);
    expect(harness.thinkingLevelChanges).toEqual(["high", "medium", "medium"]);
    expect(harness.currentModel).toMatchObject({ provider: "baseline-provider", id: "baseline-model" });
    expect(harness.thinkingLevel).toBe("medium");
  });

  it("keeps a newer Route Override pending while compensation retries before settlement", async () => {
    await writeConfig({ automaticRouting: false });
    const harness = createHarness("tui", {
      modelResults: { "baseline-provider/baseline-model": [false, true] },
      thinkingLevelByModel: { "anthropic/coding/model": "off" },
    });
    await harness.emit("session_start", { reason: "startup" });
    await harness.command("route coding");
    await harness.emit("before_agent_start", { prompt: "partial application" });
    await harness.command("route research");

    await harness.emit("before_agent_start", { prompt: "queued continuation" });
    await harness.command();

    expect(harness.modelChanges).toEqual([
      "anthropic/coding/model",
      "baseline-provider/baseline-model",
      "baseline-provider/baseline-model",
    ]);
    expect(harness.notices.at(-1)?.message).toContain("Pending Route Override: research");

    await harness.emit("agent_settled");
    await harness.emit("input", { text: "next independent request", source: "interactive" });
    await harness.emit("before_agent_start", { prompt: "next independent request" });

    expect(harness.modelChanges.at(-1)).toBe("google/research/model");
  });

  it("rejects a non-exact model registry result without contaminating the next run", async () => {
    await writeConfig({ automaticRouting: false });
    const harness = createHarness("tui", {
      registryResults: {
        "anthropic/coding/model": { provider: "anthropic", id: "coding/model-latest" },
      },
    });
    await harness.emit("session_start", { reason: "startup" });
    await harness.command("route coding");

    await harness.emit("before_agent_start", { prompt: "first request" });
    await harness.emit("agent_settled");
    await harness.emit("input", { text: "next independent request", source: "interactive" });
    await harness.emit("before_agent_start", { prompt: "next independent request" });

    expect(harness.modelChanges).toEqual([]);
    expect(harness.currentModel).toMatchObject({ provider: "baseline-provider", id: "baseline-model" });
    expect(harness.notices.at(-1)).toMatchObject({ level: "warning" });
  });

  it("fails open when exact Route Target resolution throws", async () => {
    await writeConfig({ automaticRouting: false });
    const harness = createHarness("tui", { registryErrors: ["anthropic/coding/model"] });
    await harness.emit("session_start", { reason: "startup" });
    await harness.command("route coding");

    await expect(harness.emit("before_agent_start", { prompt: "keep working" })).resolves.toBeUndefined();

    expect(harness.modelChanges).toEqual([]);
    expect(harness.currentModel).toMatchObject({ provider: "baseline-provider", id: "baseline-model" });
    expect(harness.notices.at(-1)).toMatchObject({ level: "warning" });
  });

  it("compensates when model application reports success for a different model", async () => {
    await writeConfig({ automaticRouting: false });
    const harness = createHarness("tui", {
      appliedModels: {
        "anthropic/coding/model": [{ provider: "anthropic", id: "coding/model-latest" }],
      },
    });
    await harness.emit("session_start", { reason: "startup" });
    await harness.command("route coding");

    await harness.emit("before_agent_start", { prompt: "keep working" });

    expect(harness.modelChanges).toEqual([
      "anthropic/coding/model",
      "baseline-provider/baseline-model",
    ]);
    expect(harness.thinkingLevelChanges).toEqual(["medium"]);
    expect(harness.currentModel).toMatchObject({ provider: "baseline-provider", id: "baseline-model" });
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
      { value: "why", label: "why" },
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
