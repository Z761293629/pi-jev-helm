import type {
  CapabilitySignalName,
  TaskClassificationV1,
} from "../src/classification-provider.js";

export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

export const completeRoutes = {
  fast: { provider: "openrouter", model: "fast/model", thinkingLevel: "off" },
  coding: { provider: "anthropic", model: "coding/model", thinkingLevel: "high" },
  reasoning: { provider: "openai", model: "reasoning/model", thinkingLevel: "xhigh" },
  research: { provider: "google", model: "research/model", thinkingLevel: "medium" },
};

export function createTaskClassification(
  values: Record<CapabilitySignalName, boolean>,
  confidence = 0.9,
): TaskClassificationV1 {
  return {
    schemaVersion: 1,
    signals: {
      codeWork: { value: values.codeWork, confidence },
      deepReasoning: { value: values.deepReasoning, confidence },
      externalResearch: { value: values.externalResearch, confidence },
    },
  };
}

export function createDecisionsResponse(probabilities: {
  codeWork: number;
  deepReasoning: number;
  externalResearch: number;
}): Response {
  return new Response(
    JSON.stringify({
      id: "decision-1",
      model: "typesafe/jev-1.13-20260917",
      provider: "TypeSafe",
      answers: {
        codeWork: { type: "noul", noul: probabilities.codeWork },
        deepReasoning: { type: "noul", noul: probabilities.deepReasoning },
        externalResearch: { type: "noul", noul: probabilities.externalResearch },
      },
      usage: { input_tokens: 123, output_tokens: 45, cost: 0.0001 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

export function restoreAgentDirectory(originalAgentDir: string | undefined): void {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
}
