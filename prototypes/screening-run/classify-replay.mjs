#!/usr/bin/env node
// PROTOTYPE — throwaway. Issue #71 schema-gate classification replay.
//
// Runs the 50-sample screening set and the 24-entry classification corpus
// through real Jev classification (TypeSafe leg, pinned jev-1.13.0) under two
// schemas:
//   v1 — shipped boolean+confidence template (classification-v1, verbatim)
//   v2 — C′ anchor template: three cumulative graded questions per Capability
//        Signal (level ≥ 1 / ≥ 2 / ≥ 3), rubric-anchored criteria texts
// Output: one JSONL per (schema, rep) under ~/.pi-jev-helm-eval/screening-runs/,
// resumable — records already present for (schema, rep, source, id) are skipped.
//
// Usage:
//   TYPESAFE_API_KEY=... node classify-replay.mjs --schema both --reps 3 --source both
//   TYPESAFE_API_KEY=... node classify-replay.mjs --dry-run          # list calls, spend nothing
//
// Pool stays out of every git worktree (pipeline rule, issue #68): this script
// only READS the pool and WRITES the eval dir; it never writes into the repo.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { CLASSIFICATION_CORPUS } from "../../dist/classification-corpus.js";

const TYPESAFE_MODEL = "jev-1.13.0";
const poolDir = process.env.PI_JEV_EVAL_POOL || path.join(os.homedir(), ".pi-jev-helm-eval");
const outDir = path.join(poolDir, "screening-runs");
const CALL_TIMEOUT_MS = 30_000;
const CONCURRENCY = 3;

// ---------- schemas ----------

const SIGNALS = ["codeWork", "deepReasoning", "externalResearch"];

const V1_TEMPLATE = {
  codeWork: {
    type: "noul",
    instructions:
      "Determine whether completing the user's entire request requires code work. For a compound request, answer yes if any part requires it.",
    criteria: {
      true: "The request requires reading, writing, modifying, debugging, or reviewing source code, tests, configuration, build artifacts, or CI artifacts.",
      false:
        "The request can be completed without working with code-engineering artifacts. A software topic by itself does not count.",
    },
  },
  deepReasoning: {
    type: "noul",
    instructions:
      "Determine whether completing the user's entire request requires deep reasoning. For a compound request, answer yes if any part requires it.",
    criteria: {
      true: "Answer quality depends on multi-step inference, constraint trade-offs, proof, diagnosis, or non-obvious planning.",
      false:
        "The request can be answered directly without those operations. Length, requested detail, or complex wording alone do not count.",
    },
  },
  externalResearch: {
    type: "noul",
    instructions:
      "Determine whether completing the user's entire request requires external research. For a compound request, answer yes if any part requires it.",
    criteria: {
      true:
        "The request requires retrieving or verifying external evidence, documentation, or time-sensitive facts beyond the current request.",
      false:
        "The request can be completed from supplied information, local repository exploration, or stable general knowledge. Local repository exploration does not count as external research.",
    },
  },
};

