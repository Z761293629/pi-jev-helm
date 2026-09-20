export interface JevNoulQuestion {
  readonly type: "noul";
  readonly instructions: string;
  readonly criteria: {
    readonly true: string;
    readonly false: string;
  };
}

export type JevQuestionTemplate = Readonly<Record<string, JevNoulQuestion>>;

export interface JevClientRequest {
  state: string;
  questions: JevQuestionTemplate;
}

export interface JevClientRequestOptions {
  signal: AbortSignal;
  /**
   * Throws when the shared Classification Provider deadline or caller signal
   * has stopped this evaluation. A Jev Client calls this immediately before
   * starting remote work and between locally synchronous protocol steps.
   */
  ensureActive(): void;
}

export interface JevClientResponse {
  ok: boolean;
  status: number;
  envelope: unknown | undefined;
  upstreamCode?: string | number;
  retryAfterMs?: number;
  requestId?: string;
}

/** HTTP fetch implementation compatible with the global `fetch`. */
export type FetchTransport = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Default wall-clock budget shared by every Jev Client attempt and enforced
 * end to end by the Classification Provider: a single classification attempt
 * may never outlive it.
 */
export const DEFAULT_CLASSIFICATION_TIMEOUT_MS = 2500;

/** Vendor-specific transport and model identity behind Task Classification. */
export interface JevClient {
  isConfigured(): boolean;
  evaluate(
    request: JevClientRequest,
    options: JevClientRequestOptions,
  ): Promise<JevClientResponse>;
  acceptsModelIdentity(value: unknown): value is string;
}

/**
 * Transport failure inside a Jev Client that is neither an HTTP status nor a
 * caller-visible stop: the connection or response delivery failed. The
 * Classification Provider maps this to the network failure kind and never
 * surfaces the cause text.
 */
export class JevClientTransportError extends Error {
  constructor(message = "Jev transport failed", options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

/** Best-effort upstream error code that cannot carry credential or message content. */
export function safeUpstreamCode(
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

/** Integer-second `Retry-After` advice in milliseconds, or nothing. */
export function safeRetryAfterMs(headers: Headers): number | undefined {
  const value = headers.get("retry-after");
  if (value === null || !/^\d+$/.test(value.trim())) return undefined;
  const milliseconds = Number(value.trim()) * 1000;
  return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
}

/** Best-effort request id from `headerName` that cannot carry credential or message content. */
export function safeRequestId(
  headers: Headers,
  sensitiveValues: readonly string[],
  headerName: string,
): string | undefined {
  const value = headers.get(headerName);
  return value &&
    /^[A-Za-z0-9._:-]{1,256}$/.test(value) &&
    !exposesSensitiveValue(value, sensitiveValues)
    ? value
    : undefined;
}

function safeDelayMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

/**
 * Sanitized failure metadata assembled once for every Jev Client: best-effort
 * upstream code, retry advice, and request id, each dropped entirely when it
 * cannot be expressed without credential or message content. `headerName`
 * names the vendor's request-id header.
 */
export function safeFailureMetadata(
  envelope: unknown,
  headers: Headers,
  sensitiveValues: readonly string[],
  headerName: string,
  retryAfterMsFallback?: number | undefined,
): Pick<JevClientResponse, "upstreamCode" | "retryAfterMs" | "requestId"> {
  const upstreamCode = safeUpstreamCode(envelope, sensitiveValues);
  const retryAfterMs =
    safeRetryAfterMs(headers) ?? safeDelayMs(retryAfterMsFallback);
  const requestId = safeRequestId(headers, sensitiveValues, headerName);
  return {
    ...(upstreamCode === undefined ? {} : { upstreamCode }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(requestId === undefined ? {} : { requestId }),
  };
}
