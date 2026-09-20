import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Executable contract for the Release Gate workflow
// (.github/workflows/release.yml) and its scripts. The release gate is
// the automation that stands between a maintainer's `v*` tag push and the
// public GitHub Pre-release, so this file guards its non-negotiable
// properties the same way test/ci-contract.test.ts guards default CI:
// tag-only triggering, tag-equals-version validation before any release
// work, complete verification, credential isolation, least-privilege
// permissions, a real Pi install smoke test, and a Pre-release with
// automatic notes as the only outcome of success.

const VERIFICATION_JOBS = [
  "deterministic",
  "pi-compatibility",
  "real-jev-gate",
  "install-smoke-test",
] as const;

interface PackageManifest {
  engines: { node?: string | undefined };
}

function loadWorkflow(): string {
  return readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
}

function loadScript(name: string): string {
  return readFileSync(new URL(`../scripts/${name}`, import.meta.url), "utf8");
}

function loadManifest(): PackageManifest {
  return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as PackageManifest;
}

function minimumNodeVersion(): string {
  const range = loadManifest().engines.node;
  const match = /^>=(\d+\.\d+\.\d+)$/.exec(range ?? "");
  if (!match) throw new Error(`expected engines.node to be ">=x.y.z", received: ${range}`);
  return match[1]!;
}

/** Text from a top-level `key:` line to the next top-level key. */
function topLevelBlock(text: string, key: string): string {
  const lines = text.split("\n");
  const start = lines.indexOf(`${key}:`);
  if (start === -1) throw new Error(`missing top-level ${key}`);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\S/.test(lines[index]!)) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

/** Extract one job's text: from `  <job>:` to the next 2-space key. */
function jobSection(workflow: string, job: string): string {
  const start = workflow.indexOf(`  ${job}:`);
  if (start === -1) throw new Error(`missing job ${job}`);
  const rest = workflow.slice(start + `  ${job}:`.length);
  const next = /\n  \S+:\n/.exec(rest);
  return next === null ? rest : rest.slice(0, next.index);
}

describe("release gate trigger", () => {
  it("runs only for v* tag pushes", () => {
    const onBlock = topLevelBlock(loadWorkflow(), "on");
    expect(onBlock).toContain("push:");
    expect(onBlock).toMatch(/tags:\n\s+- "v\*"/);
    // No other trigger may start the release workflow: releases are created
    // exclusively by pushing a version tag.
    expect(onBlock).not.toContain("pull_request");
    expect(onBlock).not.toContain("branches:");
    expect(onBlock).not.toContain("workflow_dispatch");
    expect(onBlock).not.toContain("schedule");
    expect(onBlock).not.toContain("release");
  });
});

describe("tag validation before any release work", () => {
  it("validates the tag against the package version first", () => {
    const validate = jobSection(loadWorkflow(), "validate-tag");
    expect(validate).toContain("node scripts/validate-release-tag.mjs");
    // Nothing runs before the validation job: every other job declares it
    // as its sole prerequisite.
    for (const job of VERIFICATION_JOBS) {
      expect(jobSection(loadWorkflow(), job)).toContain("needs: validate-tag");
    }
  });

  it("fails unless the tag is exactly v<package-version>", () => {
    const validator = loadScript("validate-release-tag.mjs");
    expect(validator).toContain("v${version}");
    expect(validator).toContain("process.exit(1)");
    // Strict semver: the validator rejects tags that are not "v" plus a
    // strict semantic version before comparing against the manifest.
    expect(validator).toContain("SEMVER");
    expect(validator).toContain("JSON.parse");
  });
});

