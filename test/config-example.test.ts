import { copyFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import {
  HELM_CONFIG_FILE,
  loadHelmConfig,
  ROUTES,
  type ConfigLoadResult,
  type Route,
} from "../src/config.js";
import { restoreAgentDirectory } from "./fixtures.js";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

afterEach(() => {
  restoreAgentDirectory(originalAgentDir);
});

const EXAMPLE_PATH = join(import.meta.dirname, "..", "examples", HELM_CONFIG_FILE);

const EXAMPLE_ROUTES = {
  fast: { provider: "your-fast-provider", model: "your-fast-model", thinkingLevel: "off" },
  coding: { provider: "your-coding-provider", model: "your-coding-model", thinkingLevel: "high" },
  reasoning: { provider: "your-reasoning-provider", model: "your-reasoning-model", thinkingLevel: "high" },
  research: { provider: "your-research-provider", model: "your-research-model", thinkingLevel: "medium" },
};

/** Loads the checked-in example through the production loader from a fresh Pi agent directory. */
async function loadExampleFromAgentDirectory(): Promise<ConfigLoadResult> {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-jev-helm-example-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  expect(getAgentDir()).toBe(agentDir);
  await copyFile(EXAMPLE_PATH, join(agentDir, HELM_CONFIG_FILE));
  return loadHelmConfig();
}

describe("checked-in starter configuration example", () => {
  it("loads completely through the production loader from Pi's reported agent directory", async () => {
    const result = await loadExampleFromAgentDirectory();

    expect(result).toEqual({
      ok: true,
      path: join(process.env.PI_CODING_AGENT_DIR!, HELM_CONFIG_FILE),
      config: {
        schemaVersion: 1,
        automaticRouting: true,
        confidenceThreshold: 0.75,
        routes: EXAMPLE_ROUTES,
      },
    });
  });

  it("uses only credential-free provider and model placeholders", async () => {
    const source = await readFile(EXAMPLE_PATH, "utf8");
    expect(source).not.toMatch(/api[_-]?key|secret|token|password|authorization|credential|sk-[a-z0-9]{10,}/i);

    const parsed = JSON.parse(source) as { routes: Record<Route, { provider: string; model: string }> };
    for (const route of ROUTES) {
      expect(parsed.routes[route].provider, `routes.${route}.provider`).toMatch(/^your-/);
      expect(parsed.routes[route].model, `routes.${route}.model`).toMatch(/^your-/);
    }
  });

  it("fails loading when the example drifts from the configuration schema", async () => {
    const source = await readFile(EXAMPLE_PATH, "utf8");
    const drifted = JSON.parse(source) as { routes: Record<string, unknown> };
    delete drifted.routes.research;

    const agentDir = await mkdtemp(join(tmpdir(), "pi-jev-helm-example-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await writeFile(join(agentDir, HELM_CONFIG_FILE), JSON.stringify(drifted));

    const result = await loadHelmConfig();

    expect(result).toMatchObject({ ok: false, path: join(agentDir, HELM_CONFIG_FILE) });
    if (!result.ok) expect(result.errors).toContain("routes.research is required");
  });
});
