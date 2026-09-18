import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  CAPABILITY_SIGNAL_NAMES,
  CLASSIFICATION_TEMPLATE_VERSION,
  OpenRouterJevClassificationProvider,
  type CapabilitySignalName,
  type TaskClassificationV1,
} from "../src/classification-provider.js";
import {
  CLASSIFICATION_BOOLEAN_VECTORS,
  CLASSIFICATION_BOUNDARIES,
  CLASSIFICATION_CORPUS,
  CLASSIFICATION_CORPUS_CONTENT_DIGEST,
  CLASSIFICATION_CORPUS_ID,
  CLASSIFICATION_CORPUS_MANIFEST,
  classificationMatchesExpected,
  validateClassificationCorpus,
  type ClassificationBooleanVector,
  type ClassificationCorpusEntry,
} from "../src/classification-corpus.js";
import { createDecisionsResponse, createTaskClassification } from "./fixtures.js";

function vectorKey(vector: ClassificationBooleanVector): string {
  return CAPABILITY_SIGNAL_NAMES.map((name) => (vector[name] ? "1" : "0")).join("");
}

function brokenEntry(overrides: Record<string, unknown>): ClassificationCorpusEntry {
  return { ...CLASSIFICATION_CORPUS[0]!, ...overrides } as ClassificationCorpusEntry;
}

