import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Executable contract for the default CI workflow (.github/workflows/ci.yml).
// Default CI is the public evidence that the declared minimum Node.js and the
// current Node.js runtime both pass typecheck, build, and the full default
// test suite — and that none of it touches credentials, the real Jev gate, or
// any paid external request. These checks guard that evidence the same way
// test/package-contract.test.ts guards the Pi package contract.

const CURRENT_NODE_MAJOR = "24";

interface PackageManifest {
  engines: { node?: string | undefined };
}

function loadWorkflow(): string {
  return readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
}

function loadManifest(): PackageManifest {
  return JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as PackageManifest;
}

function minimumNodeVersion(): string {
  const range = loadManifest().engines.node;
  const match = /^>=(\d+\.\d+\.\d+)$/.exec(range ?? "");
  if (!match) throw new Error(`expected engines.node to be ">=x.y.z", received: ${range}`);
  return match[1]!;
}

/** Extract one top-level job's text: from `  <job>:` to the next 2-space key. */
function jobSection(workflow: string, job: string): string {
  const start = workflow.indexOf(`  ${job}:`);
  if (start === -1) throw new Error(`missing job ${job}`);
  const rest = workflow.slice(start + `  ${job}:`.length);
  const next = /\n  \S+:\n/.exec(rest);
  return next === null ? rest : rest.slice(0, next.index);
}

describe("default CI contract", () => {
  it("runs the deterministic suite on the declared minimum and current Node.js", () => {
    const minimum = minimumNodeVersion();
    const deterministic = jobSection(loadWorkflow(), "deterministic");

    // The matrix is the runtime evidence: the exact declared minimum plus the
    // current Node.js major, each running its own complete verification leg.
    expect(deterministic).toContain(`node-version: [${minimum}, ${CURRENT_NODE_MAJOR}]`);

    // A failing leg must not cancel the other runtime's leg before it
    // finishes, so both runtimes always produce complete evidence.
    expect(deterministic).toContain("fail-fast: false");
  });

  it("runs typecheck, build, and the full default test suite on every leg", () => {
    const deterministic = jobSection(loadWorkflow(), "deterministic");
    expect(deterministic).toContain("npm run typecheck");
    expect(deterministic).toContain("npm run build");
    expect(deterministic).toContain("npm test");
    // The default suite is `vitest run`; no alternate config is allowed to
    // sneak in behind it.
    expect(deterministic).not.toContain("vitest.real-jev-gate.config");
    expect(deterministic).not.toContain("vitest.pi-matrix.config");
  });

  it("configures no credentials and never references the OpenRouter key", () => {
    const workflow = loadWorkflow();
    expect(workflow).not.toContain("OPENROUTER_API_KEY");
    // No GitHub secret is read anywhere in the workflow, so the default suite
    // cannot depend on external credentials even accidentally.
    expect(workflow).not.toContain("${{ secrets.");
  });

  it("runs the Pi compatibility matrix on the current Node.js", () => {
    const piCompatibility = jobSection(loadWorkflow(), "pi-compatibility");
    expect(piCompatibility).toContain(`node-version: ${CURRENT_NODE_MAJOR}`);
    expect(piCompatibility).toContain("npm run test:pi-matrix");
  });
});
