import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type {
  CapabilitySignalName,
  ClassificationFailureKind,
} from "./classification-provider.js";
import type { ClassificationProviderSelection, Route, ThinkingLevel } from "./config.js";

export const ROUTING_EXPLANATION_ENTRY_TYPE = "pi-jev-helm-routing-explanation";
export const ROUTING_EXPLANATION_SCHEMA_VERSION = 1;

export interface ExplainedSignal {
  name: CapabilitySignalName;
  value: boolean;
  confidence: number;
}

export interface ExplainedConfidenceCheck {
  threshold: number;
  relevantSignals: CapabilitySignalName[];
  failedSignals: CapabilitySignalName[];
}

export interface ExplainedModel {
  provider: string;
  model: string;
}

export interface ExplainedModelWithThinking extends ExplainedModel {
  thinkingLevel: ThinkingLevel;
}

export type RouteSource = "automatic" | "route-override";

/**
 * The Jev Client that classified (or whose unavailability failed the attempt
 * open). Recorded only on automatic attempts: a Route Override bypasses Task
 * Classification entirely.
 */
export type JevClientIdentity = ClassificationProviderSelection;

export interface AttemptClassification {
  signals: ExplainedSignal[];
  confidenceCheck?: ExplainedConfidenceCheck;
  policyBranch?: { candidateRoute: Route };
}

export interface ExplanationAttempt {
  runId: string;
  source: RouteSource;
  jevClient?: JevClientIdentity;
  classification?: AttemptClassification;
}

export type FailOpenReason =
  | "baseline-unavailable"
  | "checkpoint-unavailable"
  | "provider-unavailable"
  | "classification-failed"
  | "classification-aborted"
  | "low-confidence"
  | "target-unavailable"
  | "target-apply-failed"
  | "target-thinking-apply-failed"
  | "superseded-by-explicit-choice"
  | "unexpected-error";

export interface ExplainedFailOpen {
  reason: FailOpenReason;
  baselineRetained: boolean;
  classification?: {
    kind: ClassificationFailureKind;
    status?: number;
  };
}

export type RoutingAttemptExplanation = {
  schemaVersion: typeof ROUTING_EXPLANATION_SCHEMA_VERSION;
  kind: "routing-attempt";
  runId: string;
  source: RouteSource;
  jevClient?: JevClientIdentity;
  outcome: "routed" | "fail-open";
  restorationRequired: boolean;
  baseline?: ExplainedModelWithThinking;
  appliedModel?: ExplainedModel;
  appliedThinkingLevel?: ThinkingLevel;
} & (
  | {
      outcome: "routed";
      route: Route;
      signals?: ExplainedSignal[];
      confidenceCheck?: ExplainedConfidenceCheck;
      policyBranch?: { candidateRoute: Route };
      target: ExplainedModelWithThinking;
      failOpen?: undefined;
    }
  | {
      outcome: "fail-open";
      route?: Route;
      signals?: ExplainedSignal[];
      confidenceCheck?: ExplainedConfidenceCheck;
      policyBranch?: { candidateRoute: Route };
      target?: ExplainedModelWithThinking;
      failOpen: ExplainedFailOpen;
    }
);

export interface ExplicitOverrideExplanation {
  schemaVersion: typeof ROUTING_EXPLANATION_SCHEMA_VERSION;
  kind: "explicit-override";
  runId: string;
  override:
    | { kind: "model"; model: ExplainedModel; thinkingLevel: ThinkingLevel }
    | { kind: "thinking"; thinkingLevel: ThinkingLevel };
  baseline: ExplainedModelWithThinking;
}

export interface RestorationExplanation {
  schemaVersion: typeof ROUTING_EXPLANATION_SCHEMA_VERSION;
  kind: "restoration";
  runId: string;
  outcome: "restored" | "failed" | "superseded";
  baseline?: ExplainedModelWithThinking;
}

export type RoutingExplanationEntry =
  | RoutingAttemptExplanation
  | ExplicitOverrideExplanation
  | RestorationExplanation;

