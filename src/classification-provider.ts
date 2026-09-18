export const OPENROUTER_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
export const CLASSIFICATION_MODEL = "typesafe/jev-1.13";
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

type FetchTransport = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface ClassificationProviderOptions {
  apiKey: string;
  timeoutMs?: number;
  fetch?: FetchTransport;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function exposesSensitiveValue(candidate: string, sensitiveValues: readonly string[]): boolean {
  return sensitiveValues.some((sensitiveValue) =>
    sensitiveValue.length > 0 &&
    (candidate.includes(sensitiveValue) ||
      (candidate.length >= 8 && sensitiveValue.includes(candidate))),
  );
}

function safeUpstreamCode(
  value: unknown,
  sensitiveValues: readonly string[],
): string | number | undefined {
  if (!isObject(value) || !isObject(value.error)) return undefined;
  const code = value.error.code;
  if (
    typeof code === "string" &&
    /^[A-Za-z0-9._:-]{1,128}$/.test(code) &&
    !exposesSensitiveValue(code, sensitiveValues)
  ) {
    return code;
  }
  return typeof code === "number" &&
    Number.isSafeInteger(code) &&
    !exposesSensitiveValue(String(code), sensitiveValues)
    ? code
    : undefined;
}

function safeRetryAfterMs(headers: Headers): number | undefined {
  const value = headers.get("retry-after");
  if (value === null || !/^\d+$/.test(value.trim())) return undefined;
  const milliseconds = Number(value.trim()) * 1000;
  return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
}

function safeRequestId(
  headers: Headers,
  sensitiveValues: readonly string[],
): string | undefined {
  const value = headers.get("x-request-id");
  return value &&
    /^[A-Za-z0-9._:-]{1,256}$/.test(value) &&
    !exposesSensitiveValue(value, sensitiveValues)
    ? value
    : undefined;
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

function parseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function isClassificationModelIdentity(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value === CLASSIFICATION_MODEL) return true;
  const canonicalPrefix = `${CLASSIFICATION_MODEL}-`;
  return value.startsWith(canonicalPrefix) &&
    /^\d{8}$/.test(value.slice(canonicalPrefix.length));
}

function parseTaskClassificationResponse(value: unknown): TaskClassificationV1 | undefined {
  if (!isObject(value) || !isClassificationModelIdentity(value.model)) {
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

export class OpenRouterJevClassificationProvider implements ClassificationProvider {
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly transport: FetchTransport;

  constructor(options: ClassificationProviderOptions) {
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_CLASSIFICATION_TIMEOUT_MS;
    this.transport = options.fetch ?? globalThis.fetch;
  }

  async classify(message: string, options: { signal?: AbortSignal } = {}): Promise<ClassificationResult> {
    if (
      this.apiKey.trim().length === 0 ||
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
      const requestBody = JSON.stringify({
        model: CLASSIFICATION_MODEL,
        state: message,
        questions: CLASSIFICATION_TEMPLATE_V1,
        provider: { zdr: true },
      });
      ensureWithinDeadline();
      const response = await this.transport(OPENROUTER_DECISIONS_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: requestBody,
        signal: requestController.signal,
      });
      const responseText = await response.text();
      ensureWithinDeadline();
      const body = parseJson(responseText);
      ensureWithinDeadline();

      if (!response.ok) {
        const kind = httpFailureKind(response.status);
        const sensitiveValues = [this.apiKey, message];
        const upstreamCode = safeUpstreamCode(body, sensitiveValues);
        const retryAfterMs = safeRetryAfterMs(response.headers);
        const requestId = safeRequestId(response.headers, sensitiveValues);
        return {
          ok: false,
          failure: {
            kind,
            summary: SAFE_FAILURE_SUMMARIES[kind],
            status: response.status,
            ...(upstreamCode === undefined ? {} : { upstreamCode }),
            ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
            ...(requestId === undefined ? {} : { requestId }),
          },
        };
      }

      if (body === undefined) return failure("protocol");
      const classification = parseTaskClassificationResponse(body);
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
