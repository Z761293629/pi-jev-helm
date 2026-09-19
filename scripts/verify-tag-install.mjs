#!/usr/bin/env node
// Release Gate install smoke test for Pi Jev Helm.
//
// Simulates a real user-level install of the released tag inside a temporary
// HOME: the installed Pi discovers and loads the extension exactly the way a
// user's Pi would. The probes, in order:
//
//   1. `pi install git:<repo>@<tag>` into the temporary HOME succeeds.
//   2. Settings registration: ~/.pi/agent/settings.json lists the exact
//      tag-pinned package source.
//   3. Package listing: `pi list` reports the exact tag-pinned source.
//   4. Extension resource discovery: `pi --mode rpc` `get_commands` shows the
//      `/helm` command registered by the extension, loaded through the package
//      manifest (origin "package") from the tag-pinned source — not merely a
//      clone on disk.
//   5. Version consistency: the installed clone's package.json version is
//      exactly the released tag minus its "v" prefix.
//
// Any failed probe exits non-zero; every temporary directory is removed.
//
// Usage:
//   node scripts/verify-tag-install.mjs --repo <owner/name> --tag <vX.Y.Z>
//                                        [--source <full-source>] [--keep-temp]
// Environment overrides: RELEASE_REPO, RELEASE_TAG, PI_BIN (path to the pi
// binary; defaults to `pi` on PATH).
//
// --repo is the GitHub `owner/name` slug; the installed source becomes
// `git:github.com/<owner>/<name>@<tag>`. Pass --source to override the whole
// installed source string (used only for local end-to-end testing against a
// private mirror).
import { spawn } from "node:child_process";
import { readFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

const INSTALL_TIMEOUT_MS = 5 * 60_000;
const LIST_TIMEOUT_MS = 60_000;
const PROBE_TIMEOUT_MS = 120_000;
const PROBE_RETRY_MS = 500;

function argumentValue(flag, envName) {
  const index = process.argv.indexOf(flag);
  const value = index !== -1 ? process.argv[index + 1] : process.env[envName];
  if (!value) {
    console.error(`[install-smoke] missing required ${flag} (or ${envName})`);
    process.exit(1);
  }
  return value;
}

function optionalArgumentValue(flag) {
  const index = process.argv.indexOf(flag);
  return index !== -1 ? process.argv[index + 1] : undefined;
}

function run(piBin, args, env, cwd, timeoutMs, label) {
  return new Promise((resolve) => {
    const child = spawn(piBin, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ ok: false, stdout, stderr, timedOut: true });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr: `${stderr}${error.message}`, timedOut: false });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout, stderr, timedOut: false, code });
    });
    if (label) console.log(`[install-smoke] ${label}`);
  });
}

/**
 * Drive one RPC `pi` process until it answers `get_commands`. Requests are
 * retried on an interval because Pi streams no "ready" marker, so the exact
 * moment the RPC channel accepts input is not observable.
 */
function probeCommands(piBin, env, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(piBin, ["--mode", "rpc", "--no-session", "--offline"], {
      env,
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearInterval(retry);
      clearTimeout(timer);
      child.removeAllListeners("close");
      child.on("close", () => resolve(result));
      child.kill("SIGTERM");
    };
    const timer = setTimeout(
      () => finish({ ok: false, error: `no get_commands response within ${timeoutMs}ms`, stdout, stderr }),
      timeoutMs,
    );
    const retry = setInterval(() => {
      child.stdin.write(`${JSON.stringify({ type: "get_commands" })}\n`);
    }, PROBE_RETRY_MS);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      for (const line of stdout.split("\n")) {
        if (!line.trim().startsWith("{")) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === "response" && event.command === "get_commands") {
            finish(event.success === true ? { ok: true, commands: event.data?.commands ?? [] } : { ok: false, error: `get_commands failed: ${line}`, stdout, stderr });
          }
        } catch {
          // Startup and streaming chatter between JSON lines; keep waiting.
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => finish({ ok: false, error: error.message, stdout, stderr }));
    child.on("close", (code) => finish({ ok: false, error: `pi exited early with code ${code}`, stdout, stderr }));
  });
}

function fail(message, detail = "") {
  console.error(`[install-smoke] FAIL: ${message}`);
  if (detail) console.error(detail);
  process.exit(1);
}

