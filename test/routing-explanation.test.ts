import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  completeRoutes,
  createDecisionsResponse,
  deferred,
  restoreAgentDirectory,
} from "./fixtures.js";
import { createHarness, writeHelmConfig, type FakeSessionEntry } from "./harness.js";

const ROUTING_EXPLANATION_ENTRY_TYPE = "pi-jev-helm-routing-explanation";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
let agentDir: string;

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), "pi-jev-helm-explanation-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
  restoreAgentDirectory(originalAgentDir);
  vi.unstubAllGlobals();
});

function explanationEntries(entries: FakeSessionEntry[]): unknown[] {
  return entries
    .filter((entry) => entry.customType === ROUTING_EXPLANATION_ENTRY_TYPE)
    .map((entry) => entry.data);
}

function checkpointEntries(entries: FakeSessionEntry[]): unknown[] {
  return entries
    .filter((entry) => entry.customType === "pi-jev-helm-baseline-checkpoint")
    .map((entry) => entry.data);
}

describe("Pi Jev Helm routing explanations", () => {
  it("records an automatic routed attempt with signals, checks, target, and restoration outcome", async () => {
    await writeHelmConfig(agentDir, { automaticRouting: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        createDecisionsResponse({ codeWork: 0.9, deepReasoning: 0.1, externalResearch: 0.1 }),
      ),
    );
    const harness = createHarness();
    await harness.emit("session_start", { reason: "startup" });

    await harness.emit("input", { text: "please refactor the parser module", source: "interactive" });
    await harness.emit("before_agent_start", { prompt: "please refactor the parser module" });

    expect(explanationEntries(harness.sessionEntries)).toEqual([
      {
        schemaVersion: 1,
        kind: "routing-attempt",
        runId: expect.any(String),
        source: "automatic",
        outcome: "routed",
        route: "coding",
        signals: [
          { name: "codeWork", value: true, confidence: 0.9 },
          { name: "deepReasoning", value: false, confidence: 0.9 },
          { name: "externalResearch", value: false, confidence: 0.9 },
        ],
        confidenceCheck: {
          threshold: 0.75,
          relevantSignals: ["externalResearch", "codeWork"],
          failedSignals: [],
        },
        policyBranch: { candidateRoute: "coding" },
        target: { provider: "anthropic", model: "coding/model", thinkingLevel: "high" },
        baseline: {
          provider: "baseline-provider",
          model: "baseline-model",
          thinkingLevel: "medium",
        },
        appliedModel: { provider: "anthropic", model: "coding/model" },
        appliedThinkingLevel: "high",
        restorationRequired: true,
      },
    ]);

    await harness.emit("agent_settled");

    const attemptRunId = (explanationEntries(harness.sessionEntries)[0] as { runId: string }).runId;
    expect(explanationEntries(harness.sessionEntries)).toEqual([
      expect.objectContaining({ kind: "routing-attempt", outcome: "routed", route: "coding" }),
      {
        schemaVersion: 1,
        kind: "restoration",
        runId: attemptRunId,
        outcome: "restored",
        baseline: {
          provider: "baseline-provider",
          model: "baseline-model",
          thinkingLevel: "medium",
        },
      },
    ]);
    expect(checkpointEntries(harness.sessionEntries).at(-1)).toMatchObject({ status: "complete" });
  });

  it("records a low-confidence fail-open attempt without a Route and stays quiet", async () => {
    await writeHelmConfig(agentDir, { automaticRouting: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        createDecisionsResponse({ codeWork: 0.9, deepReasoning: 0.1, externalResearch: 0.51 }),
      ),
    );
    const harness = createHarness();
    await harness.emit("session_start", { reason: "startup" });

    await harness.emit("input", { text: "verify current release notes", source: "interactive" });
    await harness.emit("before_agent_start", { prompt: "verify current release notes" });
    await harness.emit("agent_settled");

    expect(explanationEntries(harness.sessionEntries)).toEqual([
      {
        schemaVersion: 1,
        kind: "routing-attempt",
        runId: expect.any(String),
        source: "automatic",
        outcome: "fail-open",
        signals: [
          { name: "codeWork", value: true, confidence: 0.9 },
          { name: "deepReasoning", value: false, confidence: 0.9 },
          { name: "externalResearch", value: true, confidence: 0.51 },
        ],
        confidenceCheck: {
          threshold: 0.75,
          relevantSignals: ["externalResearch"],
          failedSignals: ["externalResearch"],
        },
        policyBranch: { candidateRoute: "research" },
        baseline: {
          provider: "baseline-provider",
          model: "baseline-model",
          thinkingLevel: "medium",
        },
        appliedModel: { provider: "baseline-provider", model: "baseline-model" },
        appliedThinkingLevel: "medium",
        failOpen: { reason: "low-confidence", baselineRetained: true },
        restorationRequired: false,
      },
    ]);
    expect(harness.notices).toEqual([]);
    expect(harness.currentModel).toMatchObject({ provider: "baseline-provider", id: "baseline-model" });
  });

  it("records a classification failure with safe failure metadata only", async () => {
    await writeHelmConfig(agentDir, { automaticRouting: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ error: { message: "SECRET-UPSTREAM-PAYLOAD exploded" } }),
          { status: 500, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const harness = createHarness();
    await harness.emit("session_start", { reason: "startup" });

    await harness.emit("input", { text: "a completely private user request", source: "interactive" });
    await harness.emit("before_agent_start", { prompt: "a completely private user request" });
    await harness.emit("agent_settled");

    expect(explanationEntries(harness.sessionEntries)).toEqual([
      {
        schemaVersion: 1,
        kind: "routing-attempt",
        runId: expect.any(String),
        source: "automatic",
        outcome: "fail-open",
        baseline: {
          provider: "baseline-provider",
          model: "baseline-model",
          thinkingLevel: "medium",
        },
        appliedModel: { provider: "baseline-provider", model: "baseline-model" },
        appliedThinkingLevel: "medium",
        failOpen: {
          reason: "classification-failed",
          classification: { kind: "upstream", status: 500 },
          baselineRetained: true,
        },
        restorationRequired: false,
      },
    ]);
    expect(harness.notices.at(-1)).toMatchObject({ level: "warning" });

    const serialized = JSON.stringify(harness.sessionEntries.map((entry) => entry.data));
    expect(serialized).not.toContain("a completely private user request");
    expect(serialized).not.toContain("SECRET-UPSTREAM-PAYLOAD");
    expect(serialized).not.toContain("test-openrouter-key");
    expect(
      harness.sessionEntries
        .filter((entry) => entry.customType === ROUTING_EXPLANATION_ENTRY_TYPE)
        .every((entry) => entry.type === "custom"),
    ).toBe(true);
  });

  it("records a Route Override success and its restoration", async () => {
    await writeHelmConfig(agentDir, { automaticRouting: false });
    const harness = createHarness();
    await harness.emit("session_start", { reason: "startup" });
    await harness.command("route research");

    await harness.emit("before_agent_start", { prompt: "research request" });
    await harness.emit("agent_settled");

    expect(explanationEntries(harness.sessionEntries)).toEqual([
      {
        schemaVersion: 1,
        kind: "routing-attempt",
        runId: expect.any(String),
        source: "route-override",
        outcome: "routed",
        route: "research",
        target: { provider: "google", model: "research/model", thinkingLevel: "medium" },
        baseline: {
          provider: "baseline-provider",
          model: "baseline-model",
          thinkingLevel: "medium",
        },
        appliedModel: { provider: "google", model: "research/model" },
        appliedThinkingLevel: "medium",
        restorationRequired: true,
      },
      expect.objectContaining({ kind: "restoration", outcome: "restored" }),
    ]);
  });

  it("records a Route Override fail-open when its target is unavailable", async () => {
    await writeHelmConfig(agentDir, { automaticRouting: false });
    const harness = createHarness("tui", { unavailableModels: ["anthropic/coding/model"] });
    await harness.emit("session_start", { reason: "startup" });
    await harness.command("route coding");

    await harness.emit("before_agent_start", { prompt: "coding request" });
    await harness.emit("agent_settled");

    expect(explanationEntries(harness.sessionEntries)).toEqual([
      {
        schemaVersion: 1,
        kind: "routing-attempt",
        runId: expect.any(String),
        source: "route-override",
        outcome: "fail-open",
        route: "coding",
        baseline: {
          provider: "baseline-provider",
          model: "baseline-model",
          thinkingLevel: "medium",
        },
        appliedModel: { provider: "baseline-provider", model: "baseline-model" },
        appliedThinkingLevel: "medium",
        failOpen: { reason: "target-unavailable", baselineRetained: true },
        restorationRequired: true,
      },
      expect.objectContaining({ kind: "restoration", outcome: "restored" }),
    ]);
    expect(harness.notices.at(-1)).toMatchObject({ level: "warning" });

    await harness.command("why");
    expect(harness.notices.at(-1)?.message).toContain("Restoration: restored to");
  });

  it("records explicit overrides while Route Target application is pending", async () => {
    await writeHelmConfig(agentDir, { automaticRouting: false });
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

    const routing = harness.emit("before_agent_start", { prompt: "implement this" });
    await targetApplicationStarted.promise;
    await harness.selectThinkingLevel("xhigh");
    await harness.selectModel(undefined, "xhigh");
    releaseTargetApplication.resolve(undefined);
    await routing;

    const entries = explanationEntries(harness.sessionEntries) as Array<{
      kind?: string;
      [key: string]: unknown;
    }>;
    const attempt = entries.find((entry) => entry.kind === "routing-attempt");
    expect(attempt).toMatchObject({
      kind: "routing-attempt",
      outcome: "fail-open",
      failOpen: { reason: "superseded-by-explicit-choice", baselineRetained: true },
    });
    expect(entries.filter((entry) => entry.kind === "explicit-override")).toEqual([
      expect.objectContaining({
        override: { kind: "thinking", thinkingLevel: "xhigh" },
      }),
      expect.objectContaining({
        override: {
          kind: "model",
          model: { provider: "user-provider", model: "user-model" },
          thinkingLevel: "xhigh",
        },
      }),
    ]);
    expect(entries.at(-1)).toMatchObject({ kind: "restoration", outcome: "restored" });

    await harness.command("why");
    expect(harness.notices.at(-1)?.message).toContain("thinking → xhigh");
    expect(harness.notices.at(-1)?.message).toContain("model → user-provider/user-model");
    expect(harness.notices.at(-1)?.message).toContain("Restoration: restored to");
  });

  it("records an Explicit Thinking Override while restoration is pending", async () => {
    await writeHelmConfig(agentDir, { automaticRouting: false });
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
    await harness.selectThinkingLevel("xhigh");
    releaseRestoration.resolve(undefined);
    await settlement;

    expect(explanationEntries(harness.sessionEntries)).toEqual([
      expect.objectContaining({ kind: "routing-attempt", outcome: "routed" }),
      expect.objectContaining({
        kind: "explicit-override",
        override: { kind: "thinking", thinkingLevel: "xhigh" },
      }),
      expect.objectContaining({
        kind: "restoration",
        outcome: "restored",
        baseline: expect.objectContaining({ thinkingLevel: "xhigh" }),
      }),
    ]);
  });

  it("records an Explicit Model Override with a superseded restoration during a Routed Run", async () => {
    await writeHelmConfig(agentDir, { automaticRouting: false });
    const harness = createHarness();
    await harness.emit("session_start", { reason: "startup" });
    await harness.command("route coding");
    await harness.emit("before_agent_start", { prompt: "implement this" });

    await harness.selectModel();
    await harness.emit("agent_settled");

    const entries = explanationEntries(harness.sessionEntries);
    const attemptRunId = (entries[0] as { runId: string }).runId;
    expect(entries).toEqual([
      expect.objectContaining({ kind: "routing-attempt", outcome: "routed", route: "coding" }),
      {
        schemaVersion: 1,
        kind: "explicit-override",
        runId: attemptRunId,
        override: { kind: "thinking", thinkingLevel: "low" },
        baseline: {
          provider: "user-provider",
          model: "user-model",
          thinkingLevel: "low",
        },
      },
      {
        schemaVersion: 1,
        kind: "explicit-override",
        runId: attemptRunId,
        override: {
          kind: "model",
          model: { provider: "user-provider", model: "user-model" },
          thinkingLevel: "low",
        },
        baseline: {
          provider: "user-provider",
          model: "user-model",
          thinkingLevel: "low",
        },
      },
      {
        schemaVersion: 1,
        kind: "restoration",
        runId: attemptRunId,
        outcome: "superseded",
        baseline: {
          provider: "user-provider",
          model: "user-model",
          thinkingLevel: "low",
        },
      },
    ]);
    expect(harness.currentModel).toMatchObject({ provider: "user-provider", id: "user-model" });
  });

  it("records an Explicit Thinking Override during a Routed Run", async () => {
    await writeHelmConfig(agentDir, { automaticRouting: false });
    const harness = createHarness();
    await harness.emit("session_start", { reason: "startup" });
    await harness.command("route coding");
    await harness.emit("before_agent_start", { prompt: "implement this" });

    await harness.selectThinkingLevel("xhigh");
    await harness.emit("agent_settled");

    const entries = explanationEntries(harness.sessionEntries);
    const attemptRunId = (entries[0] as { runId: string }).runId;
    expect(entries).toEqual([
      expect.objectContaining({ kind: "routing-attempt", outcome: "routed", route: "coding" }),
      {
        schemaVersion: 1,
        kind: "explicit-override",
        runId: attemptRunId,
        override: { kind: "thinking", thinkingLevel: "xhigh" },
        baseline: {
          provider: "baseline-provider",
          model: "baseline-model",
          thinkingLevel: "xhigh",
        },
      },
      {
        schemaVersion: 1,
        kind: "restoration",
        runId: attemptRunId,
        outcome: "restored",
        baseline: {
          provider: "baseline-provider",
          model: "baseline-model",
          thinkingLevel: "xhigh",
        },
      },
    ]);
  });

  it("serves /helm why read-only from the current run while it is active", async () => {
    await writeHelmConfig(agentDir, { automaticRouting: false });
    const harness = createHarness();
    await harness.emit("session_start", { reason: "startup" });
    await harness.command("route coding");
    await harness.emit("before_agent_start", { prompt: "implement this" });
    const entryCountBefore = harness.sessionEntries.length;

    await harness.command("why");

    const notice = harness.notices.at(-1);
    expect(notice).toMatchObject({ level: "info" });
    expect(notice?.message).toContain("Routing Explanation");
    expect(notice?.message).toContain("coding");
    expect(notice?.message).toContain("anthropic/coding/model");
    expect(notice?.message).toContain("baseline-provider/baseline-model");
    expect(harness.sessionEntries.length).toBe(entryCountBefore);
  });

  it("shows the most recent applicable explanation after settlement with its restoration outcome", async () => {
    await writeHelmConfig(agentDir, { automaticRouting: false });
    const harness = createHarness();
    await harness.emit("session_start", { reason: "startup" });
    await harness.command("route coding");
    await harness.emit("before_agent_start", { prompt: "implement this" });
    await harness.emit("agent_settled");
    const entryCountBefore = harness.sessionEntries.length;

    await harness.command("why");

    const notice = harness.notices.at(-1);
    expect(notice).toMatchObject({ level: "info" });
    expect(notice?.message).toContain("Route Override");
    expect(notice?.message).toContain("restored");
    expect(harness.sessionEntries.length).toBe(entryCountBefore);
  });

  it("gives a normal informational result when no explanation exists", async () => {
    await writeHelmConfig(agentDir, { automaticRouting: false });
    const harness = createHarness();
    await harness.emit("session_start", { reason: "startup" });

    await harness.command("why");

    expect(harness.notices.at(-1)).toMatchObject({ level: "info" });
    expect(harness.notices.at(-1)?.message).toContain("no Routing Explanation");
    expect(harness.sessionEntries).toEqual([]);
  });

  it("selects only the explanations applicable to the active branch after navigation", async () => {
    await writeHelmConfig(agentDir, { automaticRouting: false });
    const harness = createHarness();
    await harness.emit("session_start", { reason: "startup" });
    await harness.command("route coding");
    await harness.emit("before_agent_start", { prompt: "coding work" });
    await harness.emit("agent_settled");
    const branchAtFork = harness.sessionEntries.map((entry) => ({ ...entry }));

    await harness.command("route research");
    await harness.emit("before_agent_start", { prompt: "research work" });
    await harness.emit("agent_settled");
    const branchWithResearch = harness.sessionEntries.map((entry) => ({ ...entry }));

    // Simulate tree navigation back to the fork point: the branch now contains
    // only the entries that precede the second run.
    harness.sessionEntries.splice(0, harness.sessionEntries.length, ...branchAtFork);
    await harness.command("why");
    expect(harness.notices.at(-1)?.message).toContain("coding");
    expect(harness.notices.at(-1)?.message).not.toContain("research/model");

    // Navigating forward again restores the newer explanation.
    harness.sessionEntries.splice(0, harness.sessionEntries.length, ...branchWithResearch);
    await harness.command("why");
    expect(harness.notices.at(-1)?.message).toContain("google/research/model");
  });

  it("records a quiet fail-open entry when classification is aborted", async () => {
    await writeHelmConfig(agentDir, { automaticRouting: true });
    const controller = new AbortController();
    controller.abort();
    const transport = vi.fn(async () => createDecisionsResponse({ codeWork: 0.9, deepReasoning: 0.1, externalResearch: 0.1 }));
    vi.stubGlobal("fetch", transport);
    const harness = createHarness("tui", { signal: controller.signal });
    await harness.emit("session_start", { reason: "startup" });

    await harness.emit("input", { text: "cancelled request", source: "interactive" });
    await harness.emit("before_agent_start", { prompt: "cancelled request" });
    await harness.emit("agent_settled");

    expect(transport).not.toHaveBeenCalled();
    expect(harness.notices).toEqual([]);
    expect(explanationEntries(harness.sessionEntries)).toEqual([
      {
        schemaVersion: 1,
        kind: "routing-attempt",
        runId: expect.any(String),
        source: "automatic",
        outcome: "fail-open",
        baseline: {
          provider: "baseline-provider",
          model: "baseline-model",
          thinkingLevel: "medium",
        },
        appliedModel: { provider: "baseline-provider", model: "baseline-model" },
        appliedThinkingLevel: "medium",
        failOpen: { reason: "classification-aborted", baselineRetained: true },
        restorationRequired: false,
      },
    ]);
  });

  it("shows a failed restoration outcome through /helm why", async () => {
    await writeHelmConfig(agentDir, { automaticRouting: false });
    const harness = createHarness("tui", {
      modelResults: { "baseline-provider/baseline-model": [false] },
    });
    await harness.emit("session_start", { reason: "startup" });
    await harness.command("route coding");
    await harness.emit("before_agent_start", { prompt: "routed run" });
    await harness.emit("agent_settled");

    await harness.command("why");

    const notice = harness.notices.at(-1);
    expect(notice).toMatchObject({ level: "info" });
    expect(notice?.message).toContain("Restoration: failed");
  });

  it("rejects invalid /helm why arguments", async () => {
    await writeHelmConfig(agentDir, { automaticRouting: false });
    const harness = createHarness();
    await harness.emit("session_start", { reason: "startup" });

    await harness.command("why now");

    expect(harness.notices.at(-1)).toMatchObject({ level: "warning" });
    expect(harness.notices.at(-1)?.message).toContain("/helm why");
  });

  it("shows the fail-open reason and confidence failure through /helm why", async () => {
    await writeHelmConfig(agentDir, { automaticRouting: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        createDecisionsResponse({ codeWork: 0.9, deepReasoning: 0.1, externalResearch: 0.51 }),
      ),
    );
    const harness = createHarness();
    await harness.emit("session_start", { reason: "startup" });
    await harness.emit("input", { text: "verify current release notes", source: "interactive" });
    await harness.emit("before_agent_start", { prompt: "verify current release notes" });

    await harness.command("why");

    const notice = harness.notices.at(-1);
    expect(notice).toMatchObject({ level: "info" });
    expect(notice?.message).toContain("fail-open");
    expect(notice?.message).toContain("low-confidence");
    expect(notice?.message).toContain("externalResearch");
  });
});
