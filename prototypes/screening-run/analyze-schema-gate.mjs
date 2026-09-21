#!/usr/bin/env node
// PROTOTYPE — throwaway. Issue #71 schema-gate offline analysis.
//
// Reads cached classification replays (classify-<schema>-rep<k>.jsonl) and the
// #69 pilot results (baseline-results.jsonl) and produces, per schema:
//   1. corpus gate verdict — exact real-jev-gate semantics (vector match +
//      threshold 0.75 + clear-must-route / ambiguous-must-fail-open, 2-of-3)
//   2. screening fail-open rate, route distribution, rep agreement
//   3. v1↔v2 decision flips
//   4. offline policy replays on cached judgments: A threshold sweep,
//      B1 inconsistency re-check, B2 k=3 vote
//   5. downstream cost proxy from #69 per-route pilot costs (n≈10, noisy)
// Output: markdown + JSON into ~/.pi-jev-helm-eval/screening-runs/.
//
// Usage: node analyze-schema-gate.mjs [--reps 3]

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { CLASSIFICATION_CORPUS } from "../../dist/classification-corpus.js";

const poolDir = process.env.PI_JEV_EVAL_POOL || path.join(os.homedir(), ".pi-jev-helm-eval");
const runDir = path.join(poolDir, "screening-runs");
const args = process.argv.slice(2);
const REPS = args.includes("--reps") ? Number(args[args.indexOf("--reps") + 1]) : 3;
const SIGNALS = ["codeWork", "deepReasoning", "externalResearch"];
const THRESHOLD = 0.75;

// ---------- load ----------

