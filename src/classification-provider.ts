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

export type ClassificationFailureKind = "configuration" | "network" | "protocol";

export type ClassificationResult =
  | { ok: true; classification: TaskClassificationV1 }
  | { ok: false; failure: { kind: ClassificationFailureKind; summary: string; status?: number } };

export interface ClassificationProvider {
  classify(message: string, options?: { signal?: AbortSignal }): Promise<ClassificationResult>;
}

type FetchTransport = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface ProviderOptions {
  apiKey: string;
  timeoutMs?: number;
  fetch?: FetchTransport;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseProbability(answer: unknown): number | undefined {
  if (!isObject(answer) || answer.type !== "noul") return undefined;
  const probability = answer.noul;
  return typeof probability === "number" && Number.isFinite(probability) && probability >= 0 && probability <= 1
    ? probability
    : undefined;
}

function parseTaskClassificationResponse(value: unknown): TaskClassificationV1 | undefined {
  if (!isObject(value) || typeof value.model !== "string" || value.model.length === 0) return undefined;
  if (!isObject(value.usage)) return undefined;
  if (
    typeof value.usage.input_tokens !== "number" ||
    !Number.isFinite(value.usage.input_tokens) ||
    typeof value.usage.output_tokens !== "number" ||
    !Number.isFinite(value.usage.output_tokens)
  ) {
    return undefined;
  }
  if (!isObject(value.answers)) return undefined;
  const answerKeys = Object.keys(value.answers).sort();
  const expectedKeys = [...CAPABILITY_SIGNAL_NAMES].sort();
  if (answerKeys.length !== expectedKeys.length || answerKeys.some((key, index) => key !== expectedKeys[index])) {
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

  constructor(options: ProviderOptions) {
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_CLASSIFICATION_TIMEOUT_MS;
    this.transport = options.fetch ?? globalThis.fetch;
  }

  async classify(message: string, options: { signal?: AbortSignal } = {}): Promise<ClassificationResult> {
    if (this.apiKey.length === 0 || !Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      return {
        ok: false,
        failure: { kind: "configuration", summary: "Classification Provider configuration is invalid" },
      };
    }

    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
    let response: Response;
    try {
      response = await this.transport(OPENROUTER_DECISIONS_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: CLASSIFICATION_MODEL,
          state: message,
          questions: CLASSIFICATION_TEMPLATE_V1,
          provider: { zdr: true },
        }),
        signal,
      });
    } catch {
      return {
        ok: false,
        failure: { kind: "network", summary: "Classification request failed" },
      };
    }

    if (!response.ok) {
      return {
        ok: false,
        failure: {
          kind: "network",
          summary: "Classification request failed",
          status: response.status,
        },
      };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return {
        ok: false,
        failure: { kind: "protocol", summary: "Classification response was invalid" },
      };
    }

    const classification = parseTaskClassificationResponse(body);
    return classification
      ? { ok: true, classification }
      : {
          ok: false,
          failure: { kind: "protocol", summary: "Classification response was invalid" },
        };
  }
}
