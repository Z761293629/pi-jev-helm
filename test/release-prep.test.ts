import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Executable contract for the v0.2.0 release preparation. The source a
// `v0.2.0` tag will name must consistently identify itself as 0.2.0
// everywhere a user or the Release Gate looks: package metadata and its
// lockfile, the dated changelog entry, the README's install / temporary-run
// / upgrade guidance, and the security support table. Historical `v0.1.x`
// references survive only where history requires them (changelog history,
// ADRs, migration phrasing such as "pre-0.2.0 configurations") — never as a
// claim about the current release. The next release-preparation ticket moves
// these constants forward; a stale constant is a found defect, not a waived
// check.

const RELEASE = "0.2.0";
const TAG = `v${RELEASE}`;
const LINE = "0.2.x";
const PREVIOUS_RELEASE = "0.1.0";
const PREVIOUS_TAG = `v${PREVIOUS_RELEASE}`;
const PREVIOUS_LINE = "0.1.x";
const NEXT_PATCH_TAG = "v0.2.1";
const NEXT_MINOR = "0.3.0";
const REPO = "Z761293629/pi-jev-helm";

function readText(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function readJson(path: string): unknown {
  return JSON.parse(readText(path));
}

/** Escape a literal version string for embedding in a RegExp. */
function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function runTagValidator(tag: string): number {
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  // The script prefers GITHUB_REF_NAME over argv — the Release Gate relies
  // on that precedence to validate the pushed ref — so the test pins the
  // environment explicitly instead of depending on the ambient (on CI:
  // branch-named) GITHUB_REF_NAME.
  // A null status means the child died on a signal: treat it as the failure
  // it is, never as a passing exit code.
  return spawnSync(process.execPath, ["scripts/validate-release-tag.mjs", tag], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, GITHUB_REF_NAME: tag },
  }).status ?? 1;
}

describe("package metadata and lockfile", () => {
  it("declare the release version in agreement", () => {
    const manifest = readJson("package.json") as { version?: string };
    const lockfile = readJson("package-lock.json") as {
      version?: string;
      packages?: Record<string, { version?: string } | undefined>;
    };
    expect(manifest.version).toBe(RELEASE);
    expect(lockfile.version).toBe(RELEASE);
    expect(lockfile.packages?.[""]?.version).toBe(RELEASE);
  });

  it("passes strict release-tag validation for the release tag", () => {
    expect(runTagValidator(TAG)).toBe(0);
  });

  it("still rejects a tag that is not v<package-version>", () => {
    // The validator must keep failing a tag the manifest does not declare —
    // including the previous release tag, which is no longer the manifest
    // version.
    expect(runTagValidator(PREVIOUS_TAG)).toBe(1);
  });
});

describe("changelog", () => {
  const changelog = readText("CHANGELOG.md");

  it("dates the release entry instead of leaving it unreleased", () => {
    expect(changelog).toMatch(
      new RegExp(`^## \\[${escaped(RELEASE)}\\] — Public Preview \\(\\d{4}-\\d{2}-\\d{2}\\)$`, "m"),
    );
    expect(changelog).not.toMatch(
      new RegExp(`^## \\[${escaped(RELEASE)}\\][^(]*\\(unreleased\\)$`, "m"),
    );
  });

  it("keeps Unreleased ready for subsequent work", () => {
    const unreleased = changelog.slice(
      changelog.indexOf("## [Unreleased]"),
      changelog.indexOf(`## [${RELEASE}]`),
    );
    expect(unreleased).toContain("Nothing yet.");
  });

  it("links the comparison ranges correctly", () => {
    expect(changelog).toContain(
      `[Unreleased]: https://github.com/${REPO}/compare/${TAG}...HEAD`,
    );
    expect(changelog).toContain(
      `[${RELEASE}]: https://github.com/${REPO}/compare/${PREVIOUS_TAG}...${TAG}`,
    );
    expect(changelog).toContain(
      `[${PREVIOUS_RELEASE}]: https://github.com/${REPO}/releases/tag/${PREVIOUS_TAG}`,
    );
  });

  it("presents the release line as the current minor line", () => {
    expect(changelog).toContain(`currently \`${LINE}\``);
    // The breaking-change example must name a *future* minor version, not
    // the line being released.
    expect(changelog).toContain(`(for example \`${NEXT_MINOR}\`)`);
    expect(changelog).not.toContain(`(for example \`${RELEASE}\`)`);
  });
});

describe("README", () => {
  const readme = readText("README.md");

  it("recommends installing the release tag", () => {
    expect(readme).toContain(`### Recommended: pinned \`${TAG}\`, user-level`);
    expect(readme).toContain(`pi install git:github.com/${REPO}@${TAG}`);
    expect(readme).toContain(`pi -e git:github.com/${REPO}@${TAG}`);
  });

  it("presents the release as the current Public Preview", () => {
    expect(readme).toContain(
      `\`${TAG}\` is an externally installable but pre-stable release`,
    );
    expect(readme).not.toContain("the changelog's prepared");
  });

  it("keeps the main tester path outside the current compatibility contract", () => {
    const flattened = readme.replace(/\s+/g, " ");
    expect(flattened).toContain(`covered by the \`${LINE}\` compatibility contract`);
    expect(flattened).not.toContain(`covered by the \`${PREVIOUS_LINE}\` compatibility contract`);
  });

  it("upgrades from the current tag to a future patch tag", () => {
    expect(readme).toContain(`**Pinned tag** (\`…@${TAG}\`)`);
    expect(readme).toContain(`pi install git:github.com/${REPO}@${NEXT_PATCH_TAG}`);
  });

  it("carries no stale current-version claims", () => {
    // After this release the README has no reason to reference the previous
    // release line at all; the changelog and ADRs carry the history.
    expect(readme).not.toContain(PREVIOUS_LINE);
    expect(readme).not.toContain(PREVIOUS_TAG);
    // The release being prepared must not be described as merely prepared.
    expect(readme).not.toContain(`prepared \`${RELEASE}\``);
  });
});

describe("security policy", () => {
  const security = readText("SECURITY.md");

  it("identifies the current release line as supported", () => {
    expect(security).toContain(`| Current \`v${LINE}\` tag (Public Preview) | Supported.`);
  });

  it("marks older published versions superseded", () => {
    expect(security).toContain(
      `| Older published tags (the \`v${PREVIOUS_LINE}\` line and superseded \`v${LINE}\` patches) | Superseded. Upgrade to the current patch tag. |`,
    );
    expect(security).not.toContain(`| Current \`v${PREVIOUS_LINE}\``);
  });

  it("states the patch contract of the current line", () => {
    expect(security).toContain(`Within the \`v${LINE}\` preview line`);
    expect(security).not.toContain(`Within the \`v${PREVIOUS_LINE}\` preview line`);
  });
});