describe("classification-v1 corpus", () => {
  it("binds the corpus to the current classification template version and content", () => {
    expect(CLASSIFICATION_CORPUS_ID).toBe("classification-v1");
    expect(CLASSIFICATION_TEMPLATE_VERSION).toBe("classification-v1");
    expect(CLASSIFICATION_CORPUS_CONTENT_DIGEST).toBe(
      "d08d16ccaddfcbaebe193c84e810ac42418416da1acd321b0eab4c653611edfe",
    );
    expect(CLASSIFICATION_CORPUS_MANIFEST).toEqual({
      corpusId: "classification-v1",
      templateVersion: CLASSIFICATION_TEMPLATE_VERSION,
      messageCount: 24,
      contentDigest: CLASSIFICATION_CORPUS_CONTENT_DIGEST,
    });
  });

  it("is structurally valid", () => {
    expect(validateClassificationCorpus()).toEqual([]);
  });

  it("contains exactly 24 unique non-empty messages with complete expected vectors", () => {
    expect(CLASSIFICATION_CORPUS).toHaveLength(24);
    expect(new Set(CLASSIFICATION_CORPUS.map((entry) => entry.id)).size).toBe(24);
    expect(new Set(CLASSIFICATION_CORPUS.map((entry) => entry.message)).size).toBe(24);
    for (const entry of CLASSIFICATION_CORPUS) {
      expect(entry.message.trim().length).toBeGreaterThan(0);
      expect(Object.keys(entry.expected).sort()).toEqual([...CAPABILITY_SIGNAL_NAMES].sort());
      for (const name of CAPABILITY_SIGNAL_NAMES) {
        expect(typeof entry.expected[name]).toBe("boolean");
      }
    }
  });

  it("enumerates all eight Boolean Capability Signal combinations", () => {
    expect(CLASSIFICATION_BOOLEAN_VECTORS.map(vectorKey)).toEqual([
      "000",
      "100",
      "010",
      "110",
      "001",
      "101",
      "011",
      "111",
    ]);
  });

  it("covers every Boolean Capability Signal combination with at least two clear examples", () => {
    for (const vector of CLASSIFICATION_BOOLEAN_VECTORS) {
      const clearCount = CLASSIFICATION_CORPUS.filter(
        (entry) => entry.clarity === "clear" && classificationMatchesExpected(entry, createTaskClassification(vector)),
      ).length;
      expect(clearCount).toBeGreaterThanOrEqual(2);
    }
  });

  it("has exactly 22 clear and 2 ambiguous examples", () => {
    expect(CLASSIFICATION_CORPUS.filter((entry) => entry.clarity === "clear")).toHaveLength(22);
    expect(CLASSIFICATION_CORPUS.filter((entry) => entry.clarity === "ambiguous")).toHaveLength(2);
  });

  it.each([
    ["verbosity-not-reasoning", "deepReasoning", false],
    ["software-topic-not-code", "codeWork", false],
    ["local-repo-not-research", "codeWork", true],
    ["local-repo-not-research", "externalResearch", false],
  ] as const)(
    "distinguishes %s with expected.%s = %s on every tagged example",
    (boundary, signalName, expectedValue) => {
      const tagged = CLASSIFICATION_CORPUS.filter((entry) => entry.boundary === boundary);
      expect(tagged.length).toBeGreaterThanOrEqual(2);
      expect(tagged.every((entry) => entry.clarity === "clear")).toBe(true);
      for (const entry of tagged) {
        expect(entry.expected[signalName]).toBe(expectedValue);
      }
    },
  );

  it("keeps ambiguous prompts distinct from confident judgments", () => {
    const ambiguous = CLASSIFICATION_CORPUS.filter((entry) => entry.clarity === "ambiguous");
    expect(ambiguous.map((entry) => entry.id)).toEqual([
      "classification-v1/023",
      "classification-v1/024",
    ]);
    for (const entry of ambiguous) {
      expect(entry.boundary).toBe("ambiguous-low-confidence");
      expect(entry.expected).toEqual({ codeWork: false, deepReasoning: false, externalResearch: false });
    }
  });

  it("rejects a corpus with the wrong message count", () => {
    const errors = validateClassificationCorpus(CLASSIFICATION_CORPUS.slice(0, 23));
    expect(errors).toContain("corpus must contain exactly 24 messages, found 23");
  });

  it("rejects duplicate ids and duplicate messages", () => {
    const duplicated = [CLASSIFICATION_CORPUS[0]!, CLASSIFICATION_CORPUS[1]!, CLASSIFICATION_CORPUS[0]!];
    const errors = validateClassificationCorpus(duplicated);
    expect(errors.some((error) => error.includes("duplicate id"))).toBe(true);
    expect(errors.some((error) => error.includes("duplicates the message"))).toBe(true);
  });

  it("rejects empty messages and invalid clarity values", () => {
    const errors = validateClassificationCorpus([
      brokenEntry({ id: "classification-v1/901", message: "   " }),
      brokenEntry({ id: "classification-v1/902", clarity: "maybe" }),
    ]);
    expect(errors.some((error) => error.includes("classification-v1/901") && error.includes("empty message"))).toBe(true);
    expect(errors.some((error) => error.includes("classification-v1/902") && error.includes("invalid clarity"))).toBe(true);
  });

  it("rejects incomplete or mistyped expected vectors", () => {
    const { externalResearch: _omitted, ...partial } = CLASSIFICATION_CORPUS[0]!.expected;
    const mistyped = { ...CLASSIFICATION_CORPUS[1]!.expected, codeWork: "yes" };
    const errors = validateClassificationCorpus([
      brokenEntry({ id: "classification-v1/903", expected: partial }),
      brokenEntry({ id: "classification-v1/904", expected: mistyped }),
    ]);
    expect(
      errors.some((error) => error.includes("classification-v1/903") && error.includes("externalResearch")),
    ).toBe(true);
    expect(
      errors.some((error) => error.includes("classification-v1/904") && error.includes("non-Boolean")),
    ).toBe(true);
  });

  it("rejects boundary tags that contradict their example", () => {
    const errors = validateClassificationCorpus([
      brokenEntry({ id: "classification-v1/905", boundary: "ambiguous-low-confidence" }),
      brokenEntry({ id: "classification-v1/906", boundary: "local-repo-not-research" }),
      brokenEntry({ id: "classification-v1/907", clarity: "ambiguous", boundary: "verbosity-not-reasoning" }),
      brokenEntry({ id: "classification-v1/908", boundary: "nonsense" }),
    ]);
    expect(errors.some((error) => error.includes("classification-v1/905"))).toBe(true);
    expect(errors.some((error) => error.includes("classification-v1/906"))).toBe(true);
    expect(errors.some((error) => error.includes("classification-v1/907"))).toBe(true);
    expect(errors.some((error) => error.includes("classification-v1/908") && error.includes("unknown boundary"))).toBe(true);
  });

  it("requires a missing boundary category to be reported", () => {
    const withoutLocalRepo = CLASSIFICATION_CORPUS.filter(
      (entry) => entry.boundary !== "local-repo-not-research",
    );
    const errors = validateClassificationCorpus(withoutLocalRepo);
    expect(errors.some((error) => error.includes("local-repo-not-research"))).toBe(true);
  });

  it("treats expected vectors as exact", () => {
    const entry = CLASSIFICATION_CORPUS[0]!;
    expect(classificationMatchesExpected(entry, createTaskClassification(entry.expected))).toBe(true);
    expect(
      classificationMatchesExpected(entry, createTaskClassification({ ...entry.expected, externalResearch: true })),
    ).toBe(false);
  });

  it("declares every canonical triage boundary", () => {
    expect([...CLASSIFICATION_BOUNDARIES]).toEqual([
      "verbosity-not-reasoning",
      "software-topic-not-code",
      "local-repo-not-research",
      "ambiguous-low-confidence",
    ]);
  });
});

