#!/usr/bin/env node
// PROTOTYPE — throwaway. Baseline runner for issue #69 (three-arm screening-set
// replay). Runs sanitized pool samples headlessly through Pi in their original
// cwd, recording sessions to an out-of-repo dir for later loss decomposition.
//
// Usage:
//   node run-baseline.mjs --select            # choose pilot batch, write plan
//   node run-baseline.mjs --run [plan.json]   # execute plan arms (helm/strong)
//   node run-baseline.mjs --analyze           # parse run sessions → report
//
// Env: PI_JEV_EVAL_POOL (default ~/.pi-jev-helm-eval)

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { globSync } from 'node:fs'; // node:fs glob where available; fallback below

const poolDir = process.env.PI_JEV_EVAL_POOL || path.join(os.homedir(), '.pi-jev-helm-eval');
const runsDir = path.join(poolDir, 'baseline-runs');
const manifest = JSON.parse(fs.readFileSync(path.join(poolDir, 'screening-manifest.json'), 'utf8'));

// ---------- sample → original cwd ----------
let cwdIndex = null;
function buildCwdIndex() {
  if (cwdIndex) return cwdIndex;
  cwdIndex = new Map(); // sessionFile basename → cwd (first wins)
  const root = path.join(os.homedir(), '.pi/agent/sessions');
  for (const dir of fs.readdirSync(root)) {
    const d = path.join(root, dir);
    if (!fs.statSync(d).isDirectory()) continue;
    for (const f of fs.readdirSync(d)) {
      if (!f.endsWith('.jsonl') || cwdIndex.has(f)) continue;
      try {
        const first = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8').split('\n')[0]);
        if (first.cwd) cwdIndex.set(f, first.cwd);
      } catch { /* skip */ }
    }
  }
  return cwdIndex;
}

function loadSample(id) {
  const c = JSON.parse(fs.readFileSync(path.join(poolDir, 'pool', `${id}.json`), 'utf8'));
  const cwd = buildCwdIndex().get(c.meta.sessionFile) || process.cwd();
  // Replay-time placeholder restoration (local only, never stored):
  const text = c.text.replaceAll('<redacted:home-path>', os.homedir());
  return { id, text, cwd, cluster: c.meta.project, stratum: null, chars: c.meta.chars };
}

// ---------- pilot selection ----------
// Read-only-ish tasks from git-backed clusters only (Downloads excluded: no git
// safety net). Ops verbs excluded (merge/close/publish/delete/create).
const READONLY = /(读|看|分析|解释|回答|为什么|怎么|如何|是什么|比较|判断|explore|analyz|explain|answer|why|what|how|check|review|compare|investigat|understand|find|list|summar)/i;
const OPS = /(merge|关闭|发布|删除| deploy|rm -|git push|创建|install|npm i|上传|提交|关掉|open a PR)/i;

function cmdSelect() {
  const samples = manifest.samples.map((s) => ({ ...loadSample(s.id), stratum: s.stratum, cluster: s.cluster }));
  const eligible = samples.filter((s) =>
    READONLY.test(s.text) && !OPS.test(s.text) &&
    !s.cwd.includes('Downloads') &&
    s.stratum !== 'boundary:drift'); // drift needs trajectory replay, later phase
  // strata spread: main body first, keep boundary layers represented
  const byStratum = new Map();
  for (const s of eligible) {
    const k = s.stratum.startsWith('main') ? 'main' : s.stratum;
    if (!byStratum.has(k)) byStratum.set(k, []);
    byStratum.get(k).push(s);
  }
  const pilot = [];
  const quotas = { main: 8, 'boundary:composite': 2, 'boundary:high-cost': 1, 'boundary:low-conf': 1 };
  for (const [k, n] of Object.entries(quotas)) {
    pilot.push(...(byStratum.get(k) || []).slice(0, n));
  }
  const plan = { version: 1, created: new Date().toISOString(), runs: pilot.map((s) => ({
    id: s.id, stratum: s.stratum, cluster: s.cluster, cwd: s.cwd, chars: s.chars,
  })) };
  fs.writeFileSync(path.join(poolDir, 'baseline-plan.json'), JSON.stringify(plan, null, 2));
  console.log(`pilot: ${pilot.length} tasks → ${path.join(poolDir, 'baseline-plan.json')}`);
  for (const s of pilot) console.log(`  ${s.id}  ${s.stratum}  ${s.cwd.replace(os.homedir(), '~')}`);
}

