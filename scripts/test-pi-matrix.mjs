#!/usr/bin/env node
// Executable Pi compatibility matrix for Pi Jev Helm.
//
// Certifies the public-API black-box suite (test/pi-black-box.test.ts) against:
//   - the minimum supported Pi version (MINIMUM_PI_VERSION), and
//   - the newest stable Pi version published to npm (dist-tag `latest`,
//     discovered at run time rather than assumed).
//
// For every distinct target version the script installs that version into an
// isolated directory, temporarily points the repository's @earendil-works
// installations at it (symlinks, always restored), and runs the black-box
// suite so the extension, the Pi SDK, and the fake providers all resolve to
// the version under certification. No Pi internals are involved anywhere.
//
// Usage:
//   npm run test:pi-matrix
//   PI_MATRIX_SKIP_INSTALL=1 npm run test:pi-matrix   # reuse cached installs
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const MINIMUM_PI_VERSION = "0.85.1";
const REPO_ROOT = resolve(new URL("..", import.meta.url).pathname);
const MATRIX_DIR = join(REPO_ROOT, ".pi-matrix");
const MAIN_PACKAGE = "@earendil-works/pi-coding-agent";
const SWAPPED_PACKAGES = ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai"];
const BACKUP_SUFFIX = ".pi-matrix-backup";

function npmView(args) {
  return execFileSync("npm", ["view", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
}

function installedVersion(matrixDir, packageName = MAIN_PACKAGE) {
  return JSON.parse(
    readFileSync(join(matrixDir, "node_modules", packageName, "package.json"), "utf8"),
  ).version;
}

function lstatSafe(path) {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

function ensureInstall(matrixDir, version) {
  const installedMarker = join(matrixDir, "node_modules", MAIN_PACKAGE);
  if (existsSync(installedMarker)) {
    if (installedVersion(matrixDir) === version) return;
    rmSync(matrixDir, { recursive: true, force: true });
  }
  mkdirSync(matrixDir, { recursive: true });
  const manifestPath = join(matrixDir, "package.json");
  if (!existsSync(manifestPath)) {
    writeFileSync(
      manifestPath,
      `${JSON.stringify({ name: "pi-jev-helm-pi-matrix", private: true, version: "0.0.0" }, null, 2)}\n`,
    );
  }
  console.log(`[pi-matrix] installing Pi ${version}...`);
  execFileSync(
    "npm",
    [
      "install",
      "--prefix",
      matrixDir,
      "--no-audit",
      "--no-fund",
      "--loglevel=error",
      `${MAIN_PACKAGE}@${version}`,
      `@earendil-works/pi-ai@${version}`,
    ],
    { stdio: "inherit" },
  );
  for (const packageName of SWAPPED_PACKAGES) {
    const actual = installedVersion(matrixDir, packageName);
    if (actual !== version) {
      throw new Error(`${packageName} resolved to ${actual}, expected ${version}`);
    }
  }
}

/**
 * Point node_modules/<package> at the matrix installation. Returns a restore
 * function that unconditionally puts the original state back. It is also
 * registered globally so the end-of-run cleanup reuses the same logic.
 */
let armedRestore;
function swapIn(matrixDir) {
  const swaps = [];
  for (const packageName of SWAPPED_PACKAGES) {
    const target = join(REPO_ROOT, "node_modules", packageName);
    const backup = target + BACKUP_SUFFIX;
    const prior = lstatSafe(target);
    if (prior?.isSymbolicLink()) {
      // Stale symlink from an interrupted run: just replace it.
      rmSync(target);
    } else if (prior) {
      renameSync(target, backup);
    }
    mkdirSync(join(target, ".."), { recursive: true });
    symlinkSync(relative(join(target, ".."), join(matrixDir, "node_modules", packageName)), target, "dir");
    swaps.push({ target, backup, hadPrior: prior !== undefined && !prior.isSymbolicLink() });
  }
  const restore = function restore() {
    for (const { target, backup, hadPrior } of swaps.reverse()) {
      // recursive rmSync handles both real directories and symlinks (Node
      // removes the link itself, never following it); a plain unlink of a
      // dir-symlink throws ERR_FS_EISDIR on current Node.
      rmSync(target, { force: true, recursive: true });
      if (hadPrior) renameSync(backup, target);
    }
  };
  armedRestore = restore;
  return restore;
}

function runVitest() {
  try {
    execFileSync("npx", ["vitest", "run", "--config", "vitest.pi-matrix.config.ts"], {
      cwd: REPO_ROOT,
      stdio: "inherit",
    });
    return 0;
  } catch (error) {
    return typeof error.status === "number" ? error.status : 1;
  }
}

async function main() {
  const newest = npmView([MAIN_PACKAGE, "dist-tags.latest"]);
  if (!/^\d+\.\d+\.\d+$/.test(newest)) {
    throw new Error(`could not parse newest stable Pi version from: ${newest}`);
  }
  const versions = [...new Set([MINIMUM_PI_VERSION, newest])];
  console.log(
    `[pi-matrix] minimum ${MINIMUM_PI_VERSION}; newest stable ${newest}; matrix jobs: ${versions.join(", ")}`,
  );

  const results = [];
  try {
    for (const version of versions) {
      const matrixDir = join(MATRIX_DIR, version);
      if (process.env.PI_MATRIX_SKIP_INSTALL === "1") {
        if (!existsSync(join(matrixDir, "node_modules", MAIN_PACKAGE))) {
          throw new Error(`PI_MATRIX_SKIP_INSTALL=1 but ${matrixDir} has no installation`);
        }
      } else {
        ensureInstall(matrixDir, version);
      }
      console.log(`\n[pi-matrix] black-box suite against Pi ${version}`);
      const restore = swapIn(matrixDir);
      try {
        const exitCode = runVitest();
        results.push({ version, exitCode });
      } finally {
        restore();
        armedRestore = undefined;
      }
    }
  } finally {
    // Last-resort cleanup when a run threw mid-swap; reuses the same restore.
    armedRestore?.();
  }

  console.log("\nPi compatibility matrix");
  console.log("=======================");
  for (const { version, exitCode } of results) {
    console.log(`  Pi ${version}: ${exitCode === 0 ? "PASS" : "FAIL"}`);
  }
  const failed = results.some((result) => result.exitCode !== 0);
  if (failed) {
    console.error("\n[pi-matrix] compatibility matrix FAILED");
    process.exit(1);
  }
  console.log(
    `[pi-matrix] certified: black-box lifecycle suite passes on Pi ${results
      .map((result) => result.version)
      .join(" and ")}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
