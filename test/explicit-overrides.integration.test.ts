import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxProvider,
  type FauxProviderHandle,
} from "@earendil-works/pi-ai/providers/faux";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import helmExtension from "../src/index.js";
import {
  completeRoutes,
  createDecisionsResponse,
  deferred,
  restoreAgentDirectory,
} from "./fixtures.js";

function createSingleModelFauxProvider(provider: string, id: string): FauxProviderHandle {
  return fauxProvider({ provider, models: [{ id, reasoning: true }] });
}

function withApiKeyAuth(faux: FauxProviderHandle) {
  return {
    ...faux.provider,
    auth: {
      apiKey: {
        name: `Fake ${faux.provider.id}`,
        async resolve() {
          return { auth: { apiKey: "test-key" } };
        },
      },
    },
  };
}

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

afterEach(() => {
  restoreAgentDirectory(originalAgentDir);
  vi.unstubAllGlobals();
});

describe("Pi Jev Helm public API lifecycle", () => {
  it("restores an incomplete Baseline checkpoint through Pi session persistence", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-jev-helm-public-api-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await writeFile(
      join(agentDir, "pi-jev-helm.json"),
      JSON.stringify({ schemaVersion: 1, automaticRouting: false, routes: completeRoutes }),
    );

    const baseline = createSingleModelFauxProvider("baseline-provider", "baseline-model");
    const coding = createSingleModelFauxProvider(
      completeRoutes.coding.provider,
      completeRoutes.coding.model,
    );
    const modelRuntime = await ModelRuntime.create({
      modelsPath: null,
      refreshOnCreate: false,
    });
    modelRuntime.registerNativeProvider(withApiKeyAuth(baseline));
    modelRuntime.registerNativeProvider(withApiKeyAuth(coding));

    const sessionManager = SessionManager.inMemory(agentDir);
    sessionManager.appendModelChange(completeRoutes.coding.provider, completeRoutes.coding.model);
    sessionManager.appendThinkingLevelChange(completeRoutes.coding.thinkingLevel);
    sessionManager.appendCustomEntry("pi-jev-helm-baseline-checkpoint", {
      schemaVersion: 1,
      checkpointId: "interrupted-checkpoint",
      status: "pending",
      baseline: {
        provider: "baseline-provider",
        model: "baseline-model",
        thinkingLevel: "medium",
      },
    });
    sessionManager.appendMessage({
      role: "user",
      content: "interrupted request",
      timestamp: Date.now(),
    });

    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd: agentDir,
      agentDir,
      settingsManager,
      extensionFactories: [helmExtension],
    });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
      cwd: agentDir,
      agentDir,
      model: coding.getModel(),
      thinkingLevel: "high",
      modelRuntime,
      resourceLoader,
      sessionManager,
      settingsManager,
      noTools: "all",
    });

    try {
      await session.bindExtensions({});
      expect(session.model).toMatchObject({ provider: "baseline-provider", id: "baseline-model" });
      expect(session.thinkingLevel).toBe("medium");
      const checkpointEntries = sessionManager.getBranch().filter(
        (entry) => entry.type === "custom" && entry.customType === "pi-jev-helm-baseline-checkpoint",
      );
      expect(checkpointEntries.at(-1)).toMatchObject({
        data: { checkpointId: "interrupted-checkpoint", status: "complete" },
      });
    } finally {
      session.dispose();
    }
  });

  it("keeps an Explicit Model Override selected during pending Route Target application", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-jev-helm-public-api-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await writeFile(
      join(agentDir, "pi-jev-helm.json"),
      JSON.stringify({ schemaVersion: 1, automaticRouting: true, routes: completeRoutes }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        createDecisionsResponse({ codeWork: 0.9, deepReasoning: 0.1, externalResearch: 0.1 }),
      ),
    );

    const baseline = createSingleModelFauxProvider("baseline-provider", "baseline-model");
    const explicit = createSingleModelFauxProvider("user-provider", "user-model");
    const coding = createSingleModelFauxProvider(
      completeRoutes.coding.provider,
      completeRoutes.coding.model,
    );
    const fast = createSingleModelFauxProvider(completeRoutes.fast.provider, completeRoutes.fast.model);
    const reasoning = createSingleModelFauxProvider(
      completeRoutes.reasoning.provider,
      completeRoutes.reasoning.model,
    );
    const research = createSingleModelFauxProvider(
      completeRoutes.research.provider,
      completeRoutes.research.model,
    );

    const codingApplicationStarted = deferred<void>();
    const releaseCodingApplication = deferred<void>();
    let delayCodingApplication = false;
    const codingProvider = withApiKeyAuth(coding);
    const codingResolve = codingProvider.auth.apiKey.resolve;
    codingProvider.auth.apiKey.resolve = async (...args) => {
      if (delayCodingApplication) {
        codingApplicationStarted.resolve(undefined);
        await releaseCodingApplication.promise;
      }
      return codingResolve(...args);
    };

    const modelRuntime = await ModelRuntime.create({
      modelsPath: null,
      refreshOnCreate: false,
    });
    modelRuntime.registerNativeProvider(withApiKeyAuth(baseline));
    modelRuntime.registerNativeProvider(withApiKeyAuth(explicit));
    modelRuntime.registerNativeProvider(codingProvider);
    modelRuntime.registerNativeProvider(withApiKeyAuth(fast));
    modelRuntime.registerNativeProvider(withApiKeyAuth(reasoning));
    modelRuntime.registerNativeProvider(withApiKeyAuth(research));

    baseline.setResponses([fauxAssistantMessage("request remained operational")]);
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd: agentDir,
      agentDir,
      settingsManager,
      extensionFactories: [helmExtension],
    });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
      cwd: agentDir,
      agentDir,
      model: baseline.getModel(),
      thinkingLevel: "medium",
      modelRuntime,
      resourceLoader,
      sessionManager: SessionManager.inMemory(agentDir),
      settingsManager,
      noTools: "all",
    });

    try {
      delayCodingApplication = true;
      const prompt = session.prompt("change this code");
      await codingApplicationStarted.promise;

      await session.setModel(explicit.getModel());
      releaseCodingApplication.resolve(undefined);
      await prompt;

      expect(session.model).toMatchObject({ provider: "user-provider", id: "user-model" });
      expect(baseline.state.callCount).toBe(1);
      expect(coding.state.callCount).toBe(0);
    } finally {
      session.dispose();
    }
  });
});