// C′ graded template: per signal, cumulative questions P(level ≥ k).
// Level semantics (union across the whole request preserved — g1 true if ANY
// part requires the capability, exactly v1's boolean):
//   codeWork        1 any code artifact touch · 2 substantive · 3 heavy/architectural
//   deepReasoning   1 one non-obvious inference · 2 multi-step/diagnosis · 3 proof-grade/novel planning
//   externalResearch 1 any external evidence · 2 load-bearing current-docs verification · 3 multi-source time-sensitive synthesis
const GRADES = [
  {
    key: "g1",
    codeWork: [
      "Completing the request requires reading, writing, modifying, debugging, or reviewing source code, tests, configuration, build, or CI artifacts in at least one place.",
      "The request can be completed without touching any code-engineering artifact. A software topic by itself does not count.",
    ],
    deepReasoning: [
      "Answer quality depends on at least one non-obvious inference step beyond direct recall or lookup.",
      "The request is answerable by direct recall, restatement, or lookup alone.",
    ],
    externalResearch: [
      "Completing the request requires retrieving or verifying at least one piece of external evidence, documentation, or time-sensitive fact beyond the current request.",
      "The request can be completed from supplied information, local repository exploration, or stable general knowledge. Local repository exploration does not count.",
    ],
  },
  {
    key: "g2",
    codeWork: [
      "Code work is a substantive part of the request: multi-file changes, non-trivial debugging or implementation, or code review that shapes the answer.",
      "At most trivial code involvement, such as a one-line lookup or mention; the answer does not depend on working with code.",
    ],
    deepReasoning: [
      "Answer quality depends on multi-step inference: chaining deductions, weighing constraint trade-offs, diagnosing from evidence, or planning under constraints.",
      "At most a single inference step is needed; multi-step chaining, trade-offs, or diagnosis are not required for a quality answer.",
    ],
    externalResearch: [
      "External evidence is load-bearing: without verifying current external documentation, APIs, releases, prices, or facts, the answer would be materially worse or stale.",
      "External lookup would be incidental; the answer's quality does not depend on current external sources.",
    ],
  },
  {
    key: "g3",
    codeWork: [
      "The request centers on demanding code work: architecture, migration, cross-cutting refactor, performance work, or tests/CI as the deliverable.",
      "The code work involved is routine single-purpose editing, not architecturally demanding.",
    ],
    deepReasoning: [
      "Answer quality depends on proof-grade or novel reasoning: verification, satisfying many interacting constraints, or a non-obvious plan that the request does not itself state.",
      "The reasoning needed, while possibly multi-step, follows a known pattern stated or implied by the request.",
    ],
    externalResearch: [
      "The request demands synthesizing multiple independent external sources of time-sensitive evidence and reconciling them.",
      "A single external source at most is needed; no multi-source synthesis of time-sensitive evidence is required.",
    ],
  },
];

function v2Template() {
  const t = {};
  for (const signal of SIGNALS) {
    for (const g of GRADES) {
      t[`${signal}_${g.key}`] = {
        type: "noul",
        instructions: `Grade the user's entire request for ${signal.replace(/([A-Z])/g, " $1").toLowerCase().trim()} at anchor level ${g.key[1]} of 3. Anchor levels are cumulative: level 2 assumes level 1 is also true. Answer the probability that this anchor's true-criterion holds for the ENTIRE request (any part requiring it counts).`,
        criteria: { true: g[signal][0], false: g[signal][1] },
      };
    }
  }
  return t;
}

const SCHEMAS = {
  v1: { template: V1_TEMPLATE, questions: SIGNALS },
  v2: { template: v2Template(), questions: SIGNALS.flatMap((s) => GRADES.map((g) => `${s}_${g.key}`)) },
};

// ---------- inputs ----------

function restorePlaceholders(text) {
  return text.replaceAll("<redacted:home-path>", os.homedir());
}

function loadJobs(sources) {
  const jobs = [];
  if (sources.includes("screening")) {
    const manifest = JSON.parse(fs.readFileSync(path.join(poolDir, "screening-manifest.json"), "utf8"));
    for (const s of manifest.samples) {
      const c = JSON.parse(fs.readFileSync(path.join(poolDir, "pool", `${s.id}.json`), "utf8"));
      jobs.push({ source: "screening", id: s.id, stratum: s.stratum, text: restorePlaceholders(c.text) });
    }
  }
  if (sources.includes("corpus")) {
    for (const e of CLASSIFICATION_CORPUS) {
      jobs.push({ source: "corpus", id: e.id, stratum: e.clarity, text: e.message });
    }
  }
  return jobs;
}

// ---------- client ----------

const apiKey = process.env.TYPESAFE_API_KEY;
if (!apiKey && !process.argv.includes("--dry-run")) {
  console.error("TYPESAFE_API_KEY is required (same credential the TypeSafe Jev Client leg uses).");
  process.exit(1);
}
const client = apiKey
  ? new TypeSafeClient({
      apiKey,
      baseURL: "https://api.typesafe.ai",
      defaultModel: TYPESAFE_MODEL,
      timeout: CALL_TIMEOUT_MS,
      retry: { maxRetries: 0 },
    })
  : null;

async function callOnce(schema, job) {
  const t0 = Date.now();
  const { data, response } = await client
    .systemOne({ state: job.text, questions: SCHEMAS[schema].template, model: TYPESAFE_MODEL }, { timeout: CALL_TIMEOUT_MS })
    .withResponse();
  if (data.model !== TYPESAFE_MODEL) throw new Error(`model identity mismatch: ${data.model}`);
  const probs = {};
  for (const q of SCHEMAS[schema].questions) {
    const a = data.answers?.[q];
    if (!a || a.type !== "noul" || typeof a.noul !== "number") throw new Error(`bad answer for ${q}`);
    probs[q] = a.noul;
  }
  return { probs, usage: data.usage, latencyMs: Date.now() - t0 };
}

