import { describe, expect, it } from "vitest";

import {
  CLASSIFICATION_MODEL,
  type ClassificationFailureKind,
  type ClassificationResult,
  type TaskClassificationV1,
} from "../src/classification-provider.js";
import { CLASSIFICATION_CORPUS, CLASSIFICATION_CORPUS_CONTENT_DIGEST } from "../src/classification-corpus.js";
import { DEFAULT_CONFIDENCE_THRESHOLD } from "../src/config.js";import {
  OPENROUTER_API_KEY_ENV,
  REAL_JEV_GATE_CONFIDENCE_THRESHOLD,
  REAL_JEV_GATE_EXECUTIONS_PER_MESSAGE,
  REAL_JEV_GATE_MODEL,
  REAL_JEV_GATE_REQUIRED_PASSES,
  evaluateRealJevGateExecution,
  evaluateRealJevGateMessage,
  findRealJevGateCompatibilityError,
  resolveRealJevGateApiKey,
  type RealJevGateMessageVerdict,
} from "../src/real-jev-gate.js";

import { createTaskClassification } from "./fixtures.js";

function ok(classificationResult: TaskClassificationV1): ClassificationResult {
  return { ok: true, classification: classificationResult };
}

function providerFailure(kind: ClassificationFailureKind = "timeout"): ClassificationResult {
  return {
    ok: false,
    failure: { kind, summary: "deterministic test failure" },
  };
}

function corpusEntry(id: string) {
  const entry = CLASSIFICATION_CORPUS.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`missing corpus entry ${id}`);
  return entry;
}

describe("real Jev gate fixed settings", () => {
  it("pins the fixed Jev model, threshold, execution count, and required passes", () => {
    expect(REAL_JEV_GATE_MODEL).toBe("typesafe/jev-1.13");
    expect(REAL_JEV_GATE_MODEL).toBe(CLASSIFICATION_MODEL);
    expect(REAL_JEV_GATE_CONFIDENCE_THRESHOLD).toBe(0.75);
    expect(REAL_JEV_GATE_CONFIDENCE_THRESHOLD).toBe(DEFAULT_CONFIDENCE_THRESHOLD);
    expect(REAL_JEV_GATE_EXECUTIONS_PER_MESSAGE).toBe(3);
    expect(REAL_JEV_GATE_REQUIRED_PASSES).toBe(2);
    expect(OPENROUTER_API_KEY_ENV).toBe("OPENROUTER_API_KEY");
  });
});

describe("real Jev gate credentials", () => {
  it("fails clearly without credentials and names the explicit invocation", () => {
    const resolution = resolveRealJevGateApiKey({});
    expect(resolution.ok).toBe(false);
    if (resolution.ok) throw new Error("expected missing credentials to fail");
    expect(resolution.error).toContain("OPENROUTER_API_KEY");
    expect(resolution.error).toContain("npm run test:real-jev-gate");
  });

  it("fails clearly for a blank credential", () => {
    const resolution = resolveRealJevGateApiKey({ OPENROUTER_API_KEY: "   " });
    expect(resolution.ok).toBe(false);
    if (resolution.ok) throw new Error("expected blank credentials to fail");
    expect(resolution.error).toContain("OPENROUTER_API_KEY");
  });

  it("resolves a present credential without touching the network", () => {
    const resolution = resolveRealJevGateApiKey({ OPENROUTER_API_KEY: "sk-or-real" });
    expect(resolution).toEqual({ ok: true, apiKey: "sk-or-real" });
  });
});

describe("real Jev gate per-execution verdicts for clear examples", () => {
  const codingEntry = corpusEntry("classification-v1/003");

  it("passes a confident matching classification", () => {
    const verdict = evaluateRealJevGateExecution(
      codingEntry,
      ok(createTaskClassification({ codeWork: true, deepReasoning: false, externalResearch: false }, 0.9)),
    );
    expect(verdict.passed).toBe(true);
  });

  it("fails when a decision-relevant confidence is below threshold", () => {
    // `coding` Route checks externalResearch and codeWork.
    const verdict = evaluateRealJevGateExecution(
      codingEntry,
      ok({
        schemaVersion: 1,
        signals: {
          codeWork: { value: true, confidence: 0.9 },
          deepReasoning: { value: false, confidence: 0.9 },
          externalResearch: { value: false, confidence: 0.5 },
        },
      }),
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.reason).toContain("externalResearch");
  });

  it("ignores confidences that cannot change the Route", () => {
    // `research` Route checks only externalResearch.
    const researchEntry = corpusEntry("classification-v1/007");
    const verdict = evaluateRealJevGateExecution(
      researchEntry,
      ok({
        schemaVersion: 1,
        signals: {
          codeWork: { value: false, confidence: 0.4 },
          deepReasoning: { value: false, confidence: 0.4 },
          externalResearch: { value: true, confidence: 0.95 },
        },
      }),
    );
    expect(verdict.passed).toBe(true);
  });

  it("fails a mismatched Boolean vector even with high confidence", () => {
    const verdict = evaluateRealJevGateExecution(
      codingEntry,
      ok(createTaskClassification({ codeWork: false, deepReasoning: false, externalResearch: false }, 0.99)),
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.reason).toContain("boolean_vector");
  });

  it("fails a provider failure instead of treating it as a pass", () => {
    const verdict = evaluateRealJevGateExecution(codingEntry, providerFailure("rate_limited"));
    expect(verdict.passed).toBe(false);
    expect(verdict.reason).toContain("rate_limited");
  });

  it("evaluates exactly at the configured threshold", () => {
    const verdict = evaluateRealJevGateExecution(
      codingEntry,
      ok(createTaskClassification({ codeWork: true, deepReasoning: false, externalResearch: false }, 0.75)),
    );
    expect(verdict.passed).toBe(true);
  });
});

