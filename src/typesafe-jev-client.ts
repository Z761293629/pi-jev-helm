import {
  APIConnectionError,
  APIError,
  RateLimitError,
  TypeSafeClient,
} from "@typesafe-ai/sdk";
import {
  DEFAULT_CLASSIFICATION_TIMEOUT_MS,
  JevClientTransportError,
  safeFailureMetadata,
  type FetchTransport,
  type JevClient,
  type JevClientRequest,
  type JevClientRequestOptions,
  type JevClientResponse,
} from "./jev-client.js";

/**
 * TypeSafe's official evaluation endpoint (ADR 0003: the official SDK owns
 * TypeSafe's protocol evolution, so no raw-fetch fallback exists here).
 */
export const TYPESAFE_API_BASE_URL = "https://api.typesafe.ai";
export const TYPESAFE_SYSTEMONE_PATH = "/v1/systemone";

/**
 * The classification model pin. Sent verbatim on every evaluation and the only
 * accepted response identity — TypeSafe's aliases (for example `jev-latest`)
 * are never requested and never trusted (issue #48).
 */
export const TYPESAFE_CLASSIFICATION_MODEL = "jev-1.13.0";

/**
 * SDK guardrail settled against the shipped `@typesafe-ai/sdk@0.6.0`
 * (resolution recorded in docs/adr/0003): `retry.maxRetries: 0` confines the
 * SDK to a single attempt, `timeout` bounds that attempt to the shared
 * classification deadline, `RequestOptions.signal` passes caller aborts
 * through as `APIUserAbortError`, and `fetch` injects the transport used by
 * the tests.
 */
export interface TypeSafeJevClientOptions {
  apiKey: string;
  /** Single-attempt deadline in milliseconds; the shared default applies when omitted. */
  timeoutMs?: number;
  fetch?: FetchTransport;
}

/** TypeSafe's official SDK implementation of the Jev Client seam. */
export class TypeSafeJevClient implements JevClient {
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly transport: FetchTransport;
  private sdkClient: TypeSafeClient | undefined;

  constructor(options: TypeSafeJevClientOptions) {
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_CLASSIFICATION_TIMEOUT_MS;
    this.transport = options.fetch ?? globalThis.fetch;
  }

  isConfigured(): boolean {
    return (
      this.apiKey.trim().length > 0 &&
      Number.isFinite(this.timeoutMs) &&
      this.timeoutMs > 0
    );
  }

  acceptsModelIdentity(value: unknown): value is string {
    return value === TYPESAFE_CLASSIFICATION_MODEL;
  }

  async evaluate(
    request: JevClientRequest,
    options: JevClientRequestOptions,
  ): Promise<JevClientResponse> {
    options.ensureActive();

    try {
      const { data, response } = await this.sdk().systemOne(
        {
          state: request.state,
          questions: request.questions,
          model: TYPESAFE_CLASSIFICATION_MODEL,
        },
        { signal: options.signal },
      ).withResponse();
      options.ensureActive();

      // Envelope validity (identity, usage, answers) is the Classification
      // Provider's shared validation; a 2xx body is passed through as-is.
      return { ok: true, status: response.status, envelope: data };
    } catch (error) {
      if (error instanceof APIError) {
        // Non-2xx arrives as a typed APIError; the official status code is
        // handed to the shared failure taxonomy with sanitized metadata.
        return {
          ok: false,
          status: error.status,
          envelope: error.body,
          ...safeFailureMetadata(
            error.body,
            error.headers,
            [this.apiKey, request.state],
            "x-typesafe-request-id",
            error instanceof RateLimitError ? error.retryAfterMs : undefined,
          ),
        };
      }
      if (error instanceof APIConnectionError) {
        // Connection and delivery failures (including the SDK's own per-
        // attempt timeout) surface as the seam's transport error; the shared
        // provider maps them onto the network failure kind, and the shared
        // deadline already bounds the wall clock.
        throw new JevClientTransportError("Jev transport failed", { cause: error });
      }
      throw error;
    }
  }

  /**
   * Builds the SDK client lazily so that an unconfigured instance never
   * triggers the SDK's constructor-side credential or config validation: the
   * key the Pi-resolved caller passed explicitly is the only credential this
   * client will ever send, so ambient `TYPESAFE_*` environment fallbacks are
   * pinned out for the key, base URL, and model alike.
   */
  private sdk(): TypeSafeClient {
    if (this.sdkClient === undefined) {
      this.sdkClient = new TypeSafeClient({
        apiKey: this.apiKey,
        baseURL: TYPESAFE_API_BASE_URL,
        defaultModel: TYPESAFE_CLASSIFICATION_MODEL,
        timeout: this.timeoutMs,
        retry: { maxRetries: 0 },
        fetch: this.transport,
      });
    }
    return this.sdkClient;
  }
}
