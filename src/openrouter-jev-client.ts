import { isObject,
  type JevClient,
  type JevClientRequest,
  type JevClientRequestOptions,
  type JevClientResponse,
} from "./jev-client.js";

export const OPENROUTER_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
export const CLASSIFICATION_MODEL = "typesafe/jev-1.13";

export type FetchTransport = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface OpenRouterJevClientOptions {
  apiKey: string;
  fetch?: FetchTransport;
}

function exposesSensitiveValue(
  candidate: string,
  sensitiveValues: readonly string[],
): boolean {
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
    const upstreamCode = safeUpstreamCode(envelope, sensitiveValues);
    const retryAfterMs = safeRetryAfterMs(response.headers);
    const requestId = safeRequestId(response.headers, sensitiveValues);
    return {
      ok: false,
      status: response.status,
      envelope,
      ...(upstreamCode === undefined ? {} : { upstreamCode }),
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      ...(requestId === undefined ? {} : { requestId }),
    };
  }
}