export function recordRoutingExplanation(
  pi: ExtensionAPI,
  entry: RoutingExplanationEntry,
): void {
  try {
    pi.appendEntry(ROUTING_EXPLANATION_ENTRY_TYPE, entry);
  } catch {
    // Explanation recording must never block or fail a routing attempt.
  }
}

function isRoutingAttemptExplanation(value: Record<string, unknown>): boolean {
  if (value.source !== "automatic" && value.source !== "route-override") return false;
  if (value.outcome !== "routed" && value.outcome !== "fail-open") return false;
  if (typeof value.restorationRequired !== "boolean") return false;
  if (value.outcome === "fail-open") {
    const failOpen = value.failOpen as ExplainedFailOpen | undefined;
    if (typeof failOpen !== "object" || failOpen === null || typeof failOpen.reason !== "string") {
      return false;
    }
  }
  return true;
}

export function isRoutingExplanationEntry(value: unknown): value is RoutingExplanationEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.schemaVersion !== ROUTING_EXPLANATION_SCHEMA_VERSION) return false;
  if (typeof candidate.runId !== "string" || candidate.runId.length === 0) return false;
  if (candidate.kind === "routing-attempt") return isRoutingAttemptExplanation(candidate);
  if (candidate.kind === "explicit-override") {
    const override = candidate.override as ExplicitOverrideExplanation["override"] | undefined;
    if (typeof override !== "object" || override === null) return false;
    if (override.kind === "model") {
      return typeof override.model === "object" && typeof override.thinkingLevel === "string";
    }
    return override.kind === "thinking" && typeof override.thinkingLevel === "string";
  }
  if (candidate.kind === "restoration") {
    return (
      candidate.outcome === "restored" ||
      candidate.outcome === "failed" ||
      candidate.outcome === "superseded"
    );
  }
  return false;
}

export interface SelectedRoutingExplanation {
  attempt: RoutingAttemptExplanation;
  overrides: ExplicitOverrideExplanation[];
  restoration?: RestorationExplanation;
}

interface BranchEntry {
  type: string;
  customType?: string;
  data?: unknown;
}

/**
 * Select the Route of the most recent routing attempt that actually took a
 * Route on the current branch. Attempts that failed open before selecting a
 * Route (for example low confidence) are skipped so the result stays the last
 * Route that was in effect, keeping the answer branch-aware like the
 * explanation selectors.
 */
export function selectBranchRecentRoute(branch: readonly BranchEntry[]): Route | undefined {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry?.type !== "custom" || entry.customType !== ROUTING_EXPLANATION_ENTRY_TYPE) continue;
    if (!isRoutingExplanationEntry(entry.data) || entry.data.kind !== "routing-attempt") continue;
    if (entry.data.route) return entry.data.route;
  }
  return undefined;
}

/**
 * Select the most recent applicable routing explanation on the current branch.
 * Custom entries are stored on the conversation branch, so scanning the branch
 * keeps only the explanations that apply to the selected conversation path.
 */
export function selectBranchRoutingExplanation(
  branch: readonly BranchEntry[],
): SelectedRoutingExplanation | undefined {
  let attempt: RoutingAttemptExplanation | undefined;
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry?.type !== "custom" || entry.customType !== ROUTING_EXPLANATION_ENTRY_TYPE) continue;
    if (!isRoutingExplanationEntry(entry.data) || entry.data.kind !== "routing-attempt") continue;
    attempt = entry.data;
    break;
  }
  if (!attempt) return undefined;

  const overrides: ExplicitOverrideExplanation[] = [];
  let restoration: RestorationExplanation | undefined;
  for (let index = 0; index < branch.length; index += 1) {
    const entry = branch[index];
    if (entry?.type !== "custom" || entry.customType !== ROUTING_EXPLANATION_ENTRY_TYPE) continue;
    if (!isRoutingExplanationEntry(entry.data) || entry.data.runId !== attempt.runId) continue;
    if (entry.data.kind === "explicit-override") overrides.push(entry.data);
    if (entry.data.kind === "restoration") restoration = entry.data;
  }

  return {
    attempt,
    overrides,
    ...(restoration ? { restoration } : {}),
  };
}