async function main() {
  const repo = argumentValue("--repo", "RELEASE_REPO");
  const tag = argumentValue("--tag", "RELEASE_TAG");
  const piBin = process.env.PI_BIN ?? "pi";
  const keepTemp = process.argv.includes("--keep-temp");
  if (!/^v\d/.test(tag)) fail(`tag ${JSON.stringify(tag)} is not a v* version tag`);

  const expectedSource = optionalArgumentValue("--source") ?? `git:github.com/${repo}@${tag}`;
  const home = await mkdtemp(join(tmpdir(), "pi-jev-helm-release-install-"));
  const projectDir = await mkdtemp(join(tmpdir(), "pi-jev-helm-release-project-"));
  // The temporary HOME fully replaces the invoking user's: Pi writes settings,
  // clones, and npm installs under it, so the runner's own agent state is
  // never touched and never leaks into the result.
  const env = { ...process.env, HOME: home, GIT_TERMINAL_PROMPT: "0" };
  delete env.PI_CODING_AGENT_DIR;

  try {
    console.log(`[install-smoke] temporary HOME ${home}`);

    // 1. User-level install of the tag-pinned Git package through Pi.
    const install = await run(piBin, ["install", expectedSource], env, projectDir, INSTALL_TIMEOUT_MS, `pi install ${expectedSource}`);
    if (!install.ok) fail(`pi install ${expectedSource} failed`, `${install.stdout}\n${install.stderr}`);

    // 2. Settings registration: the exact tag-pinned source, nothing else.
    const settingsPath = join(home, ".pi", "agent", "settings.json");
    let packages;
    try {
      packages = JSON.parse(await readFile(settingsPath, "utf8")).packages;
    } catch (error) {
      fail(`user settings ${settingsPath} is missing or unreadable`, String(error));
    }
    if (!Array.isArray(packages) || !packages.includes(expectedSource)) {
      fail(
        `user settings do not register ${expectedSource}`,
        `settings.json packages: ${JSON.stringify(packages)}`,
      );
    }
    console.log(`[install-smoke] settings registration ok (${expectedSource})`);

    // 3. Package listing as Pi itself reports it.
    const list = await run(piBin, ["list"], env, projectDir, LIST_TIMEOUT_MS, "pi list");
    if (!list.ok) fail("pi list failed", `${list.stdout}\n${list.stderr}`);
    if (!list.stdout.includes(expectedSource)) {
      fail(`pi list does not report ${expectedSource}`, list.stdout);
    }
    console.log(`[install-smoke] package listing ok (${expectedSource})`);

    // 4. Extension resource discovery: Pi loaded the installed package's
    // extension through the package manifest and the extension registered
    // its command.
    const probe = await probeCommands(piBin, env, projectDir, PROBE_TIMEOUT_MS);
    if (!probe.ok) fail("RPC get_commands probe failed", `${probe.error ?? ""}\n${probe.stdout}\n${probe.stderr}`);
    const helm = (probe.commands ?? []).find((command) => command?.name === "helm");
    if (!helm || helm.source !== "extension") {
      fail("the /helm extension command is not registered after install", JSON.stringify(probe.commands, null, 2));
    }
    const info = helm.sourceInfo ?? {};
    if (info.source !== expectedSource) {
      fail(`the loaded extension reports source ${JSON.stringify(info.source)} instead of ${expectedSource}`);
    }
    if (info.origin !== "package") {
      fail(`the extension was not discovered through the package manifest (origin: ${JSON.stringify(info.origin)})`);
    }
    const cloneBaseDir = typeof info.baseDir === "string" ? info.baseDir : undefined;
    if (!cloneBaseDir || !cloneBaseDir.startsWith(home + sep)) {
      fail(`the extension path ${JSON.stringify(cloneBaseDir)} is outside the temporary HOME install`);
    }
    console.log(`[install-smoke] extension discovery ok (${info.path} via ${expectedSource})`);

    // 5. The clone behind the loaded extension is exactly the released
    // version: its package.json version equals the tag without "v".
    let cloneVersion;
    try {
      cloneVersion = JSON.parse(await readFile(join(cloneBaseDir, "package.json"), "utf8")).version;
    } catch (error) {
      fail(`cannot read the installed clone's package.json under ${cloneBaseDir}`, String(error));
    }
    if (`v${cloneVersion}` !== tag) {
      fail(`the installed clone is version ${JSON.stringify(cloneVersion)}, which does not match tag ${tag}`);
    }
    console.log(`[install-smoke] installed clone version ok (package.json ${cloneVersion} = ${tag})`);

    console.log(`[install-smoke] PASS: ${expectedSource} installs, registers, lists, and loads its extension through Pi`);
  } finally {
    if (keepTemp) {
      console.log(`[install-smoke] keeping temporary directories: ${home} ${projectDir}`);
    } else {
      await rm(home, { recursive: true, force: true }).catch(() => {});
      await rm(projectDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

main().catch((error) => {
  console.error(`[install-smoke] FAIL: ${error?.stack ?? error}`);
  process.exit(1);
});
