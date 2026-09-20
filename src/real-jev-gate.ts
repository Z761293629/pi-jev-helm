import {
  CLASSIFICATION_MODEL,
  CLASSIFICATION_TEMPLATE_VERSION,
  type ClassificationResult,
} from "./classification-provider.js";
import { TYPESAFE_CLASSIFICATION_MODEL } from "./typesafe-jev-client.js";
import {
  CLASSIFICATION_CORPUS,
  CLASSIFICATION_CORPUS_MANIFEST,
  classificationCorpusContentDigest,
  classificationMatchesExpected,
  validateClassificationCorpus,
  type ClassificationCorpusEntry,
  type ClassificationCorpusManifest,
} from "./classification-corpus.js";
import { selectRoute } from "./routing-policy.js";

/**
 * Real Jev compatibility gate, one leg per Jev Client.
 *
 * The gate validates the live Jev service against the versioned
 * classification corpus — an OpenRouter leg through the OpenRouter Jev Client
 * (`typesafe/jev-1.13`) and a TypeSafe leg through the official TypeSafe SDK
 * (`jev-1.13.0`) — under the same corpus, confidence threshold, execution
 * count, and per-message two-of-three rule. Each leg runs only when its own
 * credential (`OPENROUTER_API_KEY` / `TYPESAFE_API_KEY`) is present; a missing
 * credential skips its leg explicitly instead of passing it. The gate is
 * never run by default CI: it must be invoked explicitly with
 * `npm run test:real-jev-gate` and performs paid external requests.
 */

/** The OpenRouter leg's fixed model identity (`typesafe/jev-1.13`). */
export const REAL_JEV_GATE_OPENROUTER_MODEL = CLASSIFICATION_MODEL;
export const REAL_JEV_GATE_TYPESAFE_MODEL = TYPESAFE_CLASSIFICATION_MODEL;
export const REAL_JEV_GATE_CONFIDENCE_THRESHOLD = 0.75;
export const REAL_JEV_GATE_EXECUTIONS_PER_MESSAGE = 3;
export const REAL_JEV_GATE_REQUIRED_PASSES = 2;
export const OPENROUTER_API_KEY_ENV = "OPENROUTER_API_KEY";
export const TYPESAFE_API_KEY_ENV = "TYPESAFE_API_KEY";

export type RealJevGateCredentialResolution =
  | { ok: true; apiKey: string }
  | { ok: false; error: string };

function resolveGateCredential(
  envVarName: string,
  missingCredentialError: string,
  env: Readonly<Record<string, string | undefined>>,
): RealJevGateCredentialResolution {
  const apiKey = env[envVarName];
  if (apiKey === undefined || apiKey.trim().length === 0) return { ok: false, error: missingCredentialError };
  return { ok: true, apiKey };
}

/** Resolves the OpenRouter leg's credential from an explicit environment mapping. Pure; no network access. */
export function resolveRealJevGateOpenRouterApiKey(
  env: Readonly<Record<string, string | undefined>>,
): RealJevGateCredentialResolution {
  return resolveGateCredential(
    OPENROUTER_API_KEY_ENV,
    `The real Jev compatibility gate requires credentials for its OpenRouter leg: set ${OPENROUTER_API_KEY_ENV} in the environment, ` +
      "then invoke the gate explicitly with: npm run test:real-jev-gate. " +
      "The OpenRouter leg performs paid external OpenRouter requests and is never run by default CI or npm test.",
    env,
  );
}

/** Resolves the TypeSafe leg's credential from an explicit environment mapping. Pure; no network access. */
export function resolveRealJevGateTypesafeApiKey(
  env: Readonly<Record<string, string | undefined>>,
): RealJevGateCredentialResolution {
  return resolveGateCredential(
    TYPESAFE_API_KEY_ENV,
    `The real Jev compatibility gate requires credentials for its TypeSafe leg: set ${TYPESAFE_API_KEY_ENV} in the environment, ` +
      "then invoke the gate explicitly with: npm run test:real-jev-gate. " +
      "The TypeSafe leg performs paid external TypeSafe requests against the pinned jev-1.13.0 model and is never run by default CI or npm test.",
    env,
  );
}

/** Per-leg credential resolutions for the real Jev compatibility gate. */
export interface RealJevGateLegCredentials {
  openrouter: RealJevGateCredentialResolution;
  typesafe: RealJevGateCredentialResolution;
}

/** Resolves both legs' credentials from an explicit environment mapping. Pure; no network access. */
export function resolveRealJevGateLegCredentials(
  env: Readonly<Record<string, string | undefined>>,
): RealJevGateLegCredentials {
  return {
    openrouter: resolveRealJevGateOpenRouterApiKey(env),
    typesafe: resolveRealJevGateTypesafeApiKey(env),
  };
}

/**
 * Returns why the explicit gate invocation cannot certify any leg and must
 * fail its collection before any network access: with no usable credential
 * for either leg, every leg would be skipped and the run would pass without
 * producing any certification evidence.
 */
