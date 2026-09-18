import { describe, expect, it } from "vitest";

import type {
  CapabilitySignalName,
  TaskClassificationV1,
} from "../src/classification-provider.js";
import { selectRoute } from "../src/routing-policy.js";

type CapabilityValues = Record<CapabilitySignalName, boolean>;

function classification(
  values: CapabilityValues,
  confidences: Partial<Record<CapabilitySignalName, number>> = {},
): TaskClassificationV1 {
  return {
    schemaVersion: 1,
    signals: {
      codeWork: { value: values.codeWork, confidence: confidences.codeWork ?? 1 },
      deepReasoning: { value: values.deepReasoning, confidence: confidences.deepReasoning ?? 1 },
      externalResearch: {
        value: values.externalResearch,
        confidence: confidences.externalResearch ?? 1,
      },
    },
  };
}

describe("Routing Policy", () => {
  it.each([
    [{ codeWork: false, deepReasoning: false, externalResearch: false }, "fast"],
    [{ codeWork: false, deepReasoning: true, externalResearch: false }, "reasoning"],
    [{ codeWork: true, deepReasoning: false, externalResearch: false }, "coding"],
    [{ codeWork: true, deepReasoning: true, externalResearch: false }, "coding"],
    [{ codeWork: false, deepReasoning: false, externalResearch: true }, "research"],
    [{ codeWork: false, deepReasoning: true, externalResearch: true }, "research"],
    [{ codeWork: true, deepReasoning: false, externalResearch: true }, "research"],
    [{ codeWork: true, deepReasoning: true, externalResearch: true }, "research"],
  ] as const)("selects %j as %s", (values, expectedRoute) => {
    expect(selectRoute(classification(values), 0.75)).toMatchObject({
      ok: true,
      route: expectedRoute,
    });
  });

  it.each([
    [
      { codeWork: true, deepReasoning: true, externalResearch: true },
      ["externalResearch"],
    ],
    [
      { codeWork: true, deepReasoning: true, externalResearch: false },
      ["externalResearch", "codeWork"],
    ],
    [
      { codeWork: false, deepReasoning: true, externalResearch: false },
      ["externalResearch", "codeWork", "deepReasoning"],
    ],
    [
      { codeWork: false, deepReasoning: false, externalResearch: false },
      ["externalResearch", "codeWork", "deepReasoning"],
    ],
  ] as const)("checks only decision-relevant signals for %j", (values, relevantSignals) => {
    const relevant = relevantSignals as readonly CapabilitySignalName[];
    const confidences = {
      codeWork: relevant.includes("codeWork") ? 0.75 : 0,
      deepReasoning: relevant.includes("deepReasoning") ? 0.75 : 0,
      externalResearch: relevant.includes("externalResearch") ? 0.75 : 0,
    };

    expect(selectRoute(classification(values, confidences), 0.75)).toMatchObject({
      ok: true,
      relevantSignals,
    });
  });

  it("fails directly when a decision-relevant confidence is below the threshold", () => {
    const result = selectRoute(
      classification({ codeWork: true, deepReasoning: true, externalResearch: false }, {
        externalResearch: 0.749,
        codeWork: 1,
        deepReasoning: 1,
      }),
      0.75,
    );

    expect(result).toEqual({
      ok: false,
      reason: "low_confidence",
      candidateRoute: "coding",
      relevantSignals: ["externalResearch", "codeWork"],
      lowConfidenceSignals: ["externalResearch"],
    });
  });
});
