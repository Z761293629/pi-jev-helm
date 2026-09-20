// PROTOTYPE — throwaway. Answers issue #68: does this export/sanitize/review
// boundary produce representative real samples with no leakage? Not production code.
//
// Deterministic redaction pass. Every replacement is tagged so the human review
// sheet can show exactly what was removed. No network, no env reads.

const RULES = [
  {
    tag: 'api-key',
    // OpenAI sk-…, OpenRouter or-…, TypeSafe ts-…, generic key-ish prefixes
    re: /\b(?:sk|or|ts|rk|pk|ghp|gho|github_pat|xoxb|xoxp|AIza)[A-Za-z0-9_\-]{16,}\b/g,
  },
  {
    tag: 'bearer',
    re: /\bBearer\s+[A-Za-z0-9._\-]{16,}/gi,
  },
  {
    tag: 'url-cred',
    re: /\bhttps?:\/\/[^\s/@]+:[^\s/@]+@[^\s]+/g,
  },
  {
    tag: 'email',
    re: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g,
  },
  {
    tag: 'phone',
    // CN mobile 1[3-9]xxxxxxxxx, or international with mandatory leading +
    re: /(?<![\d+])(?:1[3-9]\d{9}|\+\d{1,3}[\s.\-]?(?:\(\d{1,4}\)|\d{1,4})[\s.\-]?\d{3,4}[\s.\-]?\d{3,4})(?![\d])/g,
  },
  {
    tag: 'home-path',
    re: /(?:\/Users\/[A-Za-z0-9._\-]+|\/home\/[A-Za-z0-9._\-]+|~(?=\/))/g,
  },
  {
    tag: 'ip',
    re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
  },
  {
    tag: 'hex-blob',
    // long hex or base64 runs that look like secrets/hashes
    re: /\b(?:[A-Fa-f0-9]{32,}|[A-Za-z0-9+/]{40,}={0,2})\b/g,
  },
];

// Heuristics that do NOT auto-redact but flag a line for human eyes.
const RESIDUAL = [
  { flag: 'url', re: /\bhttps?:\/\/[^\s]{8,}/g },
  { flag: 'mention', re: /(?:^|\s)@[A-Za-z0-9_]{3,}/g },
  { flag: 'secret-word', re: /\b(?:password|passwd|secret|token|apikey|api_key|credential)s?\b/gi },
  { flag: 'mac-addr', re: /\b(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}\b/g },
];

export function sanitize(text) {
  let out = text;
  const redactions = [];
  for (const { tag, re } of RULES) {
    const r = new RegExp(re.source, re.flags);
    let count = 0;
    out = out.replace(r, () => { count++; return `<redacted:${tag}>`; });
    if (count) redactions.push({ tag, count });
  }
  const residual = [];
  for (const { flag, re } of RESIDUAL) {
    const r = new RegExp(re.source, re.flags);
    if (r.test(out)) residual.push(flag);
  }
  return { text: out, redactions, residual };
}

// Coarse path label: keep the leaf dir name, redact the rest of the path.
export function projectLabel(cwd) {
  if (!cwd) return 'unknown';
  const s = sanitize(cwd).text; // applies home-path redaction
  const leaf = s.split('/').filter(Boolean).pop() || 'unknown';
  return leaf;
}