function loadRecords(schema, rep) {
  const f = path.join(runDir, `classify-${schema}-rep${rep}.jsonl`);
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

const cache = new Map();
function records(schema, rep, source, id) {
  const key = `${schema}:${rep}`;
  if (!cache.has(key)) cache.set(key, loadRecords(schema, rep));
  return cache.get(key).filter((r) => r.source === source && r.id === id);
}

// ---------- v1/v2 → classification ----------

function toV1(rec) {
  // v1 answers are the three signal probabilities directly.
  const signals = {};
  for (const s of SIGNALS) {
    const p = rec.probs[s];
    if (typeof p !== "number") return null;
    signals[s] = { value: p >= 0.5, confidence: Math.max(p, 1 - p), p };
  }
  return { schema: "v1", signals, levels: null, raw: rec };
}

function toV2(rec) {
  // Cumulative graded questions: enforce monotone P(≥1) ≥ P(≥2) ≥ P(≥3), then
  // level = max k with P(≥k) ≥ 0.5. Boolean compatibility: level ≥ 1.
  const signals = {};
  const levels = {};
  for (const s of SIGNALS) {
    let prev = 1.01;
    const ps = [];
    for (let k = 1; k <= 3; k += 1) {
      const p = rec.probs[`${s}_g${k}`];
      if (typeof p !== "number") return null;
      const mono = Math.min(p, prev);
      ps.push(mono);
      prev = mono;
    }
    let level = 0;
    for (let k = 0; k < 3; k += 1) if (ps[k] >= 0.5) level = k + 1;
    signals[s] = { value: level >= 1, confidence: Math.max(ps[0], 1 - ps[0]), p: ps[0] };
    levels[s] = level;
  }
  return { schema: "v2", signals, levels, raw: rec };
}

const decode = { v1: toV1, v2: toV2 };

// ---------- routing policy (verbatim semantics of src/routing-policy.ts) ----------

function candidateRoute(c) {
  if (c.signals.externalResearch.value) return "research";
  if (c.signals.codeWork.value) return "coding";
  if (c.signals.deepReasoning.value) return "reasoning";
  return "fast";
}
function relevantSignals(route) {
  if (route === "research") return ["externalResearch"];
  if (route === "coding") return ["externalResearch", "codeWork"];
  return ["externalResearch", "codeWork", "deepReasoning"];
}
function selectRoute(classification, threshold = THRESHOLD) {
  const route = candidateRoute(classification);
  const relevant = relevantSignals(route);
  const low = relevant.filter((n) => classification.signals[n].confidence < threshold);
  return low.length === 0
    ? { ok: true, route, lowConfidenceSignals: [] }
    : { ok: false, route: "fail-open", candidate: route, lowConfidenceSignals: low };
}

function decision(c) {
  const d = selectRoute(c);
  return d.ok ? d.route : "fail-open";
}

// ---------- corpus gate (exact evaluateRealJevGateExecution semantics) ----------

function corpusGate(schema, threshold = THRESHOLD) {
  const perEntry = [];
  for (const entry of CLASSIFICATION_CORPUS) {
    const execs = [];
    for (let rep = 1; rep <= REPS; rep += 1) {
      const recs = records(schema, rep, "corpus", entry.id).filter((r) => r.ok);
      const c = recs.length ? decode[schema](recs[0]) : null;
      if (!c) {
        execs.push({ passed: false, reason: "no_ok_record" });
        continue;
      }
      const vectorMatch = SIGNALS.every((s) => c.signals[s].value === entry.expected[s]);
      if (!vectorMatch) {
        execs.push({ passed: false, reason: "boolean_vector_did_not_match_expected" });
        continue;
      }
      const d = selectRoute(c, threshold);
      if (entry.clarity === "clear") {
        execs.push({ passed: d.ok, reason: d.ok ? "vector_matched_and_confidences_met_threshold" : `relevant_confidence_below_threshold:${d.lowConfidenceSignals.join("+")}` });
      } else {
        execs.push({ passed: !d.ok, reason: !d.ok ? "vector_matched_and_failed_open" : "policy_selected_a_route_instead_of_failing_open" });
      }
    }
    const passedExecutions = execs.filter((e) => e.passed).length;
    perEntry.push({ id: entry.id, clarity: entry.clarity, boundary: entry.boundary ?? null, passedExecutions, passed: passedExecutions >= 2, execs });
  }
  const failed = perEntry.filter((e) => !e.passed);
  return { schema, passed: failed.length === 0, failedCount: failed.length, entries: perEntry, failed };
}

// ---------- screening analysis ----------

function screening(schema) {
  const manifest = JSON.parse(fs.readFileSync(path.join(poolDir, "screening-manifest.json"), "utf8"));
  const samples = manifest.samples.map((s) => {
    const reps = [];
    for (let rep = 1; rep <= REPS; rep += 1) {
      const recs = records(schema, rep, "screening", s.id).filter((r) => r.ok);
      if (!recs.length) {
        reps.push(null);
        continue;
      }
      const c = decode[schema](recs[0]);
      reps.push({ c, decision: decision(c) });
    }
    const okReps = reps.filter(Boolean);
    const decisions = okReps.map((r) => r.decision);
    const modal = decisions.length
      ? decisions.sort((a, b) => decisions.filter((x) => x === b).length - decisions.filter((x) => x === a).length)[0]
      : null;
    const agree = okReps.length === REPS && new Set(decisions).size === 1;
    return { id: s.id, stratum: s.stratum, reps, modal, agree };
  });

  const n = samples.length;
  const withReps = samples.filter((s) => s.reps.filter(Boolean).length);
  const failOpenRate =
    withReps.reduce((acc, s) => acc + s.reps.filter(Boolean).filter((r) => r.decision === "fail-open").length / Math.max(1, s.reps.filter(Boolean).length), 0) / Math.max(1, withReps.length);
  const routeDist = {};
  for (const s of withReps) {
    for (const r of s.reps.filter(Boolean)) routeDist[r.decision] = (routeDist[r.decision] ?? 0) + 1;
  }
  const totalReps = Object.values(routeDist).reduce((a, b) => a + b, 0);
  for (const k of Object.keys(routeDist)) routeDist[k] = { count: routeDist[k], share: +(routeDist[k] / totalReps).toFixed(3) };

  // confidence bands for relevant signals (arm-A sweep context)
  const bands = {};
  for (const s of withReps) {
    for (const r of s.reps.filter(Boolean)) {
      const cand = selectRoute(r.c);
      for (const sig of cand.ok ? relevantSignals(cand.route) : cand.lowConfidenceSignals) {
        const b = Math.min(0.95, Math.floor(r.c.signals[sig].confidence * 20) / 20).toFixed(2);
        bands[b] = (bands[b] ?? 0) + 1;
      }
    }
  }

  const agreement = {
    decisionLevel: +(samples.filter((s) => s.agree).length / Math.max(1, withReps.length)).toFixed(3),
    vectorLevel: +(withReps.filter((s) => {
      const vecs = s.reps.filter(Boolean).map((r) => SIGNALS.map((n) => r.c.signals[n].value ? 1 : 0).join(""));
      return new Set(vecs).size === 1;
    }).length / Math.max(1, withReps.length)).toFixed(3),
  };

  return { schema, n, failOpenRate: +failOpenRate.toFixed(3), routeDist, bands, agreement, samples };
}

// ---------- policy replays on cached judgments ----------

function replayA(scr, schema, proxy) {
  // Threshold sweep on rep-1 judgments (fail-open rate + routed-away count).
  const rows = [];
  for (const t of [0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9]) {
    let fo = 0;
    let n = 0;
    const dist = {};
    for (const s of scr.samples) {
      const r = s.reps[0];
      if (!r) continue;
      n += 1;
      const d = selectRoute(r.c, t);
      const dec = d.ok ? d.route : "fail-open";
      if (dec === "fail-open") fo += 1;
      dist[dec] = (dist[dec] ?? 0) + 1;
    }
    const shares = {};
    for (const [k, v] of Object.entries(dist)) shares[k] = { share: v / Math.max(1, n) };
    rows.push({ threshold: t, failOpenRate: +(fo / Math.max(1, n)).toFixed(3), dist, expectedCostProxy: expectedCost(shares, proxy) });
  }
  return { schema, rows };
}

function replayB1(scr, schema) {
  // Inconsistency re-check at DECISION level: rep1 vs rep2 final decisions
  // (route or fail-open); equal → use rep1; differ → rep3 is the decisive
  // re-judgment. Policy at 0.75 as usual.
  let n = 0;
  let rechecked = 0;
  const dist = {};
  for (const s of scr.samples) {
    const [r1, r2, r3] = s.reps;
    if (!r1 || !r2) continue;
    n += 1;
    const v1 = SIGNALS.map((x) => r1.c.signals[x].value).join("");
    const v2 = SIGNALS.map((x) => r2.c.signals[x].value).join("");
    let final;
    if (v1 === v2 && r1.decision === r2.decision) final = r1.c;
    else {
      rechecked += 1;
      final = r3?.c ?? r1.c;
    }
    const d = selectRoute(final);
    const dec = d.ok ? d.route : "fail-open";
    dist[dec] = (dist[dec] ?? 0) + 1;
  }
  const fo = dist["fail-open"] ?? 0;
  return { schema, n, rechecked, failOpenRate: +(fo / Math.max(1, n)).toFixed(3), dist };
}

function replayB2(scr, schema) {
  // k=3 majority vote per signal; confidence = median of the three reps'
  // confidences for that signal. Policy at 0.75 as usual.
  let n = 0;
  const dist = {};
  for (const s of scr.samples) {
    const rs = s.reps.filter(Boolean);
    if (rs.length < 3) continue;
    n += 1;
    const c = { schema: `${schema}+B2`, signals: {}, levels: null, raw: null };
    for (const sig of SIGNALS) {
      const vs = rs.map((r) => r.c.signals[sig].value);
      const value = vs.filter(Boolean).length >= 2;
      const cs = rs.map((r) => r.c.signals[sig].confidence).sort((a, b) => a - b);
      c.signals[sig] = { value, confidence: cs[1] };
    }
    const d = selectRoute(c);
    const dec = d.ok ? d.route : "fail-open";
    dist[dec] = (dist[dec] ?? 0) + 1;
  }
  const fo = dist["fail-open"] ?? 0;
  return { schema, n, failOpenRate: +(fo / Math.max(1, n)).toFixed(3), dist };
}

// ---------- cost proxy from #69 pilot ----------

function costProxy() {
  const f = path.join(poolDir, "baseline-runs", "baseline-results.jsonl");
  if (!fs.existsSync(f)) return null;
  const rows = fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const byRoute = {};
  for (const r of rows) {
    if (r.arm !== "helm" || !r.usage?.cost) continue;
    const route = r.routing?.[0]?.route ?? "fail-open";
    (byRoute[route] ??= []).push(r.usage.cost);
  }
  const mean = {};
  for (const [k, v] of Object.entries(byRoute)) mean[k] = +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(4);
  const strongRows = rows.filter((r) => r.arm === "strong" && r.usage?.cost);
  const strongMean = strongRows.length ? +(strongRows.reduce((a, r) => a + r.usage.cost, 0) / strongRows.length).toFixed(4) : null;
  return { note: "n≈10 helm pilot runs per route; noisy proxy only — definitive costs come from #71 full runs", routeMeanCost: mean, strongMeanCost: strongMean };
}

function expectedCost(distShares, proxy) {
  if (!proxy) return null;
  let total = 0;
  let missing = false;
  for (const [route, { share }] of Object.entries(distShares)) {
    const m = proxy.routeMeanCost[route === "fail-open" ? "fail-open" : route];
    if (m == null) missing = true;
    else total += share * m;
  }
  return missing ? null : +total.toFixed(4);
}

// corpus gate × threshold sweep (schema operating-point search)
function corpusSweep(schema) {
  const rows = [];
  for (const t of [0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9]) {
    const g = corpusGate(schema, t);
    rows.push({ threshold: t, failedCount: g.failedCount, failed: g.failed.map((f) => f.id) });
  }
  return rows;
}

// ---------- report ----------

function fmtDist(d) {
  return Object.entries(d).map(([k, v]) => `${k} ${(v.share * 100).toFixed(0)}%`).join(" · ");
}

const proxy = costProxy();
const out = [];
for (const schema of ["v1", "v2"]) {
  const gate = corpusGate(schema);
  const scr = screening(schema);
  const a = replayA(scr, schema, proxy);
  const b1 = replayB1(scr, schema);
  const b2 = replayB2(scr, schema);
  out.push({ schema, gate: { passed: gate.passed, failedCount: gate.failedCount, failed: gate.failed.map((f) => ({ id: f.id, passedExecutions: f.passedExecutions, reasons: f.execs.map((e) => e.reason) })) }, screening: { n: scr.n, failOpenRate: scr.failOpenRate, routeDist: scr.routeDist, bands: scr.bands, agreement: scr.agreement, samples: scr.samples.map((s) => ({ id: s.id, stratum: s.stratum, modal: s.modal, agree: s.agree, reps: s.reps.map((r) => (r ? r.decision : null)) })) }, replays: { A: a, B1: b1, B2: b2 } });
}

// v1↔v2 flips
const [s1, s2] = out.map((o) => o.screening.samples);
const flips = s1.filter((a, i) => a.modal !== s2[i].modal).map((a, i) => ({ id: a.id, stratum: a.stratum, v1: a.modal, v2: s2[i].modal }));

for (const o of out) {
  o.expectedCostProxy = expectedCost(o.screening.routeDist, proxy);
  o.corpusSweep = corpusSweep(o.schema);
}

// ---------- labeling sheet (HITL: manual ground-truth labels, issue #71) ----------

function labelingSheet() {
  const manifest = JSON.parse(fs.readFileSync(path.join(poolDir, "screening-manifest.json"), "utf8"));
  const lines = [
    "# 筛选集人工标注清单 — issue #71 schema 门（生成 " + new Date().toISOString() + "）",
    "",
    "每条样本标注三个 Capability Signal 的真实需求（整个请求的并集语义）：",
    "codeWork / deepReasoning / externalResearch ∈ {0,1}（可选附 level 0-3）。",
    "判据见 CONTEXT.md 术语；只看请求本身完成它需要什么，不看模型表现。",
    "文本截去 220 字；全文在池 `~/.pi-jev-helm-eval/pool/<id>.json`（审阅时已批准）。",
    "填法：把每行末尾 `cw=_,dr=_,er=_` 改为 0/1。机器列已预填供对照（勿改）。",
    "",
    "| id | stratum | 请求文本（脱敏后，载去 220 字） | v1 机器判定 | v2 机器判定(modal) | 人工 |",
    "|---|---|---|---|---|---|",
  ];
  const v1S = out.find((o) => o.schema === "v1").screening.samples;
  const v2S = out.find((o) => o.schema === "v2").screening.samples;
  manifest.samples.forEach((s, i) => {
    const c = JSON.parse(fs.readFileSync(path.join(poolDir, "pool", `${s.id}.json`), "utf8"));
    const text = c.text.replaceAll(os.homedir(), "~").replaceAll("|", "\\|").replaceAll("\n", " ⏎ ").slice(0, 220);
    lines.push(`| ${s.id} | ${s.stratum} | ${text} | ${v1S[i].modal} | ${v2S[i].modal} | cw=_,dr=_,er=_ |`);
  });
  fs.writeFileSync(path.join(runDir, "labeling-sheet.md"), lines.join("\n"));
  return path.join(runDir, "labeling-sheet.md");
}
const sheetPath = labelingSheet();

const summary = { reps: REPS, threshold: THRESHOLD, corpusSize: CLASSIFICATION_CORPUS.length, schemas: out, flips, costProxy: proxy };

fs.writeFileSync(path.join(runDir, "schema-gate-summary.json"), JSON.stringify(summary, null, 2));

const md = [];
md.push(`# Schema gate — offline replay summary (${new Date().toISOString()})`);
md.push(`\nReps per schema: ${REPS} · threshold ${THRESHOLD} · corpus ${CLASSIFICATION_CORPUS.length}`);
for (const o of out) {
  md.push(`\n## ${o.schema.toUpperCase()}${o.schema === "v2" ? " (C′ anchors)" : " (boolean, shipped)"}`);
  md.push(`\n- Corpus gate: **${o.gate.passed ? "PASS" : `FAIL (${o.gate.failedCount} entries)`}**${o.gate.failed.length ? " — " + o.gate.failed.map((f) => f.id).join(", ") : ""}`);
  md.push(`- Screening fail-open rate: **${(o.screening.failOpenRate * 100).toFixed(1)}%** (50 samples)`);
  md.push(`- Route distribution: ${fmtDist(o.screening.routeDist)}`);
  md.push(`- Rep agreement: decision-level ${(o.screening.agreement.decisionLevel * 100).toFixed(0)}% · vector-level ${(o.screening.agreement.vectorLevel * 100).toFixed(0)}%`);
  md.push(`- Expected cost proxy: ${o.expectedCostProxy != null ? "$" + o.expectedCostProxy + "/run" : "n/a"} ${proxy ? "(" + proxy.note + ")" : ""}`);
  const r = o.replays;
  md.push(`\n| replay | fail-open | distribution |`);
  md.push(`|---|---|---|`);
  const d = (dist) => Object.entries(dist).map(([k, v]) => `${k}:${v}`).join(" · ");
  md.push(`| A @0.75 (rep1) | ${r.A.rows.find((x) => x.threshold === 0.75).failOpenRate} | ${d(r.A.rows.find((x) => x.threshold === 0.75).dist)} |`);
  md.push(`| B1 recheck (r1,r2→r3) | ${r.B1.failOpenRate} (recheck ${(r.B1.rechecked / Math.max(1, r.B1.n) * 100).toFixed(0)}%) | ${d(r.B1.dist)} |`);
  md.push(`| B2 k=3 vote | ${r.B2.failOpenRate} | ${d(r.B2.dist)} |`);
  md.push(`\nA threshold sweep (${o.schema}): ` + r.A.rows.map((x) => `${x.threshold}→${(x.failOpenRate * 100).toFixed(0)}%`).join(", "));
  md.push(`\nCorpus gate × threshold (${o.schema}): ` + o.corpusSweep.map((x) => `${x.threshold}→${x.failedCount === 0 ? "PASS" : x.failedCount + "✗"}`).join(", "));
}
md.push(`\n## v1↔v2 decision flips (${flips.length})`);
for (const f of flips) md.push(`- ${f.id} (${f.stratum}): ${f.v1} → ${f.v2}`);
fs.writeFileSync(path.join(runDir, "schema-gate-report.md"), md.join("\n"));

console.log(md.join("\n"));
console.log(`\nwritten: ${path.join(runDir, "schema-gate-report.md")}`);
console.log(`labeling sheet: ${sheetPath}`);