async function callWithRetry(schema, job) {
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await callOnce(schema, job);
    } catch (e) {
      lastErr = e;
      const status = e?.status ?? e?.response?.status ?? (e instanceof Error ? undefined : undefined);
      const retryable = status === 429 || status >= 500 || status === undefined;
      if (!retryable) throw e;
      const wait = status === 429 ? 8_000 : 2_000 * (attempt + 1);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

// ---------- runner ----------

function main() {
  const args = process.argv.slice(2);
  const dry = args.includes("--dry-run");
  const schemaArg = args.includes("--schema") ? args[args.indexOf("--schema") + 1] : "both";
  const reps = args.includes("--reps") ? Number(args[args.indexOf("--reps") + 1]) : 3;
  const sourceArg = args.includes("--source") ? args[args.indexOf("--source") + 1] : "both";
  const schemas = schemaArg === "both" ? ["v1", "v2"] : [schemaArg];
  const sources = sourceArg === "both" ? ["corpus", "screening"] : [sourceArg];

  const jobs = loadJobs(sources);
  if (CLASSIFICATION_CORPUS.length !== 24) throw new Error("corpus import sanity failed");

  const tasks = [];
  for (const schema of schemas) {
    for (let rep = 1; rep <= reps; rep += 1) {
      const out = path.join(outDir, `classify-${schema}-rep${rep}.jsonl`);
      const done = new Set(
        fs.existsSync(out)
          ? fs.readFileSync(out, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
              .filter((r) => r.ok)
              .map((r) => r.source + ":" + r.id)
          : [],
      );
      for (const job of jobs) {
        if (done.has(job.source + ":" + job.id)) continue;
        tasks.push({ schema, rep, job, out });
      }
    }
  }

  console.log(
    `plan: ${jobs.length} inputs × ${schemas.length} schema × ${reps} reps` +
      ` — ${tasks.length} calls to make (${jobs.length * schemas.length * reps - tasks.length} already cached)`,
  );
  if (dry) {
    for (const t of tasks.slice(0, 10)) console.log(`  ${t.schema} rep${t.rep}  ${t.job.source}:${t.job.id}  (${t.job.stratum})`);
    if (tasks.length > 10) console.log(`  … and ${tasks.length - 10} more`);
    return Promise.resolve();
  }

  fs.mkdirSync(outDir, { recursive: true });
  const streams = new Map();
  let done = 0;
  let failed = 0;
  const t0 = Date.now();

  async function worker(queue) {
    for (;;) {
      const t = queue.shift();
      if (!t) return;
      const rec = { schema: t.schema, rep: t.rep, source: t.job.source, id: t.job.id, stratum: t.job.stratum, ts: new Date().toISOString() };
      try {
        const r = await callWithRetry(t.schema, t.job);
        Object.assign(rec, { ok: true, probs: r.probs, usage: r.usage, latencyMs: r.latencyMs });
      } catch (e) {
        failed += 1;
        Object.assign(rec, { ok: false, error: String(e?.message ?? e).slice(0, 300) });
      }
      if (!streams.has(t.out)) streams.set(t.out, fs.createWriteStream(t.out, { flags: "a" }));
      streams.get(t.out).write(JSON.stringify(rec) + "\n");
      done += 1;
      if (done % 20 === 0 || done === tasks.length) {
        const rate = done / ((Date.now() - t0) / 1000);
        console.log(`  ${done}/${tasks.length} (${failed} failed) — ${rate.toFixed(1)} calls/s`);
      }
    }
  }

  const queue = [...tasks];
  return Promise.all(Array.from({ length: CONCURRENCY }, () => worker(queue))).then(() => {
    for (const s of streams.values()) s.end();
    console.log(`done: ${done} calls, ${failed} failed, ${((Date.now() - t0) / 1000).toFixed(0)}s → ${outDir}`);
    if (failed > 0) console.log("re-run to retry failed records (failed records are not cached as ok).");
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
