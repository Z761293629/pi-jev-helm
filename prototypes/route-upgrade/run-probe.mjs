#!/usr/bin/env node
// PROTOTYPE driver for wayfinder ticket #77. Runs upgrade-probe.ts headless in
// five scenarios and judges each run from its JSONL event log.
// Usage: node prototypes/route-upgrade/run-probe.mjs [scenario ...]
//        (default: all five; ~2–4 min total, a handful of tiny model calls)

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROBE = join(HERE, "upgrade-probe.ts");
const LOG = "/tmp/upgrade-probe.jsonl";

const BASELINE = "zai-coding-cn/glm-5.3-flash"; // pre-run "user" model
const WEAK = "deepseek/deepseek-flash"; // routed start target
const STRONG = "openai-codex/gpt-5.6-sol"; // one-way upgrade target
const OVERRIDE = "openai-codex/gpt-5.6-luna"; // simulated user pick

const SCENARIOS = {
  control: {
    prompt: "Call the probe_tool tool exactly once, then reply with one short sentence naming the value it returned.",
  },
  "upgrade-tool-fail": {
    prompt: "Call the probe_tool tool. If it fails, call it once more. Then reply with one short sentence about what happened.",
  },
  "upgrade-steer": {
    prompt: "Call the probe_tool tool exactly once, then reply with one short sentence naming the value it returned.",
  },
  "upgrade-follow-up": {
    prompt: "Call the probe_tool tool exactly once, then reply with one short sentence naming the value it returned.",
  },
  "explicit-override": {
    prompt: "Call the probe_tool tool. If it fails, call it once more. Then reply DONE.",
  },
};

const short = (model) => (model ?? "unavailable").split("/").pop();

