import { isObject, type JevClient } from "./jev-client.js";
import {
  CLASSIFICATION_MODEL,
  OPENROUTER_DECISIONS_URL,
  OpenRouterJevClient,
  type FetchTransport,
} from "./openrouter-jev-client.js";

export { type JevClient } from "./jev-client.js";
export {
  CLASSIFICATION_MODEL,
  OPENROUTER_DECISIONS_URL,
  OpenRouterJevClient,
} from "./openrouter-jev-client.js";

export const CLASSIFICATION_TEMPLATE_VERSION = "classification-v1";
export const DEFAULT_CLASSIFICATION_TIMEOUT_MS = 2500;

export const CLASSIFICATION_TEMPLATE_V1 = {
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
} as const;

export const CAPABILITY_SIGNAL_NAMES = [
  "codeWork",
  "deepReasoning",
  "externalResearch",
] as const;
export type CapabilitySignalName = (typeof CAPABILITY_SIGNAL_NAMES)[number];

export interface CapabilitySignal {
  value: boolean;
  confidence: number;
}

export interface TaskClassificationV1 {
  schemaVersion: 1;
  signals: Record<CapabilitySignalName, CapabilitySignal>;
}

export type ClassificationFailureKind =
  | "configuration"
  | "request_rejected"
  | "authentication"
  | "quota"
  | "rate_limited"
  | "upstream"
  | "timeout"
  | "aborted"
  | "network"
  | "protocol"
  | "unexpected_http";

export interface ClassificationFailure {
  kind: ClassificationFailureKind;
  summary: string;
  status?: number;
  upstreamCode?: string | number;
  retryAfterMs?: number;
  requestId?: string;
}

export type ClassificationResult =
  | { ok: true; classification: TaskClassificationV1 }
  | { ok: false; failure: ClassificationFailure };

export interface ClassificationProvider {
  classify(message: string, options?: { signal?: AbortSignal }): Promise<ClassificationResult>;
}

export interface JevClassificationProviderOptions {
  client: JevClient;
  timeoutMs?: number;
}

interface OpenRouterJevClassificationProviderOptions {
  apiKey: string;
  timeoutMs?: number;
  fetch?: FetchTransport;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function hasValidClassificationTemplate(): boolean {
  if (!hasExactKeys(CLASSIFICATION_TEMPLATE_V1, CAPABILITY_SIGNAL_NAMES)) return false;
  return CAPABILITY_SIGNAL_NAMES.every((name) => {
    const question: unknown = CLASSIFICATION_TEMPLATE_V1[name];
    if (!isObject(question) || !hasExactKeys(question, ["type", "instructions", "criteria"])) return false;
    if (question.type !== "noul" || typeof question.instructions !== "string" || question.instructions.length === 0) {
      return false;
    }
    if (!isObject(question.criteria) || !hasExactKeys(question.criteria, ["true", "false"])) return false;
    return (
      typeof question.criteria.true === "string" &&
      question.criteria.true.length > 0 &&
      typeof question.criteria.false === "string" &&
      question.criteria.false.length > 0
    );
  });
}

function parseProbability(answer: unknown): number | undefined {
  if (!isObject(answer) || answer.type !== "noul") return undefined;
  const probability = answer.noul;
  return typeof probability === "number" && Number.isFinite(probability) && probability >= 0 && probability <= 1
    ? probability
    : undefined;
}

const SAFE_FAILURE_SUMMARIES: Record<ClassificationFailureKind, string> = {
  configuration: "Classification Provider configuration is invalid",
  request_rejected: "Classification request was rejected",
  authentication: "Classification Provider authentication failed",
  quota: "Classification Provider quota was exhausted",
  rate_limited: "Classification request was rate limited",
  upstream: "Classification upstream service failed",
  timeout: "Classification request timed out",
  aborted: "Classification request was cancelled",
  network: "Classification transport failed",
  protocol: "Classification response was invalid",
  unexpected_http: "Classification request returned an unexpected HTTP status",
};

type StopReason = "timeout" | "aborted";

class ClassificationStopped extends Error {
  constructor(readonly reason: StopReason) {
    super(reason);
  }
}

function failure(kind: ClassificationFailureKind): ClassificationResult {
  return { ok: false, failure: { kind, summary: SAFE_FAILURE_SUMMARIES[kind] } };
}

function httpFailureKind(status: number): ClassificationFailureKind {
  if ([400, 404, 413, 422].includes(status)) return "request_rejected";
  if (status === 401 || status === 403) return "authentication";
  if (status === 402) return "quota";
  if (status === 429) return "rate_limited";
  if (status >= 500 && status <= 599) return "upstream";
  return "unexpected_http";
}

function isAbortFailure(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (isObject(error) && error.name === "AbortError")
  );
}

function isNetworkFailure(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (!isObject(error)) return false;
  const code = error.code ?? (isObject(error.cause) ? error.cause.code : undefined);
  return (
    typeof code === "string" &&
    [
      "ECONNABORTED",
      "ECONNREFUSED",
      "ECONNRESET",
      "EHOSTUNREACH",
      "ENETUNREACH",
      "ENOTFOUND",
      "EPIPE",
      "ETIMEDOUT",
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_HEADERS_TIMEOUT",
      "UND_ERR_SOCKET",
    ].includes(code)
  );
}