describe("classification-v1 corpus deterministic provider round trip", () => {
  it.each(CLASSIFICATION_CORPUS)("$id yields the expected Boolean vector through the Provider", async (entry) => {
    const probabilities = {
      codeWork: entry.expected.codeWork ? 0.9 : 0.1,
      deepReasoning: entry.expected.deepReasoning ? 0.9 : 0.1,
      externalResearch: entry.expected.externalResearch ? 0.9 : 0.1,
    };
    const classificationProvider = new OpenRouterJevClassificationProvider({
      apiKey: "secret-key",
      fetch: async () => createDecisionsResponse(probabilities),
    });

    const result = await classificationProvider.classify(entry.message);
    if (!result.ok) throw new Error(`unexpected provider failure: ${result.failure.kind}`);

    expect(Object.keys(result.classification).sort()).toEqual(["schemaVersion", "signals"]);
    expect(result.classification.schemaVersion).toBe(1);
    expect(Object.keys(result.classification.signals).sort()).toEqual([...CAPABILITY_SIGNAL_NAMES].sort());
    for (const name of CAPABILITY_SIGNAL_NAMES) {
      const signal = result.classification.signals[name];
      expect(Object.keys(signal).sort()).toEqual(["confidence", "value"]);
      expect(signal.value).toBe(entry.expected[name]);
      expect(Number.isFinite(signal.confidence)).toBe(true);
      expect(signal.confidence).toBeGreaterThanOrEqual(0);
      expect(signal.confidence).toBeLessThanOrEqual(1);
    }
    expect(classificationMatchesExpected(entry, result.classification)).toBe(true);
  });

  it("keeps confidence validity at the Boolean boundary without pinning continuous probabilities", async () => {
    const classificationProvider = new OpenRouterJevClassificationProvider({
      apiKey: "secret-key",
      fetch: async () => createDecisionsResponse({ codeWork: 0.5, deepReasoning: 0.5, externalResearch: 0.5 }),
    });

    const result = await classificationProvider.classify(CLASSIFICATION_CORPUS[0]!.message);
    if (!result.ok) throw new Error(`unexpected provider failure: ${result.failure.kind}`);

    for (const name of CAPABILITY_SIGNAL_NAMES) {
      expect(result.classification.signals[name]).toEqual({ value: true, confidence: 0.5 });
    }
  });
});

describe("real Jev gate stays out of default CI", () => {
  it("keeps the default test script and vitest include free of the gate", () => {
    const root = new URL("../", import.meta.url);
    const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as {
      scripts: Record<string, string | undefined>;
    };
    expect(pkg.scripts.test).toBe("vitest run");
    expect(pkg.scripts["test:real-jev-gate"]?.includes("vitest.real-jev-gate.config.ts")).toBe(true);

    const defaultConfig = readFileSync(new URL("vitest.config.ts", root), "utf8");
    const defaultInclude = /include:\s*\[[^\]]*\]/.exec(defaultConfig)?.[0] ?? "";
    expect(defaultInclude).toContain('"test/**/*.test.ts"');
    expect(defaultInclude).not.toContain("gates");

    const gateConfig = readFileSync(new URL("vitest.real-jev-gate.config.ts", root), "utf8");
    expect(/include:\s*\[[^\]]*\]/.exec(gateConfig)?.[0]).toContain('"gates/**/*.test.ts"');

    // The gate file itself exists; it is reachable only through the explicit script above.
    readFileSync(new URL("gates/real-jev-compatibility.test.ts", root), "utf8");
  });
});
