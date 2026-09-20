#!/usr/bin/env node
// PROTOTYPE — throwaway. Answers issue #68 (local voluntary export + sanitize
// + review + preserve pipeline for real request samples). Not production code.
//
// Offline-only: imports node builtins only. Never reads auth.json / credentials.
// Output pool must live OUTSIDE any git work tree — the repo never holds data.
//
// Usage:
//   node export-samples.mjs --list <sessionDir>            # local metadata only
//   node export-samples.mjs --export <file.jsonl> [...]    # extract+sanitize+queue review
//   node export-samples.mjs --confirm <id>                 # human approved sample
//   node export-samples.mjs --reject <id>                  # human rejected sample
//   node export-samples.mjs --stats                        # aggregate counts (shareable)
//
// Env override for pool: PI_JEV_EVAL_POOL=/path (default ~/.pi-jev-helm-eval)

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { sanitize, projectLabel } from './sanitize.mjs';

const args = process.argv.slice(2);
const mode = args[0];
const defaultPool = path.join(os.homedir(), '.pi-jev-helm-eval');
const poolDir = process.env.PI_JEV_EVAL_POOL || defaultPool;

// ---------- guards ----------

function assertOutsideGitWorkTree(dir) {
  let cur = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(cur, '.git'))) {
      console.error(`REFUSING: ${dir} is inside a git work tree (${cur}). Data pool must live outside.`);
      process.exit(1);
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
}

function assertSessionFile(f) {
  const b = path.basename(f);
  if (!b.endsWith('.jsonl')) { console.error(`REFUSING: ${f} is not a .jsonl session file`); process.exit(1); }
  if (/auth|credential|secret|token/i.test(b)) { console.error(`REFUSING: ${b} looks like a credentials file`); process.exit(1); }
}

// ---------- extraction ----------

// A "run-opening" request = first user text message after a routing explanation
// (or the first user message of the session). User messages that follow an
// assistant turn WITHOUT an intervening routing explanation are queued
// continuations — exported separately, marked, because Capability Drift eval
// may want them later.
function extractRuns(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const records = [];
  for (const line of lines) {
    try { records.push(JSON.parse(line)); } catch { /* skip torn lines */ }
  }
  const session = records.find((r) => r.type === 'session') || {};
  const out = [];
  let pendingRouting = null;
  let sawUser = false;
  let currentUser = null;
  let usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };

  const push = () => {
    if (!currentUser) return;
    out.push({ ...currentUser, usage: { ...usage } });
    currentUser = null;
  };

  for (const r of records) {
    if (r.type === 'custom' && r.customType === 'pi-jev-helm-routing-explanation') {
      const d = r.data || {};
      if (d.kind === 'routing-attempt') pendingRouting = d;
    }
    if (r.type === 'message') {
      const m = r.message || {};
      const role = m.role;
      if (role === 'user') {
        const texts = (m.content || []).filter((p) => p.type === 'text').map((p) => p.text);
        if (!texts.length) continue;
        push(); // close previous run's usage accumulation
        usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
        const opener = !sawUser || pendingRouting != null;
        currentUser = {
          sessionFile: path.basename(file),
          sessionId: session.id || null,
          cwd: session.cwd || null,
          timestamp: r.timestamp,
          kind: opener ? 'run-opening' : 'continuation',
          routing: opener ? pendingRouting : null,
          rawText: texts.join('\n'),
          hadNonTextParts: (m.content || []).some((p) => p.type !== 'text'),
        };
        sawUser = true;
        pendingRouting = null;
      } else if (role === 'assistant' && currentUser) {
        const u = m.usage || {};
        usage.input += u.input || 0;
        usage.output += u.output || 0;
        usage.cacheRead += u.cacheRead || 0;
        usage.cacheWrite += u.cacheWrite || 0;
        usage.cost += u.cost?.total || 0;
        usage.turns += 1;
      }
    }
  }
  push();
  return out;
}

// ---------- review sheet ----------

// Heuristic: does this request seem to depend on prior conversation context?
const CONTEXT_HINT = /(继续|接着|接下来|再试|还是|上面|前面|之前|刚才|那个文件|同一个|这张图|continue|go on|as before|same as|last time|prior session)/i;

function reviewSheet(candidates) {
  const blocks = candidates.map((c) => {
    const lines = [
      `### ${c.id}  [${c.status}]  ${c.meta.kind}`,
      `- session: ${c.meta.sessionFile}  ts: ${c.meta.timestamp}`,
      `- project: ${c.meta.project}  route: ${c.meta.route ?? 'n/a'}  outcome: ${c.meta.outcome ?? 'n/a'}`,
      `- signals: ${c.meta.signals ?? 'n/a'}`,
      `- run usage: turns=${c.meta.usage.turns} cost=${c.meta.usage.cost.toFixed(4)} in=${c.meta.usage.input} out=${c.meta.usage.output} cacheR=${c.meta.usage.cacheRead} cacheW=${c.meta.usage.cacheWrite}`,
      `- redactions: ${c.redactions.length ? c.redactions.map((x) => `${x.tag}×${x.count}`).join(', ') : 'none'}`,
      `- residual flags: ${c.residual.length ? '⚠ ' + c.residual.join(', ') : 'none'}`,
      c.meta.kind === 'run-opening'
        ? `- self-contained: ${c.meta.contextHint ? '⚠ 开头含上下文指代词，需人判' : 'likely yes (reviewer judges)'}`
        : `- self-contained: N/A (continuation — 重放评测需 capsule)`,
      '',
      '```',
      c.text.length > 1500 ? c.text.slice(0, 1500) + `\n…[truncated ${c.text.length - 1500} chars]` : c.text,
      '```',
      '',
    ];
    return lines.join('\n');
  });
  return `# Review sheet — sanitized candidates\n\nApprove: node export-samples.mjs --confirm <id> · 带背景: --confirm <id> --capsule "一句话任务背景" · Reject: --reject <id>\n\n${blocks.join('\n')}`;
}

