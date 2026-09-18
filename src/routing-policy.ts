import type {
  CapabilitySignalName,
  TaskClassificationV1,
} from "./classification-provider.js";
import type { Route } from "./config.js";

export type RoutingPolicyResult =
  | {
      ok: true;
      route: Route;
      relevantSignals: CapabilitySignalName[];
    }
  | {
      ok: false;
      reason: "low_confidence";
      candidateRoute: Route;
      relevantSignals: CapabilitySignalName[];
      lowConfidenceSignals: CapabilitySignalName[];
    };

function candidateRoute(classification: TaskClassificationV1): Route {
  if (classification.signals.externalResearch.value) return "research";
  if (classification.signals.codeWork.value) return "coding";
  if (classification.signals.deepReasoning.value) return "reasoning";
  return "fast";
}

function relevantSignals(route: Route): CapabilitySignalName[] {
  if (route === "research") return ["externalResearch"];
  if (route === "coding") return ["externalResearch", "codeWork"];
  return ["externalResearch", "codeWork", "deepReasoning"];
}

export function selectRoute(
  classification: TaskClassificationV1,
  confidenceThreshold: number,
): RoutingPolicyResult {
  const route = candidateRoute(classification);
  const relevant = relevantSignals(route);
  const lowConfidenceSignals = relevant.filter(
    (name) => classification.signals[name].confidence < confidenceThreshold,
  );

  return lowConfidenceSignals.length === 0
    ? { ok: true, route, relevantSignals: relevant }
    : {
        ok: false,
        reason: "low_confidence",
        candidateRoute: route,
        relevantSignals: relevant,
        lowConfidenceSignals,
      };
}
