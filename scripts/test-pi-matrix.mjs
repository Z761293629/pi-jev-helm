#!/usr/bin/env node
// Executable Pi compatibility matrix for Pi Jev Helm.
//
// Certifies type safety, build output, and the complete deterministic suite against:
//   - the minimum supported Pi version (MINIMUM_PI_VERSION), taken from the
//     exact @earendil-works/pi-coding-agent dev dependency pin — the single
//     source of the matrix minimum (the host-facing peer dependency is a
//     wildcard and encodes no version policy), and
//   - the newest stable Pi version published to npm (dist-tag `latest`,
//     discovered at run time rather than assumed).
//
// The two targets are deduplicated, so every distinct version runs exactly once.
//
// For every distinct target version the script installs that version into an
// isolated directory, temporarily points the repository's @earendil-works
// installations at it (symlinks, always restored), then runs typecheck, build,
// and the full deterministic suite so the extension, the Pi SDK, and the fake
// providers all resolve to the version under certification. No Pi internals
// are involved anywhere.
//
// Usage:
//   npm run test:pi-matrix
//   PI_MATRIX_SKIP_INSTALL=1 npm run test:pi-matrix   # reuse cached installs
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const MATRIX_DIR = join(REPO_ROOT, ".pi-matrix");
const MAIN_PACKAGE = "@earendil-works/pi-coding-agent";
const DEV_PIN = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"))
  .devDependencies?.[MAIN_PACKAGE];
const MINIMUM_PI_VERSION = /^(\d+\.\d+\.\d+)$/.exec(DEV_PIN)?.[1];
if (!MINIMUM_PI_VERSION) {
  throw new Error(`expected ${MAIN_PACKAGE} dev dependency to be an exact version, received: ${DEV_PIN}`);
}
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

function removePath(path) {
  const current = lstatSafe(path);
  if (current?.isSymbolicLink()) {
    unlinkSync(path);
  } else {
    rmSync(path, { force: true, recursive: true });
  }
}

function hasCompleteInstall(matrixDir, version) {
  try {
    return SWAPPED_PACKAGES.every(
      (packageName) => installedVersion(matrixDir, packageName) === version,
    );
  } catch {
    return false;
  }
}

function assertCompleteInstall(matrixDir, version) {
  for (const packageName of SWAPPED_PACKAGES) {
    const packagePath = join(matrixDir, "node_modules", packageName, "package.json");
    if (!existsSync(packagePath)) {
      throw new Error(`matrix installation is missing ${packageName}: ${matrixDir}`);
    }
    const actual = installedVersion(matrixDir, packageName);
    if (actual !== version) {
      throw new Error(`${packageName} resolved to ${actual}, expected ${version}`);
    }
  }
}

function ensureInstall(matrixDir, version) {
  if (existsSync(matrixDir)) {
    if (hasCompleteInstall(matrixDir, version)) return;
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
  assertCompleteInstall(matrixDir, version);
}

/**
 * Recover a package left half-swapped by a forcibly interrupted matrix run.
 * The backup suffix belongs exclusively to this script, so a backup plus a
 * symlink (or missing target) is safe to restore. Any other collision stops
 * rather than risking deletion of an unrelated installation.
 */
function recoverInterruptedSwap(target, backup) {
  if (!existsSync(backup)) return;
  const current = lstatSafe(target);
  if (current?.isSymbolicLink()) {
    removePath(target);
  } else if (current) {
    throw new Error(`cannot recover matrix backup while target also exists: ${target}`);
  }
  renameSync(backup, target);
}

/**
 * Point node_modules/<package> at the matrix installation. The restore
 * function is armed before the first mutation and grows with each swap, so a
 * throw at any point can restore every package already touched.
 */
let armedRestore;
function swapIn(matrixDir) {
  const swaps = [];
  const restore = function restore() {
    for (const swap of [...swaps].reverse()) {
      if (swap.restored) continue;
      const { target, backup, hadPrior } = swap;
      if (hadPrior && !existsSync(backup)) {
        throw new Error(`cannot restore matrix package because its backup is missing: ${backup}`);
      }
      // Remove symlinks with unlink and real directories recursively; this
      // works even when an interrupted run left a dangling directory symlink.
      removePath(target);
      if (hadPrior) renameSync(backup, target);
      swap.restored = true;
    }
  };
  armedRestore = restore;

  for (const packageName of SWAPPED_PACKAGES) {
    const target = join(REPO_ROOT, "node_modules", packageName);
    const backup = target + BACKUP_SUFFIX;
    recoverInterruptedSwap(target, backup);
    const prior = lstatSafe(target);
    const swap = { target, backup, hadPrior: prior !== undefined, restored: false };
    if (prior) renameSync(target, backup);
    swaps.push(swap);
    mkdirSync(join(target, ".."), { recursive: true });
    symlinkSync(relative(join(target, ".."), join(matrixDir, "node_modules", packageName)), target, "dir");
  }
  return restore;
}

const VERIFICATION_STEPS = [
  { name: "typecheck", command: "npm", args: ["run", "typecheck"] },
  { name: "build", command: "npm", args: ["run", "build"] },
  { name: "test", command: "npm", args: ["test"] },
];

function runVerification(version) {
  const steps = [];
  for (const step of VERIFICATION_STEPS) {
    console.log(`\n[pi-matrix] Pi ${version}: ${step.name}`);
    let exitCode = 0;
    try {
      execFileSync(step.command, step.args, {
        cwd: REPO_ROOT,
        stdio: "inherit",
      });
    } catch (error) {
      exitCode = typeof error.status === "number" ? error.status : 1;
    }
    steps.push({ name: step.name, exitCode });
  }
  return steps;
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

  const targets = versions.map((version) => ({
    version,
    matrixDir: join(MATRIX_DIR, version),
  }));
  for (const { version, matrixDir } of targets) {
    if (process.env.PI_MATRIX_SKIP_INSTALL === "1") {
      assertCompleteInstall(matrixDir, version);
    } else {
      ensureInstall(matrixDir, version);
    }
  }

  const results = [];
  try {
    for (const { version, matrixDir } of targets) {
      console.log(`\n[pi-matrix] full verification against Pi ${version}`);
      const restore = swapIn(matrixDir);
      try {
        const steps = runVerification(version);
        results.push({ version, steps });
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
  for (const { version, steps } of results) {
    const summary = steps
      .map(({ name, exitCode }) => `${name}=${exitCode === 0 ? "PASS" : "FAIL"}`)
      .join(", ");
    console.log(`  Pi ${version}: ${summary}`);
  }
  const failed = results.some((result) =>
    result.steps.some((step) => step.exitCode !== 0),
  );
  if (failed) {
    console.error("\n[pi-matrix] compatibility matrix FAILED");
    process.exit(1);
  }
  console.log(
    `[pi-matrix] certified: typecheck, build, and full deterministic suite pass on Pi ${results
      .map((result) => result.version)
      .join(" and ")}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