// ---------- commands ----------

function cmdList(dir) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  console.log(`${files.length} session files in ${dir} (metadata only, nothing exported):`);
  for (const f of files.slice(0, 50)) {
    const st = fs.statSync(path.join(dir, f));
    console.log(`  ${f}  ${(st.size / 1024).toFixed(0)}KB  ${st.mtime.toISOString().slice(0, 10)}`);
  }
}

function cmdExport(files) {
  assertOutsideGitWorkTree(poolDir);
  fs.mkdirSync(path.join(poolDir, 'pool'), { recursive: true });
  const candidates = [];
  for (const f of files) {
    assertSessionFile(f);
    const runs = extractRuns(f);
    for (const run of runs) {
      const { text, redactions, residual } = sanitize(run.rawText);
      const cjk = (run.rawText.match(/[\u4e00-\u9fff]/g) || []).length / Math.max(run.rawText.length, 1);
      const id = 's-' + crypto.createHash('sha256').update(text).digest('hex').slice(0, 12);
      const c = {
        id,
        status: 'pending',
        meta: {
          sessionFile: run.sessionFile,
          sessionId: run.sessionId,
          timestamp: run.timestamp,
          kind: run.kind,
          project: projectLabel(run.cwd),
          route: run.routing?.route ?? null,
          outcome: run.routing?.outcome ?? null,
          signals: run.routing?.signals
            ? run.routing.signals.map((s) => `${s.name}:${s.value}@${s.confidence}`).join(' ')
            : null,
          chars: run.rawText.length,
          cjkRatio: +cjk.toFixed(2),
          hadNonTextParts: run.hadNonTextParts,
          contextHint: CONTEXT_HINT.test(run.rawText.slice(0, 120)),
          usage: run.usage,
        },
        redactions,
        residual,
        text,
      };
      fs.writeFileSync(path.join(poolDir, 'pool', `${id}.json`), JSON.stringify(c, null, 2));
      candidates.push(c);
    }
  }
  fs.writeFileSync(path.join(poolDir, 'review-pending.md'), reviewSheet(candidates));
  const opening = candidates.filter((c) => c.meta.kind === 'run-opening').length;
  const unique = new Set(candidates.map((c) => c.id)).size;
  if (unique < candidates.length) console.log(`(dedup: ${candidates.length - unique} identical sanitized texts merged)`);
  console.log(`Exported ${candidates.length} candidates (${opening} run-opening, ${candidates.length - opening} continuation) → ${poolDir}`);
  console.log(`Review sheet: ${path.join(poolDir, 'review-pending.md')}`);
  const withRed = candidates.filter((c) => c.redactions.length).length;
  const flagged = candidates.filter((c) => c.residual.length).length;
  console.log(`Redaction applied on ${withRed}; residual flags on ${flagged} (see sheet).`);
}

function loadPool() {
  assertOutsideGitWorkTree(poolDir);
  const dir = path.join(poolDir, 'pool');
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) =>
    JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}

function cmdConfirm(id, capsule) {
  const file = path.join(poolDir, 'pool', `${id}.json`);
  const c = JSON.parse(fs.readFileSync(file, 'utf8'));
  c.status = 'approved';
  if (capsule != null) {
    c.standalone = false;
    c.capsule = sanitize(capsule).text;
  } else {
    c.standalone = true;
  }
  fs.writeFileSync(file, JSON.stringify(c, null, 2));
  console.log(`approved ${id} (standalone=${c.standalone}${c.capsule ? ', capsule added' : ''})`);
}

function cmdReject(id) {
  fs.rmSync(path.join(poolDir, 'pool', `${id}.json`));
  console.log(`rejected (deleted) ${id}`);
}

function cmdStats() {
  const all = loadPool();
  const tally = (fn) => {
    const m = {};
    for (const c of all) { const k = fn(c); m[k] = (m[k] || 0) + 1; }
    return m;
  };
  console.log(`candidates: ${all.length}`);
  console.log('by status:', JSON.stringify(tally((c) => c.status)));
  console.log('by kind:', JSON.stringify(tally((c) => c.meta.kind)));
  console.log('by project:', JSON.stringify(tally((c) => c.meta.project)));
  console.log('by route:', JSON.stringify(tally((c) => c.meta.route ?? 'none')));
  console.log('context-hinted openers:', all.filter((c) => c.meta.contextHint).length);
  console.log('standalone:', all.filter((c) => c.standalone).length, ' with-capsule:', all.filter((c) => c.capsule).length);
  console.log('redacted:', all.filter((c) => c.redactions.length).length, ' flagged:', all.filter((c) => c.residual.length).length);
}

switch (mode) {
  case '--list': cmdList(args[1]); break;
  case '--export': cmdExport(args.slice(1)); break;
  case '--confirm': {
    const i = args.indexOf('--capsule');
    const capsule = i === -1 ? null : args[i + 1];
    cmdConfirm(args[1], capsule);
    break;
  }
  case '--reject': cmdReject(args[1]); break;
  case '--stats': cmdStats(); break;
  default:
    console.log('modes: --list <dir> | --export <file...> | --confirm <id> | --reject <id> | --stats');
}