describe("release gate verification", () => {
  it("runs the full deterministic suite on both declared Node.js runtimes", () => {
    const minimum = minimumNodeVersion();
    const deterministic = jobSection(loadWorkflow(), "deterministic");
    expect(deterministic).toContain(`node-version: [${minimum}, 24]`);
    expect(deterministic).toContain("fail-fast: false");
    expect(deterministic).toContain("npm run typecheck");
    expect(deterministic).toContain("npm run build");
    expect(deterministic).toContain("npm test");
  });

  it("runs the Pi minimum/latest public-API compatibility matrix", () => {
    const piCompatibility = jobSection(loadWorkflow(), "pi-compatibility");
    expect(piCompatibility).toContain("node-version: 24");
    expect(piCompatibility).toContain("npm run test:pi-matrix");
  });

  it("runs the credentialed real Jev gate and fails explicitly without either key", () => {
    const realJev = jobSection(loadWorkflow(), "real-jev-gate");
    expect(realJev).toContain("npm run test:real-jev-gate");
    // The Release Gate certifies both Jev Client legs, so it requires both
    // credentials. A missing or blank credential must fail the gate, never
    // skip its leg.
    expect(realJev).toContain("OPENROUTER_API_KEY");
    expect(realJev).toContain("TYPESAFE_API_KEY");
    expect(realJev).toContain("node scripts/require-release-credentials.mjs");
    // The guard names both secrets and fails loudly.
    const guard = loadScript("require-release-credentials.mjs");
    expect(guard).toContain('"OPENROUTER_API_KEY"');
    expect(guard).toContain('"TYPESAFE_API_KEY"');
    expect(guard).toContain("::error::");
    expect(guard).toContain("process.exit(1)");
  });

  it("checks both credentials before dependency installation and the paid gate", () => {
    const realJev = jobSection(loadWorkflow(), "real-jev-gate");
    const npmCiIndex = realJev.indexOf("- run: npm ci");
    expect(npmCiIndex).toBeGreaterThan(-1);
    // The guard step sits ahead of `npm ci`, so a missing or blank secret
    // fails the release before dependencies are installed and before the
    // paid gate itself is attempted.
    const guardIndex = realJev.indexOf("node scripts/require-release-credentials.mjs");
    expect(guardIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeLessThan(npmCiIndex);
  });

  it("treats a credential as blank exactly when the gate's own resolution would", () => {
    // Same rule as src/real-jev-gate.ts: unset, empty, or whitespace only.
    // A guard looser than the gate could pass here and then skip a leg
    // anyway; a guard stricter could fail a release the gate would certify.
    const guard = loadScript("require-release-credentials.mjs");
    expect(guard).toContain("trim().length === 0");
  });
});

describe("real Jev gate credential isolation", () => {
  it("injects both credentials only into the real Jev gate job", () => {
    const workflow = loadWorkflow();
    const secretReferences = workflow.match(/secrets\.\w+/g) ?? [];
    expect(secretReferences.length).toBeGreaterThan(0);
    // Every secret read in the workflow is one of the two Jev Client keys,
    // and every read happens inside the real Jev gate job.
    expect(new Set(secretReferences)).toEqual(
      new Set(["secrets.OPENROUTER_API_KEY", "secrets.TYPESAFE_API_KEY"]),
    );
    const realJev = jobSection(workflow, "real-jev-gate");
    for (const reference of secretReferences) {
      expect(realJev).toContain(reference);
    }
  });

  it("never caches, archives, or echoes either credential", () => {
    const workflow = loadWorkflow();
    // No caching or artifact upload anywhere in the release workflow, so
    // nothing a step produces can outlive the run with a credential in it.
    expect(workflow).not.toContain("actions/cache");
    expect(workflow).not.toContain("actions/upload-artifact");
    expect(workflow).not.toContain("continue-on-error");
    // The real Jev gate job itself uses no npm cache either.
    const realJev = jobSection(workflow, "real-jev-gate");
    expect(realJev).not.toContain("cache: npm");
    // Each key name appears in the job only in its env mapping (the mapping
    // name plus the secret reference), never as command output or shell
    // expansion.
    expect(realJev.match(/OPENROUTER_API_KEY/g)).toEqual(["OPENROUTER_API_KEY", "OPENROUTER_API_KEY"]);
    expect(realJev.match(/TYPESAFE_API_KEY/g)).toEqual(["TYPESAFE_API_KEY", "TYPESAFE_API_KEY"]);
    expect(realJev).not.toContain("printenv");
    // The guard reads each credential exactly once, to test presence; the
    // value never reaches any output or storage call.
    const guard = loadScript("require-release-credentials.mjs");
    expect(guard.match(/process\.env/g)).toEqual(["process.env"]);
    expect(guard).not.toContain("console.log");
    expect(guard).not.toContain("writeFile");
  });
});

describe("tag install smoke test", () => {
  it("installs the pushed tag through Pi in a temporary HOME", () => {
    const smoke = jobSection(loadWorkflow(), "install-smoke-test");
    expect(smoke).toContain("npm install -g --ignore-scripts @earendil-works/pi-coding-agent");
    expect(smoke).toContain("node scripts/verify-tag-install.mjs");
    expect(smoke).toContain("--repo");
    expect(smoke).toContain("--tag");
  });

  it("verifies registration, listing, and extension discovery, not just a clone", () => {
    const script = loadScript("verify-tag-install.mjs");
    // The installed source is the tag-pinned GitHub Git package source.
    expect(script).toContain("git:github.com/${repo}@${tag}");
    // A temporary HOME isolates the install from the invoking user's state.
    expect(script).toContain("mkdtemp");
    expect(script).toContain("HOME: home");
    // Settings registration of the exact source.
    expect(script).toContain("settings.json");
    expect(script).toContain(".includes(expectedSource)");
    // Package listing as Pi reports it.
    expect(script).toContain('"list"');
    // Extension resource discovery through the package manifest, via the
    // extension's own registered command.
    expect(script).toContain("get_commands");
    expect(script).toContain('"helm"');
    expect(script).toContain('origin !== "package"');
    expect(script).toContain("sourceInfo");
    // The clone behind the extension is exactly the released version.
    expect(script).toContain("`v${cloneVersion}`");
  });
});

describe("least-privilege permissions", () => {
  it("defaults the whole workflow to read-only repository access", () => {
    const permissionsBlock = topLevelBlock(loadWorkflow(), "permissions");
    expect(permissionsBlock).toContain("contents: read");
    expect(permissionsBlock).not.toContain("write");
  });

  it("keeps every verification job read-only", () => {
    for (const job of VERIFICATION_JOBS) {
      const section = jobSection(loadWorkflow(), job);
      expect(section).toContain("contents: read");
      expect(section).not.toContain("contents: write");
    }
  });

  it("grants contents write only to the final release job", () => {
    const workflow = loadWorkflow();
    const release = jobSection(workflow, "release");
    expect(release).toContain("contents: write");
    // No other job and no other permission scope ever gains write access.
    const writeScopes = workflow.match(/^\s+\w+:\s*write$/gm) ?? [];
    expect(writeScopes.map((scope) => scope.trim())).toEqual(["contents: write"]);
  });
});

describe("release creation", () => {
  it("creates the Pre-release only after every gate succeeded", () => {
    const workflow = loadWorkflow();
    const release = jobSection(workflow, "release");
    expect(release).toContain(
      "needs: [validate-tag, deterministic, pi-compatibility, real-jev-gate, install-smoke-test]",
    );
    // No conditional execution anywhere: a `if:` on the release job (for
    // example `always()`) or on a gate would open a path around the gates.
    expect(release).not.toMatch(/^\s+if:/m);
    for (const job of VERIFICATION_JOBS) {
      expect(jobSection(workflow, job)).not.toMatch(/^\s+if:/m);
    }
  });

  it("creates a Pre-release with automatic notes on the existing tag", () => {
    const release = jobSection(loadWorkflow(), "release");
    expect(release).toContain("gh release create");
    // The tag already exists (its push triggered this workflow).
    expect(release).toContain("--verify-tag");
    expect(release).toContain("--prerelease");
    expect(release).toContain("--generate-notes");
    // No draft staging, no retargeting away from the pushed tag.
    expect(release).not.toContain("--draft");
    expect(release).not.toContain("--target");
  });

  it("ships no redundant release artifacts", () => {
    const workflow = loadWorkflow();
    expect(workflow).not.toContain("npm publish");
    expect(workflow).not.toContain("gh release upload");
    expect(workflow).not.toContain("actions/upload-artifact");
    expect(workflow).not.toContain("actions/attest-build-provenance");
    expect(workflow).not.toContain("goreleaser");
  });
});
