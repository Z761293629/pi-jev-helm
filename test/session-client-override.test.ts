import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createDecisionsResponse,
  createTypeSafeDecisionsResponse,
  deferred,
  explanationData,
  restoreAgentDirectory,
} from "./fixtures.js";
import { createHarness, modelKey, writeHelmConfig } from "./harness.js";
import {
  TYPESAFE_API_BASE_URL,
  TYPESAFE_SYSTEMONE_PATH,
} from "../src/typesafe-jev-client.js";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
let agentDir: string;

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), "pi-jev-helm-client-override-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
  restoreAgentDirectory(originalAgentDir);
  vi.unstubAllGlobals();
});

function writeConfig(overrides: Record<string, unknown> = {}): Promise<void> {
  return writeHelmConfig(agentDir, overrides);
}

function lastStatus(harness: ReturnType<typeof createHarness>): { key: string; text: string } {
  const status = harness.statuses.at(-1);
  if (!status) throw new Error("Helm did not render a footer status");
  return status;
}

/** Wraps the harness registry's credential lookup to record every provider queried. */
function trackCredentialLookups(
  harness: ReturnType<typeof createHarness>,
  getApiKeyCalls: string[],
): void {
  const registry = (
    harness.context as unknown as {
      modelRegistry: { getApiKeyForProvider: (p: string) => Promise<string | undefined> };
    }
  ).modelRegistry;
  const original = registry.getApiKeyForProvider.bind(registry);
  registry.getApiKeyForProvider = async (provider: string) => {
    getApiKeyCalls.push(provider);
    return original(provider);
  };
}

/** Replaces the harness registry's credential lookup from this point on. */
function stubCredentialLookup(
  harness: ReturnType<typeof createHarness>,
  lookup: (provider: string) => string | undefined,
): void {
  (
    harness.context as unknown as {
      modelRegistry: { getApiKeyForProvider: (p: string) => Promise<string | undefined> };
    }
  ).modelRegistry.getApiKeyForProvider = async (provider: string) => lookup(provider);
}

describe("Session Classification Provider Override command grammar", () => {
  it("offers completions for the /helm client grammar alongside the existing commands", async () => {
    const harness = createHarness();
    const complete = harness.commands.get("helm")?.getArgumentCompletions;

    expect(await complete?.("")).toEqual([
      { value: "auto", label: "auto" },
      { value: "client", label: "client" },
      { value: "route", label: "route" },
      { value: "why", label: "why" },
    ]);
    expect(await complete?.("client ")).toEqual([
      { value: "client openrouter", label: "client openrouter" },
      { value: "client typesafe", label: "client typesafe" },
      { value: "client clear", label: "client clear" },
    ]);
    expect(await complete?.("client t")).toEqual([
      { value: "client typesafe", label: "client typesafe" },
    ]);
  });

  it("rejects malformed /helm client invocations with the full usage text", async () => {
    await writeConfig({});
    const harness = createHarness();
    await harness.emit("session_start", { reason: "startup" });

    for (const args of ["client", "client bogus", "client typesafe extra", "client clear extra"]) {
      await harness.command(args);
      expect(harness.notices.at(-1)).toMatchObject({ level: "warning" });
      expect(harness.notices.at(-1)?.message).toBe(
        "Usage: /helm | /helm auto on|off | /helm client openrouter|typesafe|clear | /helm route fast|coding|reasoning|research|clear | /helm why",
      );
    }
  });
});

