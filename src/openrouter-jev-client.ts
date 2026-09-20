import {
  isObject,
  safeFailureMetadata,
  type FetchTransport,
  type JevClient,
  type JevClientRequest,
  type JevClientRequestOptions,
  type JevClientResponse,
} from "./jev-client.js";

export const OPENROUTER_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
export const CLASSIFICATION_MODEL = "typesafe/jev-1.13";

export interface OpenRouterJevClientOptions {
  apiKey: string;
  fetch?: FetchTransport;
}

function parseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** OpenRouter's raw-fetch implementation of the Jev Client seam. */
export class OpenRouterJevClient implements JevClient {
  private readonly apiKey: string;
  private readonly transport: FetchTransport;

  constructor(options: OpenRouterJevClientOptions) {
    this.apiKey = options.apiKey;
    this.transport = options.fetch ?? globalThis.fetch;
  }

  isConfigured(): boolean {
    return this.apiKey.trim().length > 0;
  }

  acceptsModelIdentity(value: unknown): value is string {
    if (typeof value !== "string") return false;
    if (value === CLASSIFICATION_MODEL) return true;
    const canonicalPrefix = `${CLASSIFICATION_MODEL}-`;
    return value.startsWith(canonicalPrefix) &&
      /^\d{8}$/.test(value.slice(canonicalPrefix.length));
  }

  async evaluate(
    request: JevClientRequest,
    options: JevClientRequestOptions,
  ): Promise<JevClientResponse> {
    const requestBody = JSON.stringify({
      model: CLASSIFICATION_MODEL,
      state: request.state,
      questions: request.questions,
      provider: { zdr: true },
    });
    options.ensureActive();

    const response = await this.transport(OPENROUTER_DECISIONS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: requestBody,
      signal: options.signal,
    });
    const responseText = await response.text();
    options.ensureActive();
    const envelope = parseJson(responseText);
    options.ensureActive();

    if (response.ok) {
      return { ok: true, status: response.status, envelope };
    }

    const sensitiveValues = [this.apiKey, request.state];
    return {
      ok: false,
      status: response.status,
      envelope,
      ...safeFailureMetadata(envelope, response.headers, sensitiveValues, "x-request-id"),
    };
  }
}
