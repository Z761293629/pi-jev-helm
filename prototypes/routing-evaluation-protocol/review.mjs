#!/usr/bin/env node
/**
 * Terminal reviewer for the routing evaluation protocol prototype.
 *
 * The protocol logic and the scenario presets live inside index.html so the
 * prototype stays a single double-clickable file. This script extracts those
 * two pure pieces and prints verdicts for a terminal, so the protocol can be
 * reviewed over SSH where no browser is available.
 *
 * Usage:
 *   node prototypes/routing-evaluation-protocol/review.mjs
 *   node .../review.mjs --max-current-cost 0.75 --min-decisive 40
 *   node .../review.mjs --sweep-cost
 */
import { readFile } from "node:fs/promises";

const htmlUrl = new URL("./index.html", import.meta.url);
const html = await readFile(htmlUrl, "utf8");

function slice(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  if (start === -1) throw new Error(`missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  if (end === -1) throw new Error(`missing end marker: ${endMarker}`);
  return source.slice(start, end + endMarker.length);
}

const protocolSource = slice(html, "const Protocol = (() => {", "\n})();");
const scenariosSource = slice(html, "const scenarios = [", "\n];");

const Protocol = new Function(`${protocolSource}\nreturn Protocol;`)();
const scenarios = new Function(`${scenariosSource}\nreturn scenarios;`)();

const argv = process.argv.slice(2);
function flag(name, fallback) {
  const index = argv.indexOf(`--${name}`);
  if (index === -1 || index === argv.length - 1) return fallback;
  const value = Number(argv[index + 1]);
  return Number.isFinite(value) ? value : fallback;
}
const overrides = {
  maxCandidateToCurrentCostRatio: flag("max-current-cost", undefined),
  maxCandidateToStrongCostRatio: flag("max-strong-cost", undefined),
  maxLatencyRatio: flag("max-latency", undefined),
  minDecisivePerMode: flag("min-decisive", undefined),
};

function buildState(preset) {
  const base = Protocol.initialState();
  if (overrides.maxCandidateToCurrentCostRatio !== undefined) base.thresholds.maxCandidateToCurrentCostRatio = overrides.maxCandidateToCurrentCostRatio;
  if (overrides.maxCandidateToStrongCostRatio !== undefined) base.thresholds.maxCandidateToStrongCostRatio = overrides.maxCandidateToStrongCostRatio;
  if (overrides.maxLatencyRatio !== undefined) base.thresholds.maxLatencyRatio = overrides.maxLatencyRatio;
  if (overrides.minDecisivePerMode !== undefined) base.thresholds.minDecisivePerMode = overrides.minDecisivePerMode;
  base.evidence = structuredClone(preset.evidence);
  base.objective = structuredClone(preset.objective);
  base.economics = structuredClone(preset.economics);
  base.loaded = { quality: true, objective: true, economics: true };
  return base;
}

const pad = (value, width) => String(value).padEnd(width);
const pct = (n) => `${(n * 100).toFixed(1)}%`;

console.log("路由评测协议 · 终端评审");
console.log("目标：未检测到显著质量退化，同时相对当前 Helm 和始终强模型至少节省 20%。\n");

console.log(
  `${pad("场景", 22)}${pad("首次误判", 16)}${pad("能力漂移", 16)}${pad("总体胜率 95%CI", 22)}${pad("/Helm", 8)}${pad("/强模", 8)}${pad("p95", 8)}判定`,
);
console.log("-".repeat(116));

for (const scenario of scenarios) {
  const state = buildState(scenario.preset);
  const result = Protocol.evaluate(state);
  const mode = (m) => `${m.wins}/${m.losses}/${m.ties}`;
  console.log(
    pad(scenario.name, 22) +
      pad(mode(result.modes.initial), 16) +
      pad(mode(result.modes.drift), 16) +
      pad(`${pct(result.modes.total.estimate)} ${pct(result.modes.total.low)}–${pct(result.modes.total.high)}`, 22) +
      pad(`${result.economics.candidateToCurrentCostRatio.toFixed(2)}×`, 8) +
      pad(`${result.economics.candidateToStrongCostRatio.toFixed(2)}×`, 8) +
      pad(`${result.economics.latencyRatio.toFixed(2)}×`, 8) +
      result.title,
  );
}

console.log("\n图例：首次误判 / 能力漂移 列的格式为 候选胜/基线胜/平局。");
console.log(
  `当前阈值：每类至少 ${overrides.minDecisivePerMode ?? 20} 个决定性样本 · ` +
    `客观检查不下降 · ` +
    `候选/Helm ≤ ${(overrides.maxCandidateToCurrentCostRatio ?? 0.8).toFixed(2)}× · ` +
    `候选/强模 ≤ ${(overrides.maxCandidateToStrongCostRatio ?? 0.8).toFixed(2)}× · ` +
    `p95 延迟 ≤ ${(overrides.maxLatencyRatio ?? 1.2).toFixed(2)}×`,
);

if (argv.includes("--sweep-cost")) {
  const scenario = scenarios[0];
  console.log(`\n费用护栏敏感性（场景：${scenario.name}，其余阈值不变）`);
  console.log(`${pad("费用比", 10)}判定`);
  console.log("-".repeat(44));
  for (const ratio of [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 1.0]) {
    const preset = structuredClone(scenario.preset);
    preset.economics.candidateAvgCost = preset.economics.currentHelmAvgCost * ratio;
    const state = buildState(preset);
    const result = Protocol.evaluate(state);
    console.log(pad(`${ratio.toFixed(2)}×`, 10) + result.title);
  }
}
