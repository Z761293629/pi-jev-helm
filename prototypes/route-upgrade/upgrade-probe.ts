// PROTOTYPE — throwaway probe for wayfinder ticket #77 ("验证 Routed Run 内安全升级 Route 的可行性").
// NOT production code. Answers one question with the public Pi extension API:
//   can an extension upgrade the Route Target one-way MID-RUN such that the next
//   model call uses it, without breaking checkpoint restore / explicit override /
//   one-way semantics / machine-readable silence?
// Mirrors Helm's minimal machinery (scoped selection via AsyncLocalStorage,
// checkpoint append, settle restore) but records facts to a JSONL file and lets
// run-probe.mjs judge. Writes nothing to stdout/stderr (machine-readable safe).

import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync } from "node:fs";
import { Type } from "typebox";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

type PiModel = NonNullable<ExtensionContext["model"]>;
type PiThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;

const SCENARIO = process.env.UPGRADE_PROBE_SCENARIO ?? "control";
const LOG = process.env.UPGRADE_PROBE_LOG ?? "/tmp/upgrade-probe.jsonl";

// Role models: baseline is what the "user" had before the run; weak is the
// Route Target Helm would apply at run start; strong is the one-way upgrade
// target; luna stands in for a user's Explicit Model Override.
const WEAK = { provider: "deepseek", model: "deepseek-flash", thinking: "low" as PiThinkingLevel };
const STRONG = { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "medium" as PiThinkingLevel };
const OVERRIDE = { provider: "openai-codex", model: "gpt-5.6-luna" };

const helmSelectionOperation = new AsyncLocalStorage<{ kind: string }>();

function log(event: string, data: unknown): void {
  try {
    appendFileSync(LOG, `${JSON.stringify({ ts: Date.now(), event, scenario: SCENARIO, ...((data as object) ?? {}) })}\n`);
  } catch {
    /* prototype: never crash the run over audit I/O */
  }
}

function sameModel(a: PiModel | undefined, provider: string, model: string): boolean {
  return !!a && a.provider === provider && a.id === model;
}