function parseTaskClassificationResponse(
  value: unknown,
  acceptsModelIdentity: (value: unknown) => boolean,
): TaskClassificationV1 | undefined {
  if (!isObject(value) || !acceptsModelIdentity(value.model)) {
    return undefined;
  }
  if (!isObject(value.usage)) return undefined;
  if (
    typeof value.usage.input_tokens !== "number" ||
    !Number.isSafeInteger(value.usage.input_tokens) ||
    value.usage.input_tokens < 0 ||
    typeof value.usage.output_tokens !== "number" ||
    !Number.isSafeInteger(value.usage.output_tokens) ||
    value.usage.output_tokens < 0
  ) {
    return undefined;
  }
  if (!isObject(value.answers) || !hasExactKeys(value.answers, CAPABILITY_SIGNAL_NAMES)) {
    return undefined;
  }

  const probabilities = {
    codeWork: parseProbability(value.answers.codeWork),
    deepReasoning: parseProbability(value.answers.deepReasoning),
    externalResearch: parseProbability(value.answers.externalResearch),
  };
  if (Object.values(probabilities).some((probability) => probability === undefined)) return undefined;

  const signal = (probability: number): CapabilitySignal => ({
    value: probability >= 0.5,
    confidence: Math.max(probability, 1 - probability),
  });

  return {
    schemaVersion: 1,
    signals: {
      codeWork: signal(probabilities.codeWork!),
      deepReasoning: signal(probabilities.deepReasoning!),
      externalResearch: signal(probabilities.externalResearch!),
    },
  };
}

export class JevClassificationProvider implements ClassificationProvider {
  private readonly client: JevClient;
  private readonly timeoutMs: number;

  constructor(options: JevClassificationProviderOptions) {
    this.client = options.client;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_CLASSIFICATION_TIMEOUT_MS;
  }

  async classify(message: string, options: { signal?: AbortSignal } = {}): Promise<ClassificationResult> {
    if (
      !this.client.isConfigured() ||
      !Number.isFinite(this.timeoutMs) ||
      this.timeoutMs <= 0 ||
      !hasValidClassificationTemplate()
    ) {
      return failure("configuration");
    }
    if (options.signal?.aborted) return failure("aborted");

    const startedAt = Date.now();
    const deadlineAt = startedAt + this.timeoutMs;
    const requestController = new AbortController();
    let stopReason: StopReason | undefined;
    let rejectStop!: (error: ClassificationStopped) => void;
    const stopped = new Promise<never>((_resolve, reject) => {
      rejectStop = reject;
    });
    const stop = (reason: StopReason): void => {
      if (stopReason !== undefined) return;
      stopReason = reason;
      requestController.abort();
      rejectStop(new ClassificationStopped(reason));
    };
    const abort = (): void => stop("aborted");
    options.signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => stop("timeout"), this.timeoutMs);

    const ensureWithinDeadline = (): void => {
      if (options.signal?.aborted) throw new ClassificationStopped("aborted");
      if (Date.now() >= deadlineAt) throw new ClassificationStopped("timeout");
    };

    const request = async (): Promise<ClassificationResult> => {
      ensureWithinDeadline();
      const response = await this.client.evaluate(
        { state: message, questions: CLASSIFICATION_TEMPLATE_V1 },
        { signal: requestController.signal, ensureActive: ensureWithinDeadline },
      );
      ensureWithinDeadline();

      if (!response.ok) {
        const kind = httpFailureKind(response.status);
        return {
          ok: false,
          failure: {
            kind,
            summary: SAFE_FAILURE_SUMMARIES[kind],
            status: response.status,
            ...(response.upstreamCode === undefined
              ? {}
              : { upstreamCode: response.upstreamCode }),
            ...(response.retryAfterMs === undefined
              ? {}
              : { retryAfterMs: response.retryAfterMs }),
            ...(response.requestId === undefined
              ? {}
              : { requestId: response.requestId }),
          },
        };
      }

      if (response.envelope === undefined) return failure("protocol");
      const classification = parseTaskClassificationResponse(
        response.envelope,
        (value) => this.client.acceptsModelIdentity(value),
      );
      ensureWithinDeadline();
      return classification ? { ok: true, classification } : failure("protocol");
    };

    try {
      return await Promise.race([request(), stopped]);
    } catch (error) {
      if (error instanceof ClassificationStopped) return failure(error.reason);
      if (options.signal?.aborted || stopReason === "aborted") return failure("aborted");
      if (stopReason === "timeout" || Date.now() >= deadlineAt) return failure("timeout");
      if (isAbortFailure(error) || isNetworkFailure(error)) return failure("network");
      throw error;
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
    }
  }
}

/**
 * Backward-compatible construction for callers of the pre-seam API. Protocol
 * details live in OpenRouterJevClient; classification behavior lives in the
 * single JevClassificationProvider implementation above. The extension itself
 * wires that pair directly via createClassificationProvider.
 */
export class OpenRouterJevClassificationProvider extends JevClassificationProvider {
  constructor(options: OpenRouterJevClassificationProviderOptions) {
    super({
      client: new OpenRouterJevClient({
        apiKey: options.apiKey,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
  }
}