export function formatSource(source: RouteSource): string {
  return source === "automatic" ? "Automatic Routing" : "Route Override";
}

function formatModelWithThinking(model: ExplainedModelWithThinking): string {
  return `${model.provider}/${model.model} (thinking ${model.thinkingLevel})`;
}

function formatSignal(signal: ExplainedSignal): string {
  return `${signal.name}=${signal.value ? "yes" : "no"} (confidence ${signal.confidence})`;
}

export function formatRoutingExplanation(selected: SelectedRoutingExplanation): string {
  const { attempt, overrides, restoration } = selected;
  const lines: string[] = ["Pi Jev Helm — Routing Explanation (read-only)"];

  lines.push(`Attempt: ${formatSource(attempt.source)}`);
  if (attempt.outcome === "routed") {
    lines.push(`Route: ${attempt.route}`);
  } else {
    lines.push(
      `Route: ${attempt.route ?? "not selected"} — fail-open (${attempt.failOpen.reason})`,
    );
  }

  if (attempt.jevClient) {
    lines.push(`Jev Client: ${attempt.jevClient}`);
  }
  if (attempt.signals?.length) {
    lines.push(`Capability Signals: ${attempt.signals.map(formatSignal).join(", ")}`);
  }
  if (attempt.confidenceCheck) {
    const check = attempt.confidenceCheck;
    const outcome =
      check.failedSignals.length === 0
        ? "passed"
        : `failed (${check.failedSignals.join(", ")})`;
    lines.push(
      `Confidence: threshold ${check.threshold}, checked ${check.relevantSignals.join(", ")} — ${outcome}`,
    );
  }
  if (attempt.policyBranch) {
    lines.push(`Policy branch: candidate Route ${attempt.policyBranch.candidateRoute}`);
  }
  if (attempt.target) {
    lines.push(`Route Target: ${formatModelWithThinking(attempt.target)}`);
  }
  if (attempt.baseline) {
    lines.push(`Baseline: ${formatModelWithThinking(attempt.baseline)}`);
  }
  if (attempt.appliedModel) {
    lines.push(
      `Applied model: ${attempt.appliedModel.provider}/${attempt.appliedModel.model}${
        attempt.appliedThinkingLevel ? ` (thinking ${attempt.appliedThinkingLevel})` : ""
      }`,
    );
  }
  if (attempt.outcome === "fail-open") {
    const classification = attempt.failOpen.classification;
    lines.push(
      `Fail-open: ${attempt.failOpen.reason} — Baseline retained: ${
        attempt.failOpen.baselineRetained ? "yes" : "no"
      }${classification ? `; classification failure kind ${classification.kind}${classification.status === undefined ? "" : ` (HTTP ${classification.status})`}` : ""}`,
    );
  }

  if (overrides.length > 0) {
    lines.push(
      `Overrides: ${overrides
        .map((entry) =>
          entry.override.kind === "model"
            ? `model → ${entry.override.model.provider}/${entry.override.model.model} (thinking ${entry.override.thinkingLevel})`
            : `thinking → ${entry.override.thinkingLevel}`,
        )
        .join("; ")}`,
    );
  } else {
    lines.push("Overrides: none");
  }

  if (restoration) {
    if (restoration.outcome === "failed") {
      lines.push("Restoration: failed");
    } else if (restoration.outcome === "superseded") {
      lines.push("Restoration: superseded by an explicit model override");
    } else if (restoration.baseline) {
      lines.push(`Restoration: restored to ${formatModelWithThinking(restoration.baseline)}`);
    } else {
      lines.push("Restoration: restored");
    }
  } else if (!attempt.restorationRequired) {
    lines.push("Restoration: not needed (Baseline retained)");
  } else {
    lines.push("Restoration: pending");
  }

  return lines.join("\n");
}
