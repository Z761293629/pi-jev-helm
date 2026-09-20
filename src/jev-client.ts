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

/** Vendor-specific transport and model identity behind Task Classification. */
export interface JevClient {
  isConfigured(): boolean;
  evaluate(
    request: JevClientRequest,
    options: JevClientRequestOptions,
  ): Promise<JevClientResponse>;
  acceptsModelIdentity(value: unknown): value is string;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
