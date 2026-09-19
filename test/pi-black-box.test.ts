/**
 * Pi public-API black-box compatibility suite for Pi Jev Helm.
 *
 * Every test drives the real in-process Pi SDK (session lifecycle, extension
 * runner, model registry, session tree) with scripted in-process fake
 * providers. The suite certifies one Routed Run lifecycle end to end: all four
 * Routes, bypass, one-shot Route Overrides, fail-open paths, Explicit
 * Overrides, the pre-application race, queued continuations, restoration,
 * next-run isolation, branch-aware entries, lifecycle recovery, footer smoke
 * behavior, and silence in machine-readable modes — without asserting brittle
 * full-text snapshots.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  assistantMessages,
  BASELINE_MODEL_ID,
  BASELINE_PROVIDER,
  HELM_ROUTES,
  startHelmHarness,
  USER_PROVIDER,
  type HelmHarness,
} from "./pi-harness.js";

const EXPLANATION_ENTRY_TYPE = "pi-jev-helm-routing-explanation";
const CHECKPOINT_ENTRY_TYPE = "pi-jev-helm-baseline-checkpoint";

interface CustomEntryView {
  customType: string;
  data: Record<string, unknown>;
}

interface RoutingAttemptView extends Record<string, unknown> {
  kind: "routing-attempt";
  source?: string;
  outcome?: string;
  route?: string;
  failOpen?: { reason: string; baselineRetained?: boolean; classification?: { kind: string } };
  confidenceCheck?: { threshold?: number; failedSignals?: string[] };
  target?: { provider?: string; model?: string };
}

function customEntries(harness: HelmHarness): CustomEntryView[] {
  return harness.sessionManager
    .getBranch()
    .filter((entry) => entry.type === "custom")
    .map((entry) => entry as unknown as CustomEntryView);
}

function explanations(harness: HelmHarness): Array<Record<string, unknown>> {
  return customEntries(harness)
    .filter((entry) => entry.customType === EXPLANATION_ENTRY_TYPE)
    .map((entry) => entry.data);
}

function routingAttempts(harness: HelmHarness): RoutingAttemptView[] {
  return explanations(harness).filter(
    (entry): entry is RoutingAttemptView => entry.kind === "routing-attempt",
  );
}

function checkpoints(harness: HelmHarness): Array<Record<string, unknown>> {
  return customEntries(harness)
    .filter((entry) => entry.customType === CHECKPOINT_ENTRY_TYPE)
    .map((entry) => entry.data);
}

async function pollUntil(check: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

let activeHarness: HelmHarness | undefined;

async function start(options?: Parameters<typeof startHelmHarness>[0]): Promise<HelmHarness> {
  activeHarness = await startHelmHarness(options);
  return activeHarness;
}

afterEach(async () => {
  const harness = activeHarness;
  activeHarness = undefined;
  await harness?.dispose();
});

describe("Pi public-API compatibility (black-box, in-process fake models)", () => {
  for (const [route, decision] of [
    ["fast", { codeWork: 0.1, deepReasoning: 0.15, externalResearch: 0.1 }],
    ["coding", { codeWork: 0.95, deepReasoning: 0.1, externalResearch: 0.1 }],
    ["reasoning", { codeWork: 0.1, deepReasoning: 0.9, externalResearch: 0.1 }],
    ["research", { codeWork: 0.1, deepReasoning: 0.1, externalResearch: 0.92 }],
  ] as const) {
    it(`routes an idle request through the ${route} Route for the whole run and restores the Baseline`, async () => {
      const harness = await start();
      harness.classification.decide(decision);
      harness.baseline.respond("baseline reply");
      harness.routes[route].respond("routed reply");

      await harness.session.prompt("a request to classify");

      // The Route Target answered the run.
      const messages = assistantMessages(harness.sessionManager);
      expect(messages).toHaveLength(1);
      expect(messages[0]?.provider).toBe(HELM_ROUTES[route].provider);
      expect(messages[0]?.model).toBe(HELM_ROUTES[route].model);

      // Exactly one classification request was made for the idle message.
      expect(harness.classification.callCount()).toBe(1);

      // Baseline Model and thinking level were restored after settlement.
      expect(harness.session.model?.provider).toBe(BASELINE_PROVIDER);
      expect(harness.session.model?.id).toBe(BASELINE_MODEL_ID);
      expect(harness.session.thinkingLevel).toBe("medium");

      // Checkpoint pair: pending before application, complete after restoration.
      const statuses = checkpoints(harness).map((entry) => entry.status);
      expect(statuses).toContain("pending");
      expect(statuses).toContain("complete");

      // Routing attempt explanation with the selected route and restoration entry.
      const attempts = routingAttempts(harness);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.outcome).toBe("routed");
      expect(attempts[0]?.route).toBe(route);
      const target = attempts[0]?.target as Record<string, unknown> | undefined;
      expect(target?.provider).toBe(HELM_ROUTES[route].provider);
      expect(target?.model).toBe(HELM_ROUTES[route].model);
      const restorations = explanations(harness).filter((entry) => entry.kind === "restoration");
      expect(restorations).toHaveLength(1);
      expect(restorations[0]?.outcome).toBe("restored");

      // Footer settled back to the idle automatic state.
      expect(harness.recorder.lastStatus()).toContain("auto");
    });
  }

  it("bypasses the request entirely when Automatic Routing is off", async () => {
    const harness = await start({ automaticRouting: false });
    harness.baseline.respond("plain reply");

    await harness.session.prompt("no routing please");
    // Full bypass: no classification, no records, no model intervention.
    expect(harness.classification.callCount()).toBe(0);
    expect(explanations(harness)).toHaveLength(0);
    expect(checkpoints(harness)).toHaveLength(0);
    expect(assistantMessages(harness.sessionManager).at(-1)?.provider).toBe(BASELINE_PROVIDER);
    expect(harness.recorder.notices().some((n) => n.level === "warning" || n.level === "error")).toBe(
      false,
    );

    // The runtime override re-enables Automatic Routing for this instance only.
    await harness.session.prompt("/helm auto on");
    expect(
      harness.recorder.notices().some((n) => n.message.includes("Automatic Routing is on")),
    ).toBe(true);
    harness.classification.decide({ codeWork: 0.1, deepReasoning: 0.1, externalResearch: 0.1 });
    harness.routes.fast.respond("fast reply");
    await harness.session.prompt("automatic routing again");
    expect(harness.classification.callCount()).toBe(1);
    expect(assistantMessages(harness.sessionManager).at(-1)?.provider).toBe(
      HELM_ROUTES.fast.provider,
    );
  });

  it("skips classification and consumes a one-shot Route Override", async () => {
    const harness = await start();
    await harness.session.prompt("/helm route coding");
    expect(harness.recorder.notices().some((n) => n.message.includes("Route Override"))).toBe(true);

    harness.baseline.respond("baseline reply");
    harness.routes.coding.respond("coding reply");
    await harness.session.prompt("override this run");

    expect(harness.classification.callCount()).toBe(0);
    const attempts = routingAttempts(harness);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.source).toBe("route-override");
    expect(attempts[0]?.outcome).toBe("routed");
    expect(assistantMessages(harness.sessionManager)[0]?.provider).toBe(HELM_ROUTES.coding.provider);

    // The override was consumed: the next independent run classifies again and
    // the fresh classification (all signals false) routes through `fast`.
    harness.classification.decide({ codeWork: 0.1, deepReasoning: 0.1, externalResearch: 0.1 });
    harness.routes.fast.respond("fast reply");
    await harness.session.prompt("next independent run");
    expect(harness.classification.callCount()).toBe(1);
    expect(assistantMessages(harness.sessionManager).at(-1)?.provider).toBe(
      HELM_ROUTES.fast.provider,
    );
    expect(harness.session.model?.provider).toBe(BASELINE_PROVIDER);
  });

  it("replaces and clears a pending Route Override", async () => {
    const harness = await start();
    await harness.session.prompt("/helm route research");
    await harness.session.prompt("/helm route coding");

    harness.baseline.respond("baseline reply");
    harness.routes.coding.respond("coding reply");
    await harness.session.prompt("consume the replacement");
    const attempts = routingAttempts(harness);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.route).toBe("coding");

    // A cleared override leaves the next run to ordinary Automatic Routing.
    await harness.session.prompt("/helm route fast");
    await harness.session.prompt("/helm route clear");
    harness.classification.decide({ codeWork: 0.1, deepReasoning: 0.1, externalResearch: 0.1 });
    harness.routes.fast.respond("fast reply");
    await harness.session.prompt("after clearing");
    expect(harness.classification.callCount()).toBe(1);
    const attemptsAfterClear = routingAttempts(harness);
    expect(attemptsAfterClear).toHaveLength(2);
    expect(attemptsAfterClear[1]?.source).toBe("automatic");
    expect(assistantMessages(harness.sessionManager).at(-1)?.provider).toBe(
      HELM_ROUTES.fast.provider,
    );
  });

  it("consumes a Route Override even when its Route Target is unavailable", async () => {
    // Only the baseline and user models are in scope: every Route Target is out of scope.
    const harness = await start({
      scopedModels: [`${BASELINE_PROVIDER}/${BASELINE_MODEL_ID}`, "helm-user/user-model"],
    });
    await harness.session.prompt("/helm route coding");

    harness.baseline.respond("baseline reply");
    await harness.session.prompt("override with broken target");

    expect(harness.classification.callCount()).toBe(0);
    const attempts = routingAttempts(harness);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.outcome).toBe("fail-open");
    expect(attempts[0]?.failOpen?.reason).toBe("target-unavailable");
    // The run proceeded on the Baseline Model.
    expect(assistantMessages(harness.sessionManager).at(-1)?.provider).toBe(BASELINE_PROVIDER);
    expect(harness.session.model?.id).toBe(BASELINE_MODEL_ID);

    // Consumed despite the failure: the next run attempts classification.
    harness.classification.decide({ codeWork: 0.1, deepReasoning: 0.1, externalResearch: 0.1 });
    harness.baseline.respond("baseline reply");
    await harness.session.prompt("next run");
    expect(harness.classification.callCount()).toBe(1);
  });

  it("fails open when the Classification Provider is unavailable and keeps the request running", async () => {
    const harness = await start();
    harness.setOpenRouterConfigured(false);
    harness.baseline.respond("baseline reply");

    await harness.session.prompt("classify me anyway");

    expect(harness.classification.callCount()).toBe(0);
    const attempts = routingAttempts(harness);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.outcome).toBe("fail-open");
    expect(attempts[0]?.failOpen?.reason).toBe("provider-unavailable");
    expect(attempts[0]?.failOpen?.baselineRetained).toBe(true);
    expect(assistantMessages(harness.sessionManager).at(-1)?.provider).toBe(BASELINE_PROVIDER);
    expect(
      harness.recorder.notices().some((n) => n.level === "warning" && n.message.length > 0),
    ).toBe(true);
    // The fail-open state is visible in the footer during the run, then the
    // footer settles back to idle after restoration.
    expect(harness.recorder.statuses().some((status) => status.includes("fail-open"))).toBe(true);
    expect(harness.recorder.lastStatus()).toContain("auto");
  });

  it("fails open on low confidence without a popup", async () => {
    const harness = await start({ confidenceThreshold: 0.75 });
    harness.classification.decide({ codeWork: 0.6, deepReasoning: 0.2, externalResearch: 0.1 });
    harness.baseline.respond("baseline reply");

    await harness.session.prompt("an ambiguous coding request");

    expect(harness.classification.callCount()).toBe(1);
    const attempts = routingAttempts(harness);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.outcome).toBe("fail-open");
    expect(attempts[0]?.failOpen?.reason).toBe("low-confidence");
    expect(attempts[0]?.confidenceCheck?.threshold).toBe(0.75);
    expect(attempts[0]?.confidenceCheck?.failedSignals).toContain("codeWork");
    // Low-confidence fail-open appears in the footer without a popup, and the
    // footer settles back to idle after restoration.
    expect(harness.recorder.statuses().some((status) => status.includes("fail-open"))).toBe(true);
    expect(harness.recorder.notices().some((n) => n.level === "warning")).toBe(false);
    expect(assistantMessages(harness.sessionManager).at(-1)?.provider).toBe(BASELINE_PROVIDER);
  });

  it("fails open with a warning when classification fails at the transport level", async () => {
    const harness = await start();
    harness.classification.respondWith(
      new Response("upstream exploded", { status: 500 }),
    );
    harness.baseline.respond("baseline reply");

    await harness.session.prompt("classify against a failing endpoint");

    expect(harness.classification.callCount()).toBe(1);
    const attempts = routingAttempts(harness);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.failOpen?.reason).toBe("classification-failed");
    expect(attempts[0]?.failOpen?.classification?.kind).toBe("upstream");
    // Safe failure metadata: the raw upstream body must not reach any entry or notice.
    const serializedEntries = JSON.stringify(explanations(harness));
    expect(serializedEntries).not.toContain("upstream exploded");
    expect(
      harness.recorder.notices().every((n) => !n.message.includes("upstream exploded")),
    ).toBe(true);
    expect(harness.recorder.notices().some((n) => n.level === "warning")).toBe(true);
    expect(assistantMessages(harness.sessionManager).at(-1)?.provider).toBe(BASELINE_PROVIDER);
  });

  it("does not classify the current user message when configuration is unhealthy", async () => {
    const harness = await start({ routes: false });
    harness.baseline.respond("baseline reply");

    await harness.session.prompt("work with broken configuration");

    expect(harness.classification.callCount()).toBe(0);
    expect(explanations(harness)).toHaveLength(0);
    expect(checkpoints(harness)).toHaveLength(0);
    expect(assistantMessages(harness.sessionManager).at(-1)?.provider).toBe(BASELINE_PROVIDER);
    // Invalid configuration disables Automatic Routing and rejects enabling it.
    await harness.session.prompt("/helm auto on");
    expect(
      harness.recorder.notices().some((n) => n.level === "error" && n.message.includes("configuration")),
    ).toBe(true);
    await harness.session.prompt("/helm route fast");
    expect(
      harness.recorder.notices().some((n) => n.level === "error" && n.message.includes("configuration")),
    ).toBe(true);
    expect(harness.classification.callCount()).toBe(0);
  });

  it("lets an explicit model choice win the race against in-flight classification", async () => {
    const harness = await start();
    const gate = harness.classification.gate();
    harness.user.respond("user reply");

    const promptPromise = harness.session.prompt("race the classifier");
    await waitForClassificationInFlight(harness);
    // The user picks a model directly while the classification request is open.
    await harness.session.setModel(harness.user.model("user-model"));
    gate.release();
    await promptPromise;

    expect(harness.classification.callCount()).toBe(1);
    const attempts = routingAttempts(harness);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.outcome).toBe("fail-open");
    expect(attempts[0]?.failOpen?.reason).toBe("superseded-by-explicit-choice");
    // The user's model answered the run and became the new Baseline.
    expect(assistantMessages(harness.sessionManager).at(-1)?.provider).toBe(USER_PROVIDER);
    expect(harness.session.model?.provider).toBe(USER_PROVIDER);
    expect(harness.recorder.statuses().some((status) => status.includes("explicit"))).toBe(true);
  });

  it("applies the Route Target only after an in-flight classification completes", async () => {
    const harness = await start();
    const gate = harness.classification.gate();
    harness.routes.coding.respond("coding reply");

    const promptPromise = harness.session.prompt("steady classification");
    gate.release();
    await promptPromise;

    expect(assistantMessages(harness.sessionManager).at(-1)?.provider).toBe(
      HELM_ROUTES.coding.provider,
    );
    expect(harness.session.model?.provider).toBe(BASELINE_PROVIDER);
  });

  it("gives an Explicit Model Override during a run immediate control and a new Baseline", async () => {
    // Paced streaming keeps the Routed Run active while the override lands.
    const harness = await start({ tokensPerSecond: 400 });
    const gate = harness.classification.gate();
    harness.routes.coding.respond("coding reply ".repeat(40));

    const promptPromise = harness.session.prompt("long routed run");
    gate.release();
    // Wait until the Route Target is streaming: the override happens post-selection.
    await waitForStreamingText(harness);
    await harness.session.setModel(harness.user.model("user-model"));
    await promptPromise;

    const messages = assistantMessages(harness.sessionManager);
    expect(messages.some((m) => m.provider === HELM_ROUTES.coding.provider)).toBe(true);
    // Settlement must not undo the deliberate choice.
    expect(harness.session.model?.provider).toBe(USER_PROVIDER);
    const explicitOverrides = explanations(harness).filter(
      (entry) => entry.kind === "explicit-override",
    );
    expect(
      explicitOverrides.some(
        (entry) =>
          (entry.override as { kind?: string }).kind === "model" &&
          (entry.override as { model?: { provider?: string } }).model?.provider === USER_PROVIDER,
      ),
    ).toBe(true);
    expect(harness.recorder.statuses().some((status) => status.includes("explicit"))).toBe(true);
  });

  it("updates the restored thinking level on an Explicit Thinking Override without promoting the Route Target", async () => {
    const harness = await start({ tokensPerSecond: 400 });
    const gate = harness.classification.gate();
    harness.routes.coding.respond("coding reply ".repeat(40));

    const promptPromise = harness.session.prompt("think less during this run");
    gate.release();
    // Wait until the Route Target is streaming: the thinking change happens mid-run.
    await waitForStreamingText(harness);
    await harness.session.setThinkingLevel("low");
    await promptPromise;

    // The Route Target stayed in control of the model...
    expect(assistantMessages(harness.sessionManager).at(-1)?.provider).toBe(
      HELM_ROUTES.coding.provider,
    );
    // ...and settlement restored the Baseline Model with the user-selected level.
    expect(harness.session.model?.provider).toBe(BASELINE_PROVIDER);
    expect(harness.session.thinkingLevel).toBe("low");
    const explicitOverrides = explanations(harness).filter(
      (entry) => entry.kind === "explicit-override",
    );
    expect(
      explicitOverrides.some((entry) => (entry.override as { kind?: string }).kind === "thinking"),
    ).toBe(true);
    const completedCheckpoint = checkpoints(harness).at(-1);
    expect(completedCheckpoint?.status).toBe("complete");
    expect((completedCheckpoint?.baseline as { thinkingLevel?: string }).thinkingLevel).toBe("low");
  });

  it("keeps queued steer and followUp continuations on the Routed Run's Route", async () => {
    const harness = await start({ initialThinkingLevel: "medium", tokensPerSecond: 400 });
    harness.classification.decide({ codeWork: 0.95, deepReasoning: 0.1, externalResearch: 0.1 });

    // The routed answer streams slowly so the continuations are queued mid-run.
    harness.routes.coding.respond("first routed reply ".repeat(60));
    harness.routes.coding.respond("steered routed reply");
    harness.routes.coding.respond("follow-up routed reply");

    const promptPromise = harness.session.prompt("start routed work");
    // Wait for streaming to begin, then queue both continuations.
    await waitForStreamingText(harness);
    await harness.session.steer("steer within the run");
    await harness.session.followUp("follow up within the run");
    await promptPromise;

    const messages = assistantMessages(harness.sessionManager);
    expect(messages).toHaveLength(3);
    expect(messages.every((m) => m.provider === HELM_ROUTES.coding.provider)).toBe(true);
    // Exactly one classification happened: continuations are part of the same run.
    expect(harness.classification.callCount()).toBe(1);
    // Baseline restored only after the whole run settled.
    expect(harness.session.model?.provider).toBe(BASELINE_PROVIDER);
    expect(harness.session.thinkingLevel).toBe("medium");
  });

  it("isolates the next independent run from the previous Routed Run", async () => {
    const harness = await start();
    harness.classification.decide({ codeWork: 0.95, deepReasoning: 0.1, externalResearch: 0.1 });
    harness.routes.coding.respond("first run reply");
    await harness.session.prompt("first run");
    expect(harness.session.model?.provider).toBe(BASELINE_PROVIDER);

    harness.classification.decide({ codeWork: 0.1, deepReasoning: 0.1, externalResearch: 0.1 });
    harness.routes.fast.respond("second run reply");
    await harness.session.prompt("second independent run");

    expect(harness.classification.callCount()).toBe(2);
    const messages = assistantMessages(harness.sessionManager);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.provider).toBe(HELM_ROUTES.coding.provider);
    expect(messages[1]?.provider).toBe(HELM_ROUTES.fast.provider);
    expect(harness.session.model?.provider).toBe(BASELINE_PROVIDER);
    expect(harness.session.thinkingLevel).toBe("medium");
    const attempts = routingAttempts(harness);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.route).toBe("coding");
    expect(attempts[1]?.route).toBe("fast");
  });

  it("keeps routing records branch-aware for /helm why", async () => {
    const harness = await start();
    harness.classification.decide({ codeWork: 0.95, deepReasoning: 0.1, externalResearch: 0.1 });
    harness.routes.coding.respond("routed reply");
    await harness.session.prompt("routed run on this branch");
    expect(explanations(harness).length).toBeGreaterThan(0);

    // `/helm why` reports the branch's most recent explanation.
    await harness.session.prompt("/helm why");
    const whyNotices = harness.recorder
      .notices()
      .filter((n) => n.message.includes("Route") || n.message.includes("route"));
    expect(whyNotices.length).toBeGreaterThan(0);

    // Move the leaf back before the routing records: they are no longer on the branch.
    const firstRoutingRecord = harness.sessionManager
      .getBranch()
      .find((entry) => entry.type === "custom" && String(entry.customType).includes("pi-jev-helm"));
    expect(firstRoutingRecord).toBeDefined();
    const parentId = (firstRoutingRecord as unknown as { parentId: string | null }).parentId;
    expect(parentId).not.toBeNull();
    harness.sessionManager.branch(parentId as string);
    expect(explanations(harness)).toHaveLength(0);

    await harness.session.prompt("/helm why");
    expect(
      harness.recorder
        .notices()
        .some((n) => n.message.includes("no Routing Explanation")),
    ).toBe(true);
  });

  it("recovers the Baseline from an incomplete checkpoint at session start", async () => {
    const harness = await start({ persistent: true });
    expect(harness.sessionFile).toBeDefined();
    harness.classification.decide({ codeWork: 0.95, deepReasoning: 0.1, externalResearch: 0.1 });

    // Hold the routed answer open so the run stays active but the route target
    // has already been applied (the pending checkpoint proves application).
    const gate = harness.routes.coding.respondGated("routed reply");
    const promptPromise = harness.session.prompt("run that will be interrupted");
    await waitForPendingCheckpoint(harness);

    // Withdraw the Baseline provider from the availability snapshot so the
    // agent_settled restoration genuinely fails and the checkpoint stays open.
    harness.baseline.setConfigured(false);
    await harness.refreshAvailability();
    gate.release();
    await promptPromise;

    // Restoration failed: the session was left on the Route Target with an
    // incomplete checkpoint.
    expect(harness.session.model?.provider).toBe(HELM_ROUTES.coding.provider);
    expect(checkpoints(harness).at(-1)?.status).toBe("restoration_failed");
    const failedRestoration = explanations(harness)
      .filter((entry) => entry.kind === "restoration")
      .at(-1);
    expect(failedRestoration?.outcome).toBe("failed");

    // Restore availability and reopen the session file like a resumed session:
    // session start must recover the latest Baseline before accepting new work.
    harness.baseline.setConfigured(true);
    await harness.refreshAvailability();
    const reopened = await harness.reopenSession();

    expect(reopened.model?.provider).toBe(BASELINE_PROVIDER);
    expect(reopened.model?.id).toBe(BASELINE_MODEL_ID);
    expect(reopened.thinkingLevel).toBe("medium");
    const recoveredCheckpoint = checkpoints(harness).at(-1);
    expect(recoveredCheckpoint?.status).toBe("complete");
    const recoveryRestoration = explanations(harness)
      .filter((entry) => entry.kind === "restoration")
      .at(-1);
    expect(recoveryRestoration?.outcome).toBe("restored");
  });

  it("keeps one-shot Route Overrides available while Automatic Routing is off", async () => {
    const harness = await start({ automaticRouting: false });
    await harness.session.prompt("/helm route coding");

    harness.routes.coding.respond("coding reply");
    await harness.session.prompt("explicit override with automatic routing disabled");

    // No classification happened, but the override still routed.
    expect(harness.classification.callCount()).toBe(0);
    const attempts = routingAttempts(harness);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.source).toBe("route-override");
    expect(attempts[0]?.outcome).toBe("routed");
    expect(attempts[0]?.route).toBe("coding");
    expect(assistantMessages(harness.sessionManager).at(-1)?.provider).toBe(
      HELM_ROUTES.coding.provider,
    );
    // Settlement restored the Baseline as usual.
    expect(harness.session.model?.provider).toBe(BASELINE_PROVIDER);
  });

  it("fails open and compensates when the Route Target cannot be applied", async () => {
    const harness = await start();
    // The coding Route Target resolves in the registry but its provider has no
    // usable credential, so the model switch itself fails after the checkpoint.
    harness.routes.coding.setConfigured(false);
    await harness.refreshAvailability();
    harness.classification.decide({ codeWork: 0.95, deepReasoning: 0.1, externalResearch: 0.1 });
    harness.baseline.respond("baseline reply");

    await harness.session.prompt("route me to a broken target");

    expect(harness.classification.callCount()).toBe(1);
    const attempts = routingAttempts(harness);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.outcome).toBe("fail-open");
    expect(attempts[0]?.failOpen?.reason).toBe("target-unavailable");
    expect(attempts[0]?.failOpen?.baselineRetained).toBe(true);
    // The request ran on the Baseline Model and the checkpoint was compensated.
    expect(assistantMessages(harness.sessionManager).at(-1)?.provider).toBe(BASELINE_PROVIDER);
    expect(harness.session.model?.provider).toBe(BASELINE_PROVIDER);
    expect(harness.session.thinkingLevel).toBe("medium");
    expect(checkpoints(harness).at(-1)?.status).toBe("complete");
    expect(harness.recorder.notices().some((n) => n.level === "warning")).toBe(true);
  });

  it("discards instance state across a session replacement and restores cleanly", async () => {
    const harness = await start({ runtimeSession: true });
    // Pending instance state: a one-shot Route Override and the runtime auto-off.
    await harness.session.prompt("/helm auto off");
    await harness.session.prompt("/helm route coding");

    // Replace the session the way /new, /resume, and reload do.
    await harness.replaceSession();
    expect(explanations(harness)).toHaveLength(0);

    // The replacement session reloads configured behavior: the override and the
    // runtime auto-off did not survive, so this idle prompt classifies again.
    harness.classification.decide({ codeWork: 0.1, deepReasoning: 0.1, externalResearch: 0.1 });
    harness.routes.fast.respond("fast reply");
    await harness.session.prompt("first prompt in the replacement session");
    expect(harness.classification.callCount()).toBe(1);
    const attempts = routingAttempts(harness);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.source).toBe("automatic");
    expect(assistantMessages(harness.sessionManager).at(-1)?.provider).toBe(
      HELM_ROUTES.fast.provider,
    );
    expect(harness.session.model?.provider).toBe(BASELINE_PROVIDER);
  });

  it("keeps machine-readable modes free of Helm output while preserving routing", async () => {
    for (const mode of ["print", "json", "rpc"] as const) {
      const harness = await start({ mode });
      harness.classification.decide({ codeWork: 0.95, deepReasoning: 0.1, externalResearch: 0.1 });
      harness.routes.coding.respond("routed reply");

      await harness.session.prompt("routed run in a machine-readable mode");

      // Routing semantics are preserved...
      expect(assistantMessages(harness.sessionManager).at(-1)?.provider).toBe(
        HELM_ROUTES.coding.provider,
      );
      expect(explanations(harness).length).toBeGreaterThan(0);
      expect(harness.session.model?.provider).toBe(BASELINE_PROVIDER);
      // ...but Helm adds no text: not a single UI call in non-interactive modes.
      expect(harness.recorder.calls).toHaveLength(0);
      await harness.dispose();
      activeHarness = undefined;
    }
  });

  it("smoke-renders the footer through the run lifecycle without pinning its text", async () => {
    const harness = await start();
    harness.classification.decide({ codeWork: 0.95, deepReasoning: 0.1, externalResearch: 0.1 });
    harness.routes.coding.respond("routed reply");

    await harness.session.prompt("footer lifecycle run");

    const statuses = harness.recorder.statuses();
    // All footer updates target Helm's single status slot.
    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses.every((status) => status.startsWith("pi-jev-helm:"))).toBe(true);
    // Ordered lifecycle states appear at least once.
    expect(statuses.some((status) => status.includes("classifying"))).toBe(true);
    expect(statuses.some((status) => status.includes("coding →"))).toBe(true);
    expect(statuses.some((status) => status.includes("restoring"))).toBe(true);
    // After restoration the footer returns to the idle state rather than
    // permanently displaying the prior result.
    expect(statuses.at(-1)).toContain("auto");
    expect(statuses.at(-1)).not.toContain("coding →");
  });
});

/**
 * Resolve once the agent starts streaming assistant text. Uses only public
 * session events, so tests can queue continuations mid-run deterministically.
 */
/** Resolve once the agent starts streaming assistant text (public session events). */
async function waitForStreamingText(harness: HelmHarness): Promise<void> {
  const startLength = harness.events.length;
  await pollUntil(
    () =>
      harness.events.slice(startLength).some(
        (event) =>
          event.type === "message_update" &&
          ((event as unknown as { assistantMessageEvent?: { type?: string } })
            .assistantMessageEvent?.type === "text_delta"),
      ),
    "agent streaming text",
  );
}

/** Resolve once the Classification Provider transport has been invoked. */
async function waitForClassificationInFlight(harness: HelmHarness): Promise<void> {
  await pollUntil(() => harness.classification.callCount() > 0, "classification request");
}

/** Resolve once Helm has applied a Route Target (pending checkpoint recorded). */
async function waitForPendingCheckpoint(harness: HelmHarness): Promise<void> {
  await pollUntil(
    () => checkpoints(harness).some((entry) => entry.status === "pending"),
    "route target application",
  );
}