describe("Setting the Session Classification Provider Override", () => {
  it("selects a Jev Client for the session while Automatic Routing is off", async () => {
    await writeConfig({ automaticRouting: false });
    const harness = createHarness("tui", {
      apiKeysByProvider: { openrouter: "key-openrouter", typesafe: "key-typesafe" },
    });
    await harness.emit("session_start", { reason: "startup" });
    expect(lastStatus(harness).text).toBe("pi-jev-helm: OpenRouter · off");

    await harness.command("client typesafe");
    expect(harness.notices.at(-1)).toMatchObject({ level: "info" });
    expect(harness.notices.at(-1)?.message).toContain("TypeSafe");
    expect(lastStatus(harness).text).toBe("pi-jev-helm: TypeSafe · off");
  });

  it("overrides back to openrouter when the configuration selected typesafe", async () => {
    await writeConfig({ automaticRouting: false, classificationProvider: "typesafe" });
    const harness = createHarness("tui", {
      apiKeysByProvider: { openrouter: "key-openrouter", typesafe: "key-typesafe" },
    });
    await harness.emit("session_start", { reason: "startup" });
    expect(lastStatus(harness).text).toBe("pi-jev-helm: TypeSafe · off");

    await harness.command("client openrouter");
    expect(harness.notices.at(-1)).toMatchObject({ level: "info" });
    expect(lastStatus(harness).text).toBe("pi-jev-helm: OpenRouter · off");
  });

  it("rejects a Jev Client without a resolvable credential and preserves the effective selection", async () => {
    await writeConfig({ automaticRouting: false });
    const harness = createHarness("tui", {
      apiKeysByProvider: { openrouter: "key-openrouter", typesafe: undefined },
    });
    await harness.emit("session_start", { reason: "startup" });

    await harness.command("client typesafe");
    expect(harness.notices.at(-1)).toMatchObject({ level: "error" });
    expect(harness.notices.at(-1)?.message).toContain("credential");
    expect(lastStatus(harness).text).toBe("pi-jev-helm: OpenRouter · off");
  });

  it("rejects a session override while configuration is unhealthy", async () => {
    const harness = createHarness();
    await harness.emit("session_start", { reason: "startup" });

    await harness.command("client typesafe");
    expect(harness.notices.at(-1)).toMatchObject({ level: "error" });
    expect(harness.notices.at(-1)?.message).toContain("configuration is unhealthy");
    expect(lastStatus(harness).text).toBe("pi-jev-helm: config error");
  });

  it("looks credentials up through Pi's registry exactly as classification does", async () => {
    await writeConfig({ automaticRouting: false });
    const getApiKeyCalls: string[] = [];
    const harness = createHarness("tui", {
      apiKeysByProvider: { openrouter: "key-openrouter", typesafe: "key-typesafe" },
    });
    trackCredentialLookups(harness, getApiKeyCalls);

    await harness.emit("session_start", { reason: "startup" });
    await harness.command("client typesafe");
    expect(getApiKeyCalls).toContain("typesafe");
  });
});

describe("Clearing the Session Classification Provider Override", () => {
  it("restores the configured Classification Provider Selection", async () => {
    await writeConfig({ automaticRouting: false });
    const harness = createHarness("tui", {
      apiKeysByProvider: { openrouter: "key-openrouter", typesafe: "key-typesafe" },
    });
    await harness.emit("session_start", { reason: "startup" });
    await harness.command("client typesafe");
    expect(lastStatus(harness).text).toBe("pi-jev-helm: TypeSafe · off");

    await harness.command("client clear");
    expect(harness.notices.at(-1)).toMatchObject({ level: "info" });
    expect(harness.notices.at(-1)?.message).toContain("cleared");
    expect(lastStatus(harness).text).toBe("pi-jev-helm: OpenRouter · off");
  });

  it("clears even when the configured Jev Client lacks a credential, warning instead", async () => {
    await writeConfig({ automaticRouting: false, classificationProvider: "typesafe" });
    const harness = createHarness("tui", {
      apiKeysByProvider: { openrouter: "key-openrouter", typesafe: "key-typesafe" },
    });
    await harness.emit("session_start", { reason: "startup" });
    await harness.command("client openrouter");
    expect(lastStatus(harness).text).toBe("pi-jev-helm: OpenRouter · off");

    // Simulate the configured credential disappearing while the override is
    // active: clear must still succeed and warn about the restored selection.
    stubCredentialLookup(harness, (provider) =>
      provider === "openrouter" ? "key-openrouter" : undefined,
    );

    await harness.command("client clear");
    expect(harness.notices.at(-1)).toMatchObject({ level: "warning" });
    expect(harness.notices.at(-1)?.message).toContain("cleared");
    expect(harness.notices.at(-1)?.message).toContain("no credential");
    expect(lastStatus(harness).text).toBe("pi-jev-helm: TypeSafe · off");
  });

  it("reports when there is no override to clear", async () => {
    await writeConfig({ automaticRouting: false });
    const harness = createHarness("tui", {
      apiKeysByProvider: { openrouter: "key-openrouter", typesafe: "key-typesafe" },
    });
    await harness.emit("session_start", { reason: "startup" });

    await harness.command("client clear");
    expect(harness.notices.at(-1)).toMatchObject({ level: "info" });
    expect(harness.notices.at(-1)?.message).toBe("No session Classification Provider Override");
    expect(lastStatus(harness).text).toBe("pi-jev-helm: OpenRouter · off");
  });

  it("keeps the existing grammar working next to the client command", async () => {
    await writeConfig({ automaticRouting: false });
    const harness = createHarness("tui", {
      apiKeysByProvider: { openrouter: "key-openrouter", typesafe: "key-typesafe" },
    });
    await harness.emit("session_start", { reason: "startup" });

    await harness.command("route coding");
    await harness.command("client clear");
    await harness.command("route clear");
    await harness.command("why");

    expect(harness.notices.at(-3)?.message).toBe("No session Classification Provider Override");
    expect(harness.notices.at(-2)?.message).toBe("Pending Route Override cleared");
    expect(harness.notices.at(-1)?.message).toBe(
      "Pi Jev Helm has no Routing Explanation recorded on the active branch.",
    );
  });
});

