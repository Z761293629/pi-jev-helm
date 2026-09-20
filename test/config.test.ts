import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_AUTOMATIC_ROUTING,
  DEFAULT_CLASSIFICATION_PROVIDER,
  DEFAULT_CONFIDENCE_THRESHOLD,
  loadHelmConfig,
  parseHelmConfig,
} from "../src/config.js";
import { completeRoutes, restoreAgentDirectory } from "./fixtures.js";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

afterEach(() => {
  restoreAgentDirectory(originalAgentDir);
});

describe("configuration schema version 1", () => {
  it("applies defaults while preserving complete Route Targets exactly", () => {
    const result = parseHelmConfig({ schemaVersion: 1, routes: completeRoutes });

    expect(result).toEqual({
      ok: true,
      config: {
        schemaVersion: 1,
        automaticRouting: DEFAULT_AUTOMATIC_ROUTING,
        classificationProvider: DEFAULT_CLASSIFICATION_PROVIDER,
        confidenceThreshold: DEFAULT_CONFIDENCE_THRESHOLD,
        routes: completeRoutes,
      },
    });
  });

  it.each(["openrouter", "typesafe"] as const)(
    "accepts the Classification Provider Selection %s",
    (classificationProvider) => {
      const result = parseHelmConfig({ schemaVersion: 1, classificationProvider, routes: completeRoutes });

      expect(result).toMatchObject({ ok: true, config: { classificationProvider } });
    },
  );

  it.each(["type-safe", "TypeSafe", "openAI", "auto", ""])(
    "rejects the unknown Classification Provider Selection %s by naming the field and its allowed values",
    (classificationProvider) => {
      const result = parseHelmConfig({ schemaVersion: 1, classificationProvider, routes: completeRoutes });

      expect(result).toMatchObject({ ok: false });
      if (!result.ok) {
        expect(result.errors).toContain(
          `classificationProvider must be one of ${DEFAULT_CLASSIFICATION_PROVIDER}, typesafe`,
        );
      }
    },
  );

  it.each([42, true, null, ["typesafe"], {}])(
    "rejects the non-string Classification Provider Selection %s",
    (classificationProvider) => {
      const result = parseHelmConfig({ schemaVersion: 1, classificationProvider, routes: completeRoutes });

      expect(result).toMatchObject({ ok: false });
      if (!result.ok) {
        expect(result.errors).toContain(
          `classificationProvider must be one of ${DEFAULT_CLASSIFICATION_PROVIDER}, typesafe`,
        );
      }
    },
  );

  it.each([0, 0.75, 1])("accepts a finite confidence threshold of %s", (confidenceThreshold) => {
    const result = parseHelmConfig({
      schemaVersion: 1,
      automaticRouting: false,
      confidenceThreshold,
      routes: completeRoutes,
    });

    expect(result).toMatchObject({
      ok: true,
      config: { automaticRouting: false, confidenceThreshold },
    });
  });

  it.each([-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects an out-of-contract confidence threshold of %s",
    (confidenceThreshold) => {
      const result = parseHelmConfig({ schemaVersion: 1, confidenceThreshold, routes: completeRoutes });

      expect(result).toMatchObject({ ok: false });
      if (!result.ok) expect(result.errors).toContain("confidenceThreshold must be a finite number between 0 and 1");
    },
  );

  it.each([
    ["a missing Route", { schemaVersion: 1, routes: { ...completeRoutes, research: undefined } }],
    [
      "an incomplete Route Target",
      {
        schemaVersion: 1,
        routes: { ...completeRoutes, coding: { provider: "anthropic", model: "coding/model" } },
      },
    ],
    [
      "an unknown Route",
      { schemaVersion: 1, routes: { ...completeRoutes, slow: completeRoutes.fast } },
    ],
    [
      "an extra Route Target field",
      {
        schemaVersion: 1,
        routes: { ...completeRoutes, fast: { ...completeRoutes.fast, fallback: true } },
      },
    ],
    [
      "an unsupported thinking level",
      {
        schemaVersion: 1,
        routes: { ...completeRoutes, fast: { ...completeRoutes.fast, thinkingLevel: "extreme" } },
      },
    ],
    ["an unknown top-level field", { schemaVersion: 1, routes: completeRoutes, watch: true }],
  ])("rejects %s", (_description, input) => {
    expect(parseHelmConfig(input)).toMatchObject({ ok: false });
  });

  it("requires schema version 1 and a boolean automaticRouting value", () => {
    expect(parseHelmConfig({ schemaVersion: 2, routes: completeRoutes })).toMatchObject({ ok: false });
    expect(
      parseHelmConfig({ schemaVersion: 1, automaticRouting: "true", routes: completeRoutes }),
    ).toMatchObject({ ok: false });
  });
});

describe("user-level configuration loading", () => {
  it("loads pi-jev-helm.json from Pi's configured user directory", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-jev-helm-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await writeFile(
      join(agentDir, "pi-jev-helm.json"),
      JSON.stringify({ schemaVersion: 1, automaticRouting: false, routes: completeRoutes }),
    );

    const result = await loadHelmConfig();

    expect(result).toMatchObject({
      ok: true,
      path: join(agentDir, "pi-jev-helm.json"),
      config: { automaticRouting: false },
    });
  });

  it("returns unhealthy configuration for a missing or malformed file", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-jev-helm-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const missing = await loadHelmConfig();
    expect(missing).toMatchObject({ ok: false, path: join(agentDir, "pi-jev-helm.json") });

    await writeFile(join(agentDir, "pi-jev-helm.json"), "{not json");
    const malformed = await loadHelmConfig();
    expect(malformed).toMatchObject({ ok: false, path: join(agentDir, "pi-jev-helm.json") });
  });
});
