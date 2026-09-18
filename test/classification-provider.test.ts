import { describe, expect, it, vi } from "vitest";

import {
  CLASSIFICATION_MODEL,
  CLASSIFICATION_TEMPLATE_V1,
  OPENROUTER_DECISIONS_URL,
  OpenRouterJevClassificationProvider,
} from "../src/classification-provider.js";
import { createDecisionsResponse } from "./fixtures.js";

describe("OpenRouter Jev Classification Provider", () => {
  it("publishes the versioned three-Noul whole-request template", () => {
    expect(CLASSIFICATION_TEMPLATE_V1).toEqual({
      codeWork: {
        type: "noul",
        instructions:
          "Determine whether completing the user's entire request requires code work. For a compound request, answer yes if any part requires it.",
        criteria: {
          true: "The request requires reading, writing, modifying, debugging, or reviewing source code, tests, configuration, build artifacts, or CI artifacts.",
          false:
            "The request can be completed without working with code-engineering artifacts. A software topic by itself does not count.",
        },
      },
      deepReasoning: {
        type: "noul",
        instructions:
          "Determine whether completing the user's entire request requires deep reasoning. For a compound request, answer yes if any part requires it.",
        criteria: {
          true: "Answer quality depends on multi-step inference, constraint trade-offs, proof, diagnosis, or non-obvious planning.",
          false:
            "The request can be answered directly without those operations. Length, requested detail, or complex wording alone do not count.",
        },
      },
      externalResearch: {
        type: "noul",
        instructions:
          "Determine whether completing the user's entire request requires external research. For a compound request, answer yes if any part requires it.",
        criteria: {
          true:
            "The request requires retrieving or verifying external evidence, documentation, or time-sensitive facts beyond the current request.",
          false:
            "The request can be completed from supplied information, local repository exploration, or stable general knowledge. Local repository exploration does not count as external research.",
        },
      },
    });
  });

  it("sends one fixed Decisions request and preserves the current user message as state", async () => {
    const transport = vi.fn(async () =>
      createDecisionsResponse({ codeWork: 0.8, deepReasoning: 0.3, externalResearch: 0.1 }),
    );
    const provider = new OpenRouterJevClassificationProvider({
      apiKey: "secret-key",
      fetch: transport,
    });
    const message = "Read src/index.ts, then check the current OpenRouter docs.\nDo not rewrite this.";

    const result = await provider.classify(message);

    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledWith(OPENROUTER_DECISIONS_URL, {
      method: "POST",
      headers: {
        Authorization: "Bearer secret-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: CLASSIFICATION_MODEL,
        state: message,
        questions: CLASSIFICATION_TEMPLATE_V1,
        provider: { zdr: true },
      }),
      signal: expect.any(AbortSignal),
    });
    expect(Object.keys(CLASSIFICATION_TEMPLATE_V1)).toEqual([
      "codeWork",
      "deepReasoning",
      "externalResearch",
    ]);
    expect(result).toEqual({
      ok: true,
      classification: {
        schemaVersion: 1,
        signals: {
          codeWork: { value: true, confidence: 0.8 },
          deepReasoning: { value: false, confidence: 0.7 },
          externalResearch: { value: false, confidence: 0.9 },
        },
      },
    });
  });

  it.each([
    [0, false, 1],
    [0.49, false, 0.51],
    [0.5, true, 0.5],
    [1, true, 1],
  ] as const)("maps Noul probability %s to value %s and confidence %s", async (p, value, confidence) => {
    const provider = new OpenRouterJevClassificationProvider({
      apiKey: "secret-key",
      fetch: async () => createDecisionsResponse({ codeWork: p, deepReasoning: p, externalResearch: p }),
    });

    const result = await provider.classify("classify me");

    expect(result).toEqual({
      ok: true,
      classification: {
        schemaVersion: 1,
        signals: {
          codeWork: { value, confidence },
          deepReasoning: { value, confidence },
          externalResearch: { value, confidence },
        },
      },
    });
  });
});