describe("Session Classification Provider Override lifecycle", () => {
  it.each(["reload", "new", "resume", "fork"] as const) (
    "discards the override when the session begins anew (%s)",
    async (reason) => {
      await writeConfig({ automaticRouting: false });
      const harness = createHarness("tui", {
        apiKeysByProvider: { openrouter: "key-openrouter", typesafe: "key-typesafe" },
      });
      await harness.emit("session_start", { reason: "startup" });
      await harness.command("client typesafe");
      expect(lastStatus(harness).text).toBe("pi-jev-helm: TypeSafe · off");

      await harness.emit("session_start", { reason });
      expect(lastStatus(harness).text).toBe("pi-jev-helm: OpenRouter · off");
    },
  );

  it("does not preserve the override across exit and the next session", async () => {
    await writeConfig({ automaticRouting: false });
    const harness = createHarness("tui", {
      apiKeysByProvider: { openrouter: "key-openrouter", typesafe: "key-typesafe" },
    });
    await harness.emit("session_start", { reason: "startup" });
    await harness.command("client typesafe");
    expect(lastStatus(harness).text).toBe("pi-jev-helm: TypeSafe · off");

    await harness.emit("session_shutdown");
    // Exiting never rewrites the configuration: the override is gone because
    // session state dies with the session, and the next session start finds
    // only the configured selection.
    await harness.emit("session_start", { reason: "resume" });
    expect(lastStatus(harness).text).toBe("pi-jev-helm: OpenRouter · off");
  });

  it("never writes the configuration file or appends session records", async () => {
    await writeConfig({ automaticRouting: false, classificationProvider: "openrouter" });
    const { readFile } = await import("node:fs/promises");
    const configPath = join(agentDir, "pi-jev-helm.json");
    const before = await readFile(configPath, "utf8");
    const harness = createHarness("tui", {
      apiKeysByProvider: { openrouter: "key-openrouter", typesafe: "key-typesafe" },
    });
    await harness.emit("session_start", { reason: "startup" });
    const entriesBefore = harness.sessionEntries.length;

    await harness.command("client typesafe");
    await harness.command("client clear");

    expect(await readFile(configPath, "utf8")).toBe(before);
    expect(harness.sessionEntries.length).toBe(entriesBefore);
    expect([...harness.commands.keys()]).toEqual(["helm"]);
  });
});

