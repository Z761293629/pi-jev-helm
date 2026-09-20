import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const MAIN_PACKAGE = "@earendil-works/pi-coding-agent";
const AI_PACKAGE = "@earendil-works/pi-ai";

interface PackageManifest {
  name: string;
  version: string;
  private: boolean;
  keywords: string[];
  peerDependencies: Record<string, string | undefined>;
  devDependencies: Record<string, string | undefined>;
}

function loadManifest(): PackageManifest {
  return JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as PackageManifest;
}

describe("Pi Git package contract", () => {
  it("keeps the package npm-private and discoverable as a Pi package", () => {
    const pkg = loadManifest();
    expect(pkg.private).toBe(true);
    expect(pkg.keywords).toContain("pi-package");
  });

  it("declares the Pi core package as a wildcard peer dependency", () => {
    const pkg = loadManifest();
    // Pi package guidance: packages importing a Pi-bundled core list it in
    // peerDependencies with a "*" range so an installed Git package uses the
    // Pi installation supplied by its host instead of resolving its own copy.
    expect(pkg.peerDependencies[MAIN_PACKAGE]).toBe("*");
  });

  it("pins the minimum certified Pi version as an exact dev dependency", () => {
    const pkg = loadManifest();
    // The exact pin is the single minimum-version source for the executable
    // compatibility matrix; a range here would blur the certification baseline.
    const pin = pkg.devDependencies[MAIN_PACKAGE];
    expect(pin).toMatch(/^\d+\.\d+\.\d+$/);
    expect(Number.parseInt(pin!.split(".")[0]!, 10)).toBeGreaterThanOrEqual(0);
  });

  it("pins matching Pi host and AI development packages", () => {
    const pkg = loadManifest();
    expect(pkg.devDependencies[AI_PACKAGE]).toBe(pkg.devDependencies[MAIN_PACKAGE]);
  });

  it("derives the matrix minimum from the dev dependency pin, not the peer range", () => {
    // Guards the derivation source the same way the default-suite checks guard
    // the test commands: the matrix must never fall back to the wildcard peer.
    const script = readFileSync(
      new URL("../scripts/test-pi-matrix.mjs", import.meta.url),
      "utf8",
    );
    expect(script).toContain(".devDependencies?.[MAIN_PACKAGE]");
    expect(script).not.toContain("peerDependencies");
  });

  it("runs complete verification for every Pi matrix target", () => {
    const script = readFileSync(
      new URL("../scripts/test-pi-matrix.mjs", import.meta.url),
      "utf8",
    );
    expect(script).toContain('["run", "typecheck"]');
    expect(script).toContain('["run", "build"]');
    expect(script).toContain('["test"]');
    expect(script).toContain("assertCompleteInstall(matrixDir, version)");
    expect(script).toContain("SWAPPED_PACKAGES");
    expect(script).not.toContain("vitest.pi-matrix.config");
  });
});