describe("real Jev gate per-execution verdicts for ambiguous examples", () => {
  const ambiguousEntry = corpusEntry("classification-v1/023");

  it("passes when the policy fails open for insufficient relevant confidence", () => {
    const verdict = evaluateRealJevGateExecution(
      ambiguousEntry,
      ok(createTaskClassification({ codeWork: false, deepReasoning: false, externalResearch: false }, 0.4)),
    );
    expect(verdict.passed).toBe(true);
    expect(verdict.reason).toContain("low_confidence");
  });

  it("fails when the policy confidently selects a Route", () => {
    const verdict = evaluateRealJevGateExecution(
      ambiguousEntry,
      ok(createTaskClassification({ codeWork: false, deepReasoning: false, externalResearch: false }, 0.99)),
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.reason).toContain("policy");
  });

  it("fails a mismatched Boolean vector even when confidence is low", () => {
    const verdict = evaluateRealJevGateExecution(
      ambiguousEntry,
      ok(createTaskClassification({ codeWork: true, deepReasoning: false, externalResearch: false }, 0.4)),
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.reason).toContain("boolean_vector");
  });

  it("fails a provider failure instead of treating it as a fail-open", () => {
    const verdict = evaluateRealJevGateExecution(ambiguousEntry, providerFailure("timeout"));
    expect(verdict.passed).toBe(false);
    expect(verdict.reason).toContain("timeout");
  });
});

describe("real Jev gate per-message two-of-three rule", () => {
  const codingEntry = corpusEntry("classification-v1/003");
  const passing = ok(createTaskClassification({ codeWork: true, deepReasoning: false, externalResearch: false }, 0.9));
  const failing = providerFailure("upstream");

  function expectMessage(
    entryId: string,
    results: ClassificationResult[],
  ): RealJevGateMessageVerdict {
    const entry = corpusEntry(entryId);
    const verdict = evaluateRealJevGateMessage(entry, results);
    expect(verdict.entryId).toBe(entryId);
    expect(verdict.requiredPasses).toBe(2);
    expect(verdict.executions).toHaveLength(results.length);
    return verdict;
  }

  it("passes with exactly two passing executions", () => {
    const verdict = expectMessage("classification-v1/003", [passing, failing, passing]);
    expect(verdict.passedExecutions).toBe(2);
    expect(verdict.passed).toBe(true);
  });

  it("fails with only one passing execution", () => {
    const verdict = expectMessage("classification-v1/003", [passing, failing, failing]);
    expect(verdict.passedExecutions).toBe(1);
    expect(verdict.passed).toBe(false);
  });

  it("fails when no execution passes", () => {
    const verdict = expectMessage("classification-v1/003", [failing, failing, failing]);
    expect(verdict.passed).toBe(false);
  });

  it("passes when every execution passes", () => {
    const verdict = expectMessage("classification-v1/003", [passing, passing, passing]);
    expect(verdict.passed).toBe(true);
  });

  it("keeps ambiguous examples on the same two-of-three rule", () => {
    const ambiguousEntry = corpusEntry("classification-v1/024");
    const failOpen = ok(createTaskClassification({ codeWork: false, deepReasoning: false, externalResearch: false }, 0.3));
    const confident = ok(createTaskClassification({ codeWork: false, deepReasoning: false, externalResearch: false }, 0.99));
    const passes = evaluateRealJevGateMessage(ambiguousEntry, [failOpen, failOpen, confident]);
    const fails = evaluateRealJevGateMessage(ambiguousEntry, [failOpen, confident, confident]);
    expect(passes.passed).toBe(true);
    expect(fails.passed).toBe(false);
  });

  it("rejects a result set that is not three independent executions", () => {
    const entry = corpusEntry("classification-v1/003");
    expect(() => evaluateRealJevGateMessage(entry, [passing, passing])).toThrow();
    expect(() => evaluateRealJevGateMessage(entry, [passing, passing, passing, passing])).toThrow();
  });
});

describe("real Jev gate template compatibility", () => {
  it("finds no compatibility error for the shipped corpus and template", () => {
    expect(findRealJevGateCompatibilityError()).toBeUndefined();
  });

  it("requires a new template version and complete corpus rerun after a template change", () => {
    const error = findRealJevGateCompatibilityError(
      {
        corpusId: "classification-v1",
        templateVersion: "classification-v1",
        messageCount: 24,
        contentDigest: CLASSIFICATION_CORPUS_CONTENT_DIGEST,
      },
      "classification-v2",
    )!;
    expect(error).toContain("classification-v2");
    expect(error).toContain("template version");
    expect(error.toLowerCase()).toContain("corpus");
  });

  it("reports an invalid corpus instead of running the gate", () => {
    const error = findRealJevGateCompatibilityError(
      {
        corpusId: "classification-v1",
        templateVersion: "classification-v1",
        messageCount: 24,
        contentDigest: "stale-digest",
      },
      "classification-v1",
      ["corpus must contain exactly 24 messages, found 23"],
    )!;
    expect(error).toContain("invalid");
  });

  it("reports an in-place corpus edit through the content digest", () => {
    const error = findRealJevGateCompatibilityError(
      {
        corpusId: "classification-v1",
        templateVersion: "classification-v1",
        messageCount: 24,
        contentDigest: "stale-digest",
      },
      "classification-v1",
    )!;
    expect(error).toContain("digest");
    expect(error).toContain("rerun the complete corpus");
  });
});