export function findRealJevGateCredentialError(
  legs: RealJevGateLegCredentials,
): string | undefined {
  if (legs.openrouter.ok || legs.typesafe.ok) return undefined;
  return (
    `The real Jev compatibility gate requires credentials for at least one leg: set ${OPENROUTER_API_KEY_ENV} ` +
    `to certify the OpenRouter leg and/or ${TYPESAFE_API_KEY_ENV} to certify the TypeSafe leg, ` +
    "then invoke the gate explicitly with: npm run test:real-jev-gate. " +
    "The gate performs paid external requests and is never run by default CI or npm test; " +
    "a leg without its credential is skipped, so a run without any credential certifies nothing."
  );
}

export interface RealJevGateExecutionVerdict {
  passed: boolean;
  /** Deterministic, safe reason. Never contains user message content. */
  reason: string;
}

/**
 * Evaluates one independent execution of one corpus message against the
 * expected Boolean vector and the Routing Policy threshold.
 *
 * Clear examples pass only when the complete expected Boolean vector is
 * produced and every decision-relevant confidence meets the threshold.
 * Ambiguous examples pass only when the expected vector is produced and the
 * Routing Policy fails open for insufficient relevant confidence.
 */
export function evaluateRealJevGateExecution(
  entry: ClassificationCorpusEntry,
  result: ClassificationResult,
): RealJevGateExecutionVerdict {
  if (!result.ok) {
    return { passed: false, reason: `provider_failure:${result.failure.kind}` };
  }
  if (!classificationMatchesExpected(entry, result.classification)) {
    return { passed: false, reason: "boolean_vector_did_not_match_expected" };
  }
  const decision = selectRoute(result.classification, REAL_JEV_GATE_CONFIDENCE_THRESHOLD);
  if (entry.clarity === "clear") {
    return decision.ok
      ? { passed: true, reason: "boolean_vector_matched_and_relevant_confidences_met_threshold" }
      : {
          passed: false,
          reason: `relevant_confidence_below_threshold:${decision.lowConfidenceSignals.join("+")}`,
        };
  }
  return !decision.ok
    ? {
        passed: true,
        reason: `boolean_vector_matched_and_policy_failed_open_for_low_confidence:${decision.lowConfidenceSignals.join("+")}`,
      }
    : { passed: false, reason: "policy_selected_a_route_instead_of_failing_open" };
}

export interface RealJevGateMessageVerdict {
  entryId: string;
  clarity: ClassificationCorpusEntry["clarity"];
  executions: RealJevGateExecutionVerdict[];
  passedExecutions: number;
  requiredPasses: number;
  passed: boolean;
}

/**
 * Applies the per-message two-of-three rule: a message passes only when at
 * least two of its independent executions pass. No aggregate pass rate is
 * computed; every message is judged on its own executions.
 */
export function evaluateRealJevGateMessage(
  entry: ClassificationCorpusEntry,
  executions: readonly ClassificationResult[],
): RealJevGateMessageVerdict {
  if (executions.length !== REAL_JEV_GATE_EXECUTIONS_PER_MESSAGE) {
    throw new Error(
      `The real Jev gate requires exactly ${REAL_JEV_GATE_EXECUTIONS_PER_MESSAGE} independent executions per message, received ${executions.length}`,
    );
  }
  const verdicts = executions.map((result) => evaluateRealJevGateExecution(entry, result));
  const passedExecutions = verdicts.filter((verdict) => verdict.passed).length;
  return {
    entryId: entry.id,
    clarity: entry.clarity,
    executions: verdicts,
    passedExecutions,
    requiredPasses: REAL_JEV_GATE_REQUIRED_PASSES,
    passed: passedExecutions >= REAL_JEV_GATE_REQUIRED_PASSES,
  };
}

/**
 * Returns why the gate must not run against the current corpus and template,
 * or undefined when the shipped corpus matches the shipped template version
 * and content digest.
 */
export function findRealJevGateCompatibilityError(
  manifest: ClassificationCorpusManifest = CLASSIFICATION_CORPUS_MANIFEST,
  templateVersion: string = CLASSIFICATION_TEMPLATE_VERSION,
  corpusErrors: readonly string[] = validateClassificationCorpus(),
  contentDigest: string = classificationCorpusContentDigest(),
): string | undefined {
  if (corpusErrors.length > 0) {
    return `The classification corpus ${manifest.corpusId} is invalid: ${corpusErrors.join("; ")}`;
  }
  if (manifest.contentDigest !== contentDigest) {
    return (
      `The classification corpus content does not match the recorded manifest digest ` +
      `(expected ${manifest.contentDigest}, found ${contentDigest}). ` +
      "The corpus changed in place: create a new corpus version and rerun the complete corpus " +
      "before the real Jev gate may run."
    );
  }
  if (manifest.templateVersion !== templateVersion) {
    return (
      `The classification corpus ${manifest.corpusId} was built for template version ` +
      `${manifest.templateVersion}, but the current template version is ${templateVersion}. ` +
      "Any substantive template change requires a new template version plus a complete corpus rerun " +
      "before the real Jev gate may run."
    );
  }
  if (manifest.messageCount !== CLASSIFICATION_CORPUS.length) {
    return (
      `The classification corpus manifest records ${manifest.messageCount} messages, ` +
      `but the corpus contains ${CLASSIFICATION_CORPUS.length}. Rerun the complete corpus.`
    );
  }
  return undefined;
}

/** Throws when the gate may not run, so no paid request is ever attempted on an invalid pairing. */
export function assertRealJevGateCompatibility(): void {
  const error = findRealJevGateCompatibilityError();
  if (error !== undefined) throw new Error(error);
}