export default function upgradeProbe(pi: ExtensionAPI): void {
  let baselineModel: PiModel | undefined;
  let baselineThinking: PiThinkingLevel | undefined;
  let runActive = false;
  let upgradeArmed = false;
  let upgradedYet = false;
  let userOverrideSeen = false;
  let scopedThinkingOp = false;

  const resolve = (ctx: ExtensionContext, provider: string, model: string): PiModel | undefined => {
    try {
      const found = ctx.modelRegistry.find(provider, model);
      return sameModel(found, provider, model) ? found : undefined;
    } catch {
      return undefined;
    }
  };

  const scopedSetModel = async (ctx: ExtensionContext, model: PiModel, label: string): Promise<boolean> => {
    const op = { kind: "model" };
    log("set-model:begin", { label, target: `${model.provider}/${model.id}` });
    try {
      const ok = await helmSelectionOperation.run(op, () => pi.setModel(model));
      log("set-model:result", { label, ok, effective: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unavailable" });
      return ok;
    } catch (error) {
      log("set-model:error", { label, error: String(error) });
      return false;
    }
  };

  const scopedSetThinking = (level: PiThinkingLevel, label: string): void => {
    scopedThinkingOp = true;
    try {
      helmSelectionOperation.run({ kind: "thinking" }, () => pi.setThinkingLevel(level));
      log("set-thinking", { label, level, effective: pi.getThinkingLevel() });
    } catch (error) {
      log("set-thinking:error", { label, error: String(error) });
    } finally {
      scopedThinkingOp = false;
    }
  };

  let callCount = 0;

  // The lift-able one-way upgrade guard.
  const maybeUpgrade = async (ctx: ExtensionContext, trigger: string): Promise<void> => {
    if (!runActive || !upgradeArmed || upgradedYet || userOverrideSeen) {
      log("upgrade:skipped", { trigger, runActive, upgradeArmed, upgradedYet, userOverrideSeen });
      return;
    }
    const strong = resolve(ctx, STRONG.provider, STRONG.model);
    if (!strong) {
      log("upgrade:target-unavailable", { trigger });
      return;
    }
    upgradedYet = true; // one-way: fire at most once per run, never downgrade
    log("upgrade:firing", { trigger, target: `${STRONG.provider}/${STRONG.model}` });
    await scopedSetModel(ctx, strong, "upgrade");
    scopedSetThinking(STRONG.thinking, "upgrade");
    if (SCENARIO === "upgrade-steer") {
      pi.sendUserMessage("Continue: restate the tool result in one short sentence.", { deliverAs: "steer" });
      log("steer-sent", {});
    }
    if (SCENARIO === "upgrade-follow-up") {
      pi.sendUserMessage("Now reply with exactly: SECOND-RESPONSE", { deliverAs: "followUp" });
      log("follow-up-sent", {});
    }
  };

  pi.registerTool({
    name: "probe_tool",
    label: "Probe Tool",
    description: "Returns a fixed value. First call fails in upgrade-tool-fail and explicit-override scenarios.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      callCount += 1;
      const fail = (SCENARIO === "upgrade-tool-fail" || SCENARIO === "explicit-override") && callCount === 1;
      log("probe-tool:execute", { call: callCount, willFail: fail });
      if (fail) throw new Error("probe_tool intentional failure #1");
      return { content: [{ type: "text", text: "probe-value-42" }], details: {} };
    },
  });
  pi.on("session_start", async (_event, ctx) => {
    runActive = false;
    upgradeArmed = false;
    upgradedYet = false;
    userOverrideSeen = false;
    callCount = 0;
    baselineModel = ctx.model ?? undefined;
    baselineThinking = pi.getThinkingLevel();
    log("session-start", {
      baseline: baselineModel ? `${baselineModel.provider}/${baselineModel.id}` : "unavailable",
      thinking: baselineThinking,
      reason: (_event as unknown as { reason?: string })?.reason,
    });
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    if (!ctx.model) {
      log("routed-start:aborted", { reason: "baseline-unavailable" });
      return;
    }
    baselineModel = ctx.model;
    baselineThinking = pi.getThinkingLevel();
    runActive = true;
    upgradeArmed = SCENARIO !== "control";
    try {
      pi.appendEntry("upgrade-probe-checkpoint", {
        status: "pending",
        baseline: baselineModel
          ? { provider: baselineModel.provider, model: baselineModel.id, thinkingLevel: baselineThinking }
          : undefined,
      });
      log("checkpoint:pending", { baseline: `${baselineModel.provider}/${baselineModel.id}`, thinking: baselineThinking });
    } catch (error) {
      log("checkpoint:error", { error: String(error) });
    }
    const weak = resolve(ctx, WEAK.provider, WEAK.model);
    if (!weak) {
      log("routed-start:aborted", { reason: "weak-target-unavailable" });
      runActive = false;
      return;
    }
    await scopedSetModel(ctx, weak, "routed-start");
    scopedSetThinking(WEAK.thinking, "routed-start");
    log("routed-start:applied", { runActive, upgradeArmed });
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    log("tool-execution-end", { tool: event.toolName, isError: event.isError, call: callCount });
    if (event.toolName !== "probe_tool") return;
    // Trigger map: upgrade-tool-fail re-judges ON failure (工具失败后复判);
    // steer / follow-up re-judge on first success (计划形成后复判);
    // explicit-override fails first, then a user pick races the upgrade.
    const failTriggers = SCENARIO === "upgrade-tool-fail" || SCENARIO === "explicit-override";
    if (event.isError !== failTriggers) return;
    if (SCENARIO === "explicit-override") {
      // Simulate the user's Explicit Model Override (unscoped set —
      // model_select source:"set" cannot tell user from extension, so an
      // unscoped mid-run set is exactly what a user pick looks like).
      const luna = resolve(ctx, OVERRIDE.provider, OVERRIDE.model);
      if (luna) {
        log("override:simulating-user-pick", { target: `${OVERRIDE.provider}/${OVERRIDE.model}` });
        try {
          await pi.setModel(luna);
        } catch (error) {
          log("override:error", { error: String(error) });
        }
      }
    }
    await maybeUpgrade(ctx, `${event.isError ? "tool-fail" : "tool-ok"}:probe_tool`);
  });

  pi.on("message_end", (event) => {
    const message = event.message as { role?: string; provider?: string; model?: string; providerThinkingLevel?: string; usage?: Record<string, number> };
    if (message?.role !== "assistant") return;
    log("assistant-call", {
      provider: message.provider,
      model: message.model,
      thinking: message.providerThinkingLevel,
      usage: message.usage
        ? { input: message.usage.input, output: message.usage.output, cacheRead: message.usage.cacheRead, cacheWrite: message.usage.cacheWrite }
        : undefined,
    });
  });

  pi.on("model_select", (event, ctx) => {
    const scoped = helmSelectionOperation.getStore();
    const inScope = !!scoped && scoped.kind === "model";
    log("model-select", {
      model: `${event.model.provider}/${event.model.id}`,
      source: (event as unknown as { source?: string }).source,
      inScope,
      runActive,
    });
    if (!inScope && runActive) userOverrideSeen = true;
    void ctx;
  });

  pi.on("thinking_level_select", (event) => {
    const inScope = scopedThinkingOp || !!helmSelectionOperation.getStore();
    log("thinking-level-select", { level: event.level, inScope, runActive });
  });

  pi.on("agent_start", () => {
    log("agent-start", {});
  });

  pi.on("agent_end", () => {
    log("agent-end", {});
  });

  pi.on("agent_settled", async (_event, ctx) => {
    log("agent-settled", { hasPendingMessages: ctx.hasPendingMessages?.() });
    if (!runActive || !baselineModel) return;
    runActive = false;
    // Helm semantics: an explicit override becomes the new Baseline itself —
    // restoring the old baseline would fight the user's pick. Only a clean
    // run (no override) restores what it replaced.
    if (userOverrideSeen) {
      try {
        pi.appendEntry("upgrade-probe-checkpoint", {
          status: "complete",
          baseline: ctx.model ? { provider: ctx.model.provider, model: ctx.model.id, thinkingLevel: pi.getThinkingLevel() } : undefined,
        });
      } catch (error) {
        log("checkpoint:error", { error: String(error) });
      }
      log("settle-restore:done", {
        restored: true,
        overrideBecameBaseline: true,
        finalModel: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unavailable",
        finalThinking: pi.getThinkingLevel(),
      });
      return;
    }
    const restored = await scopedSetModel(ctx, baselineModel, "settle-restore");
    if (baselineThinking !== undefined) scopedSetThinking(baselineThinking, "settle-restore");
    const finalOk = sameModel(ctx.model, baselineModel.provider, baselineModel.id);
    try {
      pi.appendEntry("upgrade-probe-checkpoint", {
        status: finalOk ? "complete" : "restoration_failed",
        baseline: { provider: baselineModel.provider, model: baselineModel.id, thinkingLevel: baselineThinking },
      });
      log("checkpoint:complete", { restored, finalOk });
    } catch (error) {
      log("checkpoint:error", { error: String(error) });
    }
    log("settle-restore:done", {
      restored,
      finalOk,
      finalModel: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unavailable",
      finalThinking: pi.getThinkingLevel(),
    });
  });
}