// ---------- run ----------
const ROUTE_TARGETS = {
  fast: ['deepseek', 'deepseek-flash', 'high'],
  coding: ['openai-codex', 'gpt-5.6-sol', 'high'],
  reasoning: ['openai-codex', 'gpt-6-astra', 'high'],
  research: ['zai-coding-cn', 'glm-5.3-flash', 'high'],
};

function runOne(r, arm) {
  const s = loadSample(r.id);
  const sessDir = path.join(runsDir, arm);
  fs.mkdirSync(sessDir, { recursive: true });
  const args = ['-p', '--mode', 'json', '--session-dir', sessDir,
    '--name', `bl-${arm}-${r.id}`, s.text];
  if (arm === 'strong') args.push('--provider', 'openai-codex', '--model', 'gpt-6-astra', '--thinking', 'high');
  if (arm === 'oracle') {
    const labels = JSON.parse(fs.readFileSync(path.join(runsDir, 'oracle-labels.json'), 'utf8'));
    const t = ROUTE_TARGETS[labels[r.id]?.route];
    if (!t) { return Promise.resolve({ id: r.id, arm, wallMs: 0, exit: 1, error: 'no oracle label' }); }
    args.push('--provider', t[0], '--model', t[1], '--thinking', t[2]);
  }
  const t0 = Date.now();
  return new Promise((resolve) => {
    // stdin MUST be ignored: headless pi waits for stdin EOF when not a TTY.
    const p = spawn('pi', args, { cwd: s.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let so = '', se = '';
    const to = setTimeout(() => p.kill('SIGKILL'), 600_000);
    p.stdout.on('data', (d) => { so += d; });
    p.stderr.on('data', (d) => { se += d; });
    p.on('exit', (code) => {
      clearTimeout(to);
      resolve({ id: r.id, arm, wallMs: Date.now() - t0, exit: code ?? 1,
        timedOut: code === null, stdoutHead: (so || se).slice(0, 400) });
    });
    p.on('error', (e) => { clearTimeout(to); resolve({ id: r.id, arm, wallMs: Date.now() - t0, exit: 1, error: String(e) }); });
  });
}

const HELM_CONFIG = path.join(os.homedir(), '.pi/agent/pi-jev-helm.json');
function setAutomaticRouting(on) {
  const raw = fs.readFileSync(HELM_CONFIG, 'utf8');
  const cfg = JSON.parse(raw);
  if (cfg.automaticRouting === on) return raw;
  cfg.automaticRouting = on;
  fs.writeFileSync(HELM_CONFIG, JSON.stringify(cfg, null, 2) + '\n');
  return raw; // caller restores this exact string
}

async function cmdRun(planPath, armFilter) {
  const plan = JSON.parse(fs.readFileSync(planPath || path.join(poolDir, 'baseline-plan.json'), 'utf8'));
  const phases = armFilter ? [armFilter] : ['helm', 'strong'];
  const results = [];
  for (const arm of phases) {
    let restore = null;
    if (arm !== 'helm') {
      restore = setAutomaticRouting(false); // non-helm arms must not be re-routed
      console.log(`automaticRouting → OFF for ${arm} arm`);
    }
    const jobs = plan.runs.map((r) => ({ r, arm }));
    const CONC = 3;
    let i = 0;
    const worker = async () => {
      while (i < jobs.length) {
        const j = jobs[i++];
        const res = await runOne(j.r, j.arm);
        results.push(res);
        console.log(`[${results.length}] ${res.id} ${j.arm} ${res.wallMs}ms exit=${res.exit}${res.timedOut ? ' TIMEOUT' : ''}`);
      }
    };
    try {
      await Promise.all(Array.from({ length: CONC }, worker));
    } finally {
      if (restore != null) { fs.writeFileSync(HELM_CONFIG, restore); console.log('automaticRouting restored'); }
    }
  }
  const log = path.join(runsDir, 'runs-index.jsonl');
  fs.appendFileSync(log, results.map((r) => JSON.stringify({ ...r, ts: new Date().toISOString() })).join('\n') + '\n');
  console.log(`done: ${results.length} runs → ${log}`);
}

// ---------- analyze ----------
function parseSession(file) {
  const recs = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const routing = recs.filter((r) => r.type === 'custom' && r.customType === 'pi-jev-helm-routing-explanation').map((r) => r.data);
  const users = recs.filter((r) => r.type === 'message' && r.message.role === 'user');
  const assists = recs.filter((r) => r.type === 'message' && r.message.role === 'assistant');
  const usage = assists.reduce((a, r) => {
    const u = r.message.usage || {};
    a.input += u.input || 0; a.output += u.output || 0;
    a.cacheRead += u.cacheRead || 0; a.cacheWrite += u.cacheWrite || 0; a.cacheWrite1h += u.cacheWrite1h || 0;
    a.cost += u.cost?.total || 0; a.turns += 1;
    return a;
  }, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, cost: 0, turns: 0 });
  const firstLatency = users.length && assists.length
    ? new Date(assists[0].timestamp) - new Date(users[0].timestamp) : null;
  const answer = assists.at(-1)?.message?.content?.filter((p) => p.type === 'text').map((p) => p.text).join('')?.slice(0, 300) ?? '';
  return { routing, usage, firstLatency, answer, model: assists[0]?.message?.model };
}

function cmdAnalyze() {
  const idx = fs.readFileSync(path.join(runsDir, 'runs-index.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const out = [];
  for (const run of idx) {
    const sessDir = path.join(runsDir, run.arm);
    // session filenames are timestamp+uuid; match by session_info.name instead
    let file = null;
    for (const f of fs.readdirSync(sessDir).filter((f) => f.endsWith('.jsonl'))) {
      const head = fs.readFileSync(path.join(sessDir, f), 'utf8').split('\n').slice(0, 4);
      for (const line of head) {
        try {
          const r = JSON.parse(line);
          if (r.type === 'session_info' && r.name === `bl-${run.arm}-${run.id}`) { file = f; break; }
        } catch { /* skip */ }
        if (file) break;
      }
      if (file) break;
    }
    if (!file) { out.push({ ...run, missing: true }); continue; }
    const parsed = parseSession(path.join(sessDir, file));
    out.push({ ...run, ...parsed, sessionFile: file });
  }
  const reportPath = path.join(runsDir, 'baseline-results.jsonl');
  fs.writeFileSync(reportPath, out.map((r) => JSON.stringify(r)).join('\n') + '\n');
  // console summary
  for (const arm of ['helm', 'strong', 'oracle']) {
    const rs = out.filter((r) => r.arm === arm && !r.missing);
    if (!rs.length) continue;
    const cost = rs.reduce((a, r) => a + r.usage.cost, 0);
    const lat = rs.filter((r) => r.firstLatency != null).map((r) => r.firstLatency).sort((a, b) => a - b);
    const p95 = lat[Math.floor(lat.length * 0.95)] ?? lat.at(-1);
    const routed = rs.filter((r) => r.routing.some((d) => d.kind === 'routing-attempt' && d.outcome === 'routed')).length;
    const failOpen = rs.filter((r) => r.routing.some((d) => d.kind === 'routing-attempt' && d.outcome === 'fail-open')).length;
    const routes = {};
    for (const r of rs) for (const d of r.routing) if (d.kind === 'routing-attempt' && d.outcome === 'routed') routes[d.route] = (routes[d.route] || 0) + 1;
    console.log(`\n=== arm=${arm} n=${rs.length} ===`);
    console.log(`total cost: $${cost.toFixed(4)} | avg $${(cost / rs.length).toFixed(5)}/run`);
    console.log(`first-response latency ms: p50=${lat[Math.floor(lat.length / 2)]} p95=${p95}`);
    console.log(`wall: avg ${Math.round(rs.reduce((a, r) => a + r.wallMs, 0) / rs.length)}ms`);
    if (arm === 'helm') console.log(`routing: routed=${routed} fail-open=${failOpen} routes=${JSON.stringify(routes)}`);
    console.log(`cache: read=${rs.reduce((a, r) => a + r.usage.cacheRead, 0)} write=${rs.reduce((a, r) => a + r.usage.cacheWrite, 0)} write1h=${rs.reduce((a, r) => a + r.usage.cacheWrite1h, 0)}`);
  }
  console.log(`\n→ ${reportPath}`);
}

const mode = process.argv[2];
if (mode === '--select') cmdSelect();
else if (mode === '--run') cmdRun(process.argv[3], process.argv[4]);
else if (mode === '--analyze') cmdAnalyze();
else console.log('modes: --select | --run [plan] [arm] | --analyze');