describe("Session Classification Provider Override attribution", () => {
  function writeOverrideConfig(): Promise<void> {
    return writeConfig({ automaticRouting: true });
  }

  async function runIdleRequest(
    harness: Awaited<ReturnType<typeof createHarness>>,
    prompt = "please fix this failing test",
  ): Promise<void> {
    await harness.emit("input", { text: prompt, source: "interactive" });
    await harness.emit("before_agent_start", { prompt });
  }

  it("sends future automatic attempts through the overridden Jev Client and records it", async () => {
    await writeOverrideConfig();
    const transport = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        createTypeSafeDecisionsResponse({ codeWork: 0.9, deepReasoning: 0.1, externalResearch: 0.1 }),
    );
    vi.stubGlobal("fetch", transport);
    const harness = createHarness("tui", {
      apiKeysByProvider: { openrouter: "key-openrouter", typesafe: "key-typesafe" },
    });
    await harness.emit("session_start", { reason: "startup" });
    await harness.command("client typesafe");

    await runIdleRequest(harness);

    expect(transport).toHaveBeenCalledTimes(1);
    const [input] = transport.mock.calls[0]!;
    expect(input).toBe(`${TYPESAFE_API_BASE_URL}${TYPESAFE_SYSTEMONE_PATH}`);
    expect(harness.currentModel && modelKey(harness.currentModel)).toBe("anthropic/coding/model");
    expect(explanationData(harness.sessionEntries).at(-1)).toEqual(
      expect.objectContaining({
        kind: "routing-attempt",
        source: "automatic",
        outcome: "routed",
        jevClient: "typesafe",
      }),
    );
  });

  it("keeps an in-flight run attributed to its snapshotted Jev Client while the override waits", async () => {
    await writeOverrideConfig();
    const classificationStarted = deferred<void>();
    const classificationResponse = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        classificationStarted.resolve(undefined);
        return classificationResponse.promise;
      }),
    );
    const harness = createHarness("tui", {
      apiKeysByProvider: { openrouter: "key-openrouter", typesafe: "key-typesafe" },
    });
    await harness.emit("session_start", { reason: "startup" });
    await harness.emit("input", { text: "change this code", source: "interactive" });
    const routing = harness.emit("before_agent_start", { prompt: "change this code" });
    await classificationStarted.promise;
    expect(lastStatus(harness).text).toBe("pi-jev-helm: OpenRouter · classifying");

    // The override is accepted, but the in-flight run stays attributed to the
    // Jev Client snapshotted when it began.
    await harness.command("client typesafe");
    expect(harness.notices.at(-1)).toMatchObject({ level: "info" });
    expect(lastStatus(harness).text).toBe("pi-jev-helm: OpenRouter · classifying");

    classificationResponse.resolve(
      createDecisionsResponse({ codeWork: 0.9, deepReasoning: 0.1, externalResearch: 0.1 }),
    );
    await routing;
    expect(lastStatus(harness).text).toBe("pi-jev-helm: OpenRouter · coding → anthropic/coding/model");
    expect(explanationData(harness.sessionEntries).at(-1)).toMatchObject({ jevClient: "openrouter" });

    await harness.emit("agent_settled");
    expect(lastStatus(harness).text).toBe("pi-jev-helm: TypeSafe · auto");
  });

  it("reflects the new effective selection once the snapshotted run settles", async () => {
    await writeOverrideConfig();
    const transport = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        createDecisionsResponse({ codeWork: 0.9, deepReasoning: 0.1, externalResearch: 0.1 }),
    );
    vi.stubGlobal("fetch", transport);
    const harness = createHarness("tui", {
      apiKeysByProvider: { openrouter: "key-openrouter", typesafe: "key-typesafe" },
    });
    await harness.emit("session_start", { reason: "startup" });
    await runIdleRequest(harness, "change this code");
    expect(lastStatus(harness).text).toContain("OpenRouter · coding →");
    expect(explanationData(harness.sessionEntries).at(-1)).toMatchObject({ jevClient: "openrouter" });

    await harness.command("client typesafe");
    // The settled run keeps its attribution; the override only waits.
    expect(lastStatus(harness).text).toContain("OpenRouter · coding →");

    await harness.emit("agent_settled");
    expect(lastStatus(harness).text).toBe("pi-jev-helm: TypeSafe · auto");

    await runIdleRequest(harness, "please also research this");
    expect(transport).toHaveBeenCalledTimes(2);
    const [secondInput] = transport.mock.calls[1]!;
    expect(secondInput).toBe(`${TYPESAFE_API_BASE_URL}${TYPESAFE_SYSTEMONE_PATH}`);
    expect(explanationData(harness.sessionEntries).at(-1)).toMatchObject({ jevClient: "typesafe" });
  });

  it("never falls back when the overridden Jev Client has no credential", async () => {
    await writeOverrideConfig();
    const transport = vi.fn(async () =>
      createDecisionsResponse({ codeWork: 0.9, deepReasoning: 0.1, externalResearch: 0.1 }),
    );
    vi.stubGlobal("fetch", transport);
    const harness = createHarness("tui", {
      apiKeysByProvider: { openrouter: "key-openrouter", typesafe: "key-typesafe" },
    });
    await harness.emit("session_start", { reason: "startup" });
    await harness.command("client typesafe");
    expect(harness.notices.at(-1)).toMatchObject({ level: "info" });
    // The credential disappears after the override was accepted.
    stubCredentialLookup(harness, (provider) =>
      provider === "openrouter" ? "key-openrouter" : undefined,
    );

    await runIdleRequest(harness);

    expect(transport).not.toHaveBeenCalled();
    expect(harness.modelChanges).toEqual([]);
    expect(lastStatus(harness).text).toBe("pi-jev-helm: TypeSafe · fail-open (provider-unavailable)");
    expect(explanationData(harness.sessionEntries).at(-1)).toEqual(
      expect.objectContaining({
        kind: "routing-attempt",
        outcome: "fail-open",
        jevClient: "typesafe",
        failOpen: expect.objectContaining({ reason: "provider-unavailable" }),
      }),
    );
  });

  it("keeps /helm why attributed to the Jev Client of the selected historical attempt", async () => {
    await writeOverrideConfig();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        createDecisionsResponse({ codeWork: 0.9, deepReasoning: 0.1, externalResearch: 0.1 }),
      ),
    );
    const harness = createHarness("tui", {
      apiKeysByProvider: { openrouter: "key-openrouter", typesafe: "key-typesafe" },
    });
    await harness.emit("session_start", { reason: "startup" });
    await runIdleRequest(harness);
    await harness.emit("agent_settled");
    await harness.command("client typesafe");

    await harness.command("why");
    const why = harness.notices.at(-1)?.message ?? "";
    expect(why).toContain("Jev Client: openrouter");
    expect(why).not.toContain("typesafe");
  });
});

