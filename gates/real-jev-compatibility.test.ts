import { describe, expect, it } from "vitest";

import {
  OpenRouterJevClassificationProvider,
  JevClassificationProvider,
  type ClassificationProvider,
  type ClassificationResult,
} from "../src/classification-provider.js";
import { CLASSIFICATION_CORPUS } from "../src/classification-corpus.js";
import { TypeSafeJevClient } from "../src/typesafe-jev-client.js";
import {
  REAL_JEV_GATE_CONFIDENCE_THRESHOLD,
  REAL_JEV_GATE_EXECUTIONS_PER_MESSAGE,
  REAL_JEV_GATE_OPENROUTER_MODEL,
  REAL_JEV_GATE_TYPESAFE_MODEL,
  assertRealJevGateCompatibility,
  evaluateRealJevGateMessage,
  findRealJevGateCredentialError,
  resolveRealJevGateLegCredentials,
  type RealJevGateCredentialResolution,
} from "../src/real-jev-gate.js";

// Refuses to run when the corpus does not match the current template version:
// a substantive template change requires a new template version plus a
// complete corpus rerun before any paid request is attempted.
assertRealJevGateCompatibility();

// Each leg resolves its own credential: a leg without its credential is
// skipped explicitly (never silently passed). A run without any credential at
// all fails the collection clearly, before any network access, because an
// all-skipped run would certify nothing. This file runs only through
// `npm run test:real-jev-gate` (vitest.real-jev-gate.config.ts) and is
// excluded from default CI.
const legs = resolveRealJevGateLegCredentials(process.env);
const noCredentialError = findRealJevGateCredentialError(legs);
if (noCredentialError !== undefined) throw new Error(noCredentialError);

/**
 * Runs one leg of the real Jev gate: the full classification corpus,
 * reclassified live through the leg's own Jev Client under the shared
 * threshold and the per-message two-of-three rule. A consistently failing
 * corpus message fails its leg's test — and with it the whole gate run.
 */
function realJevGateLeg(
  title: string,
  credential: RealJevGateCredentialResolution,
  createClassificationProvider: (apiKey: string) => ClassificationProvider,
): void {
  describe.skipIf(!credential.ok)(title, () => {
    // The tests are always registered so that a run reports a credential-less
    // leg as explicitly skipped ("24 skipped") instead of silently omitting
    // it; describe.skipIf keeps every body from executing, so a skipped leg
    // never attempts a request.
    for (const entry of CLASSIFICATION_CORPUS) {
      describe(`${entry.id} (${entry.clarity}${entry.boundary ? `, ${entry.boundary}` : ""})`, () => {
        it(`passes the two-of-three rule across ${REAL_JEV_GATE_EXECUTIONS_PER_MESSAGE} independent executions`, async () => {
          if (!credential.ok) throw new Error("unreachable: a leg without its credential is skipped");
          const classificationProvider = createClassificationProvider(credential.apiKey);
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
}

realJevGateLeg(
  `real OpenRouter/Jev compatibility gate (${REAL_JEV_GATE_OPENROUTER_MODEL}, threshold ${REAL_JEV_GATE_CONFIDENCE_THRESHOLD})`,
  legs.openrouter,
  (apiKey) => new OpenRouterJevClassificationProvider({ apiKey }),
);

realJevGateLeg(
  `real TypeSafe/Jev compatibility gate (${REAL_JEV_GATE_TYPESAFE_MODEL}, threshold ${REAL_JEV_GATE_CONFIDENCE_THRESHOLD})`,
  legs.typesafe,
  (apiKey) => new JevClassificationProvider({ client: new TypeSafeJevClient({ apiKey }) }),
);
