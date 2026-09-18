import { describe, expect, it } from "vitest";

import {
  OpenRouterJevClassificationProvider,
  type ClassificationResult,
} from "../src/classification-provider.js";
import { CLASSIFICATION_CORPUS } from "../src/classification-corpus.js";
import {
  REAL_JEV_GATE_CONFIDENCE_THRESHOLD,
  REAL_JEV_GATE_EXECUTIONS_PER_MESSAGE,
  REAL_JEV_GATE_MODEL,
  REAL_JEV_GATE_REQUIRED_PASSES,
  assertRealJevGateCompatibility,
  evaluateRealJevGateMessage,
  resolveRealJevGateApiKey,
} from "../src/real-jev-gate.js";

// Refuses to run when the corpus does not match the current template version:
// a substantive template change requires a new template version plus a
// complete corpus rerun before any paid request is attempted.
assertRealJevGateCompatibility();

// Missing or blank credentials fail the collection clearly, before any
// network access. This file runs only through `npm run test:real-jev-gate`
// (vitest.real-jev-gate.config.ts) and is excluded from default CI.
const credentials = resolveRealJevGateApiKey(process.env);
if (!credentials.ok) throw new Error(credentials.error);

const classificationProvider = new OpenRouterJevClassificationProvider({
  apiKey: credentials.apiKey,
});

describe(`real OpenRouter/Jev compatibility gate (${REAL_JEV_GATE_MODEL}, threshold ${REAL_JEV_GATE_CONFIDENCE_THRESHOLD})`, () => {
  for (const entry of CLASSIFICATION_CORPUS) {
    describe(`${entry.id} (${entry.clarity}${entry.boundary ? `, ${entry.boundary}` : ""})`, () => {
      it(`passes the two-of-three rule across ${REAL_JEV_GATE_EXECUTIONS_PER_MESSAGE} independent executions`, async () => {
        const executions: ClassificationResult[] = [];
        for (let execution = 0; execution < REAL_JEV_GATE_EXECUTIONS_PER_MESSAGE; execution += 1) {
          executions.push(await classificationProvider.classify(entry.message));
        }

        const verdict = evaluateRealJevGateMessage(entry, executions);
        const detail = verdict.executions
          .map((execution, index) => `#${index + 1}: ${execution.passed ? "pass" : "fail"} (${execution.reason})`)
          .join("; ");
        expect(
          verdict.passed,
          `${verdict.entryId}: ${verdict.passedExecutions}/${verdict.requiredPasses} passing executions — ${detail}`,
        ).toBe(true);
      }, 120_000);
    });
  }
});