describe("Footer identity for the effective Jev Client", () => {
  function harnessWithKeys(): ReturnType<typeof createHarness> {
    return createHarness("tui", {
      apiKeysByProvider: { openrouter: "key-openrouter", typesafe: "key-typesafe" },
    });
  }

  it("prefixes the idle automatic state", async () => {
    await writeConfig({ automaticRouting: true });
    const harness = harnessWithKeys();
    await harness.emit("session_start", { reason: "startup" });
    expect(lastStatus(harness).text).toBe("pi-jev-helm: OpenRouter · auto");
  });

  it("prefixes the pending Route Override state with the selection that would serve the next classification", async () => {
    await writeConfig({ automaticRouting: false, classificationProvider: "typesafe" });
    const harness = harnessWithKeys();
    await harness.emit("session_start", { reason: "startup" });

    await harness.command("route coding");
    expect(lastStatus(harness).text).toBe("pi-jev-helm: TypeSafe · override coding");
  });

  it("prefixes the low-confidence fail-open state", async () => {
    await writeConfig({ automaticRouting: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        createDecisionsResponse({ codeWork: 0.49, deepReasoning: 0.49, externalResearch: 0.49 }),
      ),
    );
    const harness = harnessWithKeys();
    await harness.emit("session_start", { reason: "startup" });
    await harness.emit("input", { text: "unclear request", source: "interactive" });
    await harness.emit("before_agent_start", { prompt: "unclear request" });

    expect(lastStatus(harness).text).toBe("pi-jev-helm: OpenRouter · fail-open (low-confidence)");
  });

  it("prefixes the Explicit Model Override state", async () => {
    await writeConfig({ automaticRouting: false });
    const harness = harnessWithKeys();
    await harness.emit("session_start", { reason: "startup" });
    await harness.command("route coding");
    await harness.emit("before_agent_start", { prompt: "implement this" });

    await harness.selectModel();
    expect(lastStatus(harness).text).toBe("pi-jev-helm: OpenRouter · explicit user-provider/user-model");
  });

  it("prefixes the restoration states and reflects the new selection after settle", async () => {
    await writeConfig({ automaticRouting: false });
    const restorationStarted = deferred<void>();
    const releaseRestoration = deferred<void>();
    const harness = createHarness("tui", {
      apiKeysByProvider: { openrouter: "key-openrouter", typesafe: "key-typesafe" },
      beforeModelApplication: {
        "baseline-provider/baseline-model": async () => {
          restorationStarted.resolve(undefined);
          await releaseRestoration.promise;
        },
      },
    });
    await harness.emit("session_start", { reason: "startup" });
    await harness.command("route coding");
    await harness.emit("before_agent_start", { prompt: "implement this" });

    await harness.command("client typesafe");
    const settlement = harness.emit("agent_settled");
    await restorationStarted.promise;
    expect(lastStatus(harness).text).toBe("pi-jev-helm: TypeSafe · restoring");

    releaseRestoration.resolve(undefined);
    await settlement;
    expect(lastStatus(harness).text).toBe("pi-jev-helm: TypeSafe · off");
  });

  it("prefixes a retained restoration failure", async () => {
    await writeConfig({ automaticRouting: false });
    const harness = createHarness("tui", {
      apiKeysByProvider: { openrouter: "key-openrouter", typesafe: "key-typesafe" },
      modelResults: { "baseline-provider/baseline-model": [false] },
    });
    await harness.emit("session_start", { reason: "startup" });
    await harness.command("route coding");
    await harness.emit("before_agent_start", { prompt: "routed work" });

    await harness.emit("agent_settled");
    expect(lastStatus(harness).text).toBe("pi-jev-helm: OpenRouter · restore failed");
    expect(harness.notices.at(-1)).toMatchObject({ level: "warning" });
  });

  it("shows only the effective human label without marking its source", async () => {
    await writeConfig({ automaticRouting: false, classificationProvider: "typesafe" });
    const configured = harnessWithKeys();
    await configured.emit("session_start", { reason: "startup" });
    expect(lastStatus(configured).text).toBe("pi-jev-helm: TypeSafe · off");

    await writeConfig({ automaticRouting: false });
    const overridden = harnessWithKeys();
    await overridden.emit("session_start", { reason: "startup" });
    await overridden.command("client typesafe");
    expect(lastStatus(overridden).text).toBe(lastStatus(configured).text);
  });

  it("keeps the unprefixed config error state", async () => {
    const harness = harnessWithKeys();
    await harness.emit("session_start", { reason: "startup" });
    expect(lastStatus(harness).text).toBe("pi-jev-helm: config error");
  });

  it("gains no Jev Client lines in the /helm multi-line status", async () => {
    await writeConfig({ automaticRouting: false, classificationProvider: "typesafe" });
    const harness = harnessWithKeys();
    await harness.emit("session_start", { reason: "startup" });
    await harness.command("client openrouter");

    await harness.command();
    const status = harness.notices.at(-1)?.message ?? "";
    expect(status).not.toContain("Jev Client");
    expect(status).not.toContain("Classification Provider Override");
    expect(status.split("\n")).toEqual([
      "Pi Jev Helm",
      "Configuration: healthy",
      expect.stringContaining("Configuration file:"),
      "Automatic Routing (configured): off",
      "Automatic Routing (session): off",
      "Session override: none",
      "Confidence threshold: 0.75",
      "Routing capability: Automatic Routing and Route Override",
      "Pending Route Override: none",
      expect.stringContaining("Current or recent Route:"),
      expect.stringContaining("Baseline Model:"),
    ]);
  });

  it.each(["rpc", "json", "print"] as const)(
    "keeps machine-readable modes free of footer status for the client command (%s)",
    async (mode) => {
      await writeConfig({ automaticRouting: false });
      const harness = createHarness(mode, {
        apiKeysByProvider: { openrouter: "key-openrouter", typesafe: "key-typesafe" },
      });
      await harness.emit("session_start", { reason: "startup" });
      await harness.command("client typesafe");
      await harness.command("client clear");

      expect(harness.statuses).toEqual([]);
    },
  );

  it("never leaks the resolved credential through notices or explanations", async () => {
    await writeConfig({ automaticRouting: true });
    const openrouterSecret = "sk-or-secret-abc123";
    const typesafeSecret = "sk-ts-secret-xyz789";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        createDecisionsResponse({ codeWork: 0.9, deepReasoning: 0.1, externalResearch: 0.1 }),
      ),
    );
    const harness = createHarness("tui", {
      apiKeysByProvider: { openrouter: openrouterSecret, typesafe: typesafeSecret },
    });
    await harness.emit("session_start", { reason: "startup" });
    await harness.command("client typesafe");
    await harness.emit("input", { text: "fix this code", source: "interactive" });
    await harness.emit("before_agent_start", { prompt: "fix this code" });
    await harness.emit("agent_settled");
    await harness.command("why");
    await harness.command();

    const allOutput = JSON.stringify({
      statuses: harness.statuses,
      notices: harness.notices,
      explanations: explanationData(harness.sessionEntries),
    });
    expect(allOutput).not.toContain(openrouterSecret);
    expect(allOutput).not.toContain(typesafeSecret);
  });
});