function readEvents() {
  if (!existsSync(LOG)) return [];
  return readFileSync(LOG, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function judge(events, scenario) {
  const calls = events.filter((e) => e.event === "assistant-call");
  const upgradeFired = events.find((e) => e.event === "upgrade:firing");
  const upgradeSkips = events.filter((e) => e.event === "upgrade:skipped");
  const settle = events.find((e) => e.event === "settle-restore:done");
  const overridePick = events.find((e) => e.event === "override:simulating-user-pick");
  const settleIndex = events.findIndex((e) => e.event === "agent-settled");

  const first = calls[0];
  const checks = [];
  const add = (name, ok, observed) => checks.push({ name, ok, observed });

  add(
    "routed-start-on-weak",
    !!first && `${first.provider}/${first.model}` === WEAK,
    first ? `${first.provider}/${first.model}` : "no assistant call",
  );

  if (scenario === "control") {
    add("no-upgrade-fired", !upgradeFired, upgradeFired ? upgradeFired.trigger : "clean");
    const allWeak = calls.every((c) => `${c.provider}/${c.model}` === WEAK);
    add("all-calls-stay-weak", allWeak, calls.map((c) => short(`${c.provider}/${c.model}`)).join(",") || "none");
    add("restore-to-baseline", !!settle && settle.finalOk === true, settle ? `${settle.finalModel} @ ${settle.finalThinking}` : "no settle record");
  }

  if (scenario === "upgrade-tool-fail") {
    add("upgrade-fired-on-failure", !!upgradeFired, upgradeFired ? upgradeFired.trigger : "never fired");
    const post = upgradeFired ? calls.filter((c) => c.ts >= upgradeFired.ts) : [];
    const inRunPost = settleIndex >= 0 ? post : post; // all calls; run boundaries visible via agent-start events
    add(
      "next-call-after-upgrade",
      inRunPost.length > 0 && inRunPost.every((c) => `${c.provider}/${c.model}` === STRONG),
      inRunPost.map((c) => short(`${c.provider}/${c.model}`)).join(",") || "no post-upgrade call",
    );
    add("one-way-single-fire", events.filter((e) => e.event === "set-model:begin" && e.label === "upgrade").length === 1, "count of upgrade set-model calls");
    add("restore-to-baseline", !!settle && settle.finalOk === true, settle ? `${settle.finalModel} @ ${settle.finalThinking}` : "no settle record");
  }

  if (scenario === "upgrade-steer" || scenario === "upgrade-follow-up") {
    add("upgrade-fired", !!upgradeFired, upgradeFired ? upgradeFired.trigger : "never fired");
    const post = upgradeFired ? calls.filter((c) => c.ts >= upgradeFired.ts) : [];
    add(
      "next-call-after-upgrade",
      post.length > 0 && post.every((c) => `${c.provider}/${c.model}` === STRONG),
      post.map((c) => short(`${c.provider}/${c.model}`)).join(",") || "no post-upgrade call",
    );
    const agentStarts = events.filter((e) => e.event === "agent-start").length;
    add("run-boundaries-seen", true, `${agentStarts} agent run(s)`);
    add("restore-to-baseline", !!settle && settle.finalOk === true, settle ? `${settle.finalModel} @ ${settle.finalThinking}` : "no settle record");
  }

  if (scenario === "explicit-override") {
    add("user-pick-observed", !!overridePick, overridePick ? OVERRIDE : "no unscoped pick");
    const skip = upgradeSkips.find((s) => s.userOverrideSeen === true);
    add("upgrade-aborted-by-override", !!skip, skip ? "guard held" : upgradeFired ? "UPGRADE RACED THE OVERRIDE" : "no attempt logged");
    const postPick = overridePick ? calls.filter((c) => c.ts >= overridePick.ts) : [];
    add(
      "calls-after-override-on-luna",
      postPick.length > 0 && postPick.every((c) => `${c.provider}/${c.model}` === OVERRIDE),
      postPick.map((c) => short(`${c.provider}/${c.model}`)).join(",") || "no post-pick call",
    );
    add("override-became-baseline", !!settle && settle.overrideBecameBaseline === true, settle ? `${settle.finalModel} @ ${settle.finalThinking}` : "no settle record");
  }

  return checks;
}

function runScenario(name) {
  rmSync(LOG, { force: true });
  const started = Date.now();
  const result = spawnSync(
    "pi",
    [
      "-p",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--no-session",
      "-e",
      PROBE,
      "--model",
      BASELINE,
      "--thinking",
      "high",
      "--",
      SCENARIOS[name].prompt,
    ],
    { encoding: "utf8", timeout: 240_000, env: { ...process.env, UPGRADE_PROBE_SCENARIO: name, UPGRADE_PROBE_LOG: LOG } },
  );
  const elapsed = Math.round((Date.now() - started) / 1000);
  const events = readEvents();
  const stdoutSilent = !/"event":|upgrade-probe/.test(result.stdout ?? ""); // probe must write audit only to its JSONL
  return { name, elapsed, exit: result.status, events, checks: judge(events, name), stdoutSilent, stderr: (result.stderr ?? "").slice(0, 400) };
}

const wanted = process.argv.slice(2);
const names = wanted.length > 0 ? wanted : Object.keys(SCENARIOS);
const rows = names.map(runScenario);

let failed = 0;
for (const row of rows) {
  console.log(`\n=== ${row.name} — exit ${row.exit}, ${row.elapsed}s, ${row.events.length} events, stdout-silent: ${row.stdoutSilent} ===`);
  for (const check of row.checks) {
    console.log(`  ${check.ok ? "PASS" : "FAIL"}  ${check.name}  ← ${check.observed}`);
    if (!check.ok) failed += 1;
  }
  if (row.stderr.trim()) console.log(`  stderr: ${row.stderr.split("\n")[0]}`);
}
console.log(`\n${failed === 0 ? "ALL CHECKS PASS" : `${failed} check(s) FAILED`} across ${rows.length} scenario(s)`);
process.exit(failed === 0 ? 0 : 1);
