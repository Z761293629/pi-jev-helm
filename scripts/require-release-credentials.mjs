// Mandatory-credential guard for the Release Gate's real-jev-gate job
// (.github/workflows/release.yml), which runs it before `npm ci` so that a
// missing or blank credential fails the release before dependency
// installation and before any network request the gate itself performs.
//
// Blank means unset, empty, or whitespace only — the same rule the gate's own
// credential resolution applies (src/real-jev-gate.ts). Every missing secret
// is named; no secret value is ever printed, written, or passed anywhere.
const REQUIRED_CREDENTIALS = ["OPENROUTER_API_KEY", "TYPESAFE_API_KEY"];

const missing = REQUIRED_CREDENTIALS.filter(
  (name) => (process.env[name] ?? "").trim().length === 0,
);

if (missing.length > 0) {
  for (const name of missing) {
    console.error(
      `::error::${name} is missing or blank. The real Jev Gate is a mandatory, unskippable Release Gate that certifies both Jev Client legs: configure the repository Actions Secret named ${name}, then re-run this workflow. No Release was created.`,
    );
  }
  process.exit(1);
}
