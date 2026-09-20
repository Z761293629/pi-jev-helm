import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CLASSIFICATION_TEMPLATE_V1,
  DEFAULT_CLASSIFICATION_TIMEOUT_MS,
  JevClassificationProvider,
} from "../src/classification-provider.js";
import {
  JevClientTransportError,
  type FetchTransport,
  type JevClientRequestOptions,
} from "../src/jev-client.js";
import {
  TYPESAFE_API_BASE_URL,
  TYPESAFE_CLASSIFICATION_MODEL,
  TYPESAFE_SYSTEMONE_PATH,
  TypeSafeJevClient,
} from "../src/typesafe-jev-client.js";

const API_KEY = "secret-key";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function typeSafeEnvelope(model: unknown = TYPESAFE_CLASSIFICATION_MODEL): unknown {
  return {
    model,
    usage: { input_tokens: 12, output_tokens: 3 },
    answers: {
      codeWork: { type: "noul", noul: 0.8 },
      deepReasoning: { type: "noul", noul: 0.2 },
      externalResearch: { type: "noul", noul: 0.1 },
    },
  };
}

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(body === undefined ? "" : JSON.stringify(body), {
    status,
    ...(headers === undefined ? {} : { headers }),
  });
}

describe("TypeSafe Jev Client through the seam", () => {
  it("classifies through the official SystemOne endpoint with the pinned model", async () => {
    const transport = vi.fn<FetchTransport>(async () => jsonResponse(200, typeSafeEnvelope()));
    const classificationProvider = new JevClassificationProvider({
      client: new TypeSafeJevClient({ apiKey: API_KEY, fetch: transport }),
    });
    const message = "Read src/index.ts, then check the current TypeSafe docs.";

    await expect(classificationProvider.classify(message)).resolves.toEqual({
      ok: true,
      classification: {
        schemaVersion: 1,
        signals: {
          codeWork: { value: true, confidence: 0.8 },
          deepReasoning: { value: false, confidence: 0.8 },
          externalResearch: { value: false, confidence: 0.9 },
        },
      },
    });
    expect(transport).toHaveBeenCalledTimes(1);
    const [input, init] = transport.mock.calls[0]!;
    expect(input).toBe(`${TYPESAFE_API_BASE_URL}${TYPESAFE_SYSTEMONE_PATH}`);
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${API_KEY}`);
    expect(JSON.parse(String(init?.body))).toEqual({
      model: TYPESAFE_CLASSIFICATION_MODEL,
      state: message,
      questions: CLASSIFICATION_TEMPLATE_V1,
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("pins the model, endpoint, and credential even against alias-poisoned ambient environment", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "ambient-key");
    vi.stubEnv("TYPESAFE_DEFAULT_MODEL", "jev-latest");
    vi.stubEnv("TYPESAFE_BASE_URL", "https://ambient.example");
    const transport = vi.fn<FetchTransport>(async () => jsonResponse(200, typeSafeEnvelope()));
    const classificationProvider = new JevClassificationProvider({
      client: new TypeSafeJevClient({ apiKey: API_KEY, fetch: transport }),
    });

    await expect(classificationProvider.classify("classify me")).resolves.toMatchObject({
      ok: true,
    });

    const [input, init] = transport.mock.calls[0]!;
    expect(input).toBe(`${TYPESAFE_API_BASE_URL}${TYPESAFE_SYSTEMONE_PATH}`);
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${API_KEY}`);
    expect(JSON.parse(String(init?.body)).model).toBe(TYPESAFE_CLASSIFICATION_MODEL);
  });

  it("accepts exactly the pinned model identity, never an alias", () => {
    const client = new TypeSafeJevClient({ apiKey: API_KEY, fetch: vi.fn() });

    expect(client.acceptsModelIdentity(TYPESAFE_CLASSIFICATION_MODEL)).toBe(true);
    for (const alias of [
      "jev-latest",
      "jev-1.13",
      "typesafe/jev-1.13",
      "jev-1.13.0-20260917",
      "jev-1.14.0",
      "jev-1.13.0 ",
      42,
      null,
      undefined,
    ]) {
      expect(client.acceptsModelIdentity(alias)).toBe(false);
    }
  });

  it("maps an alias model identity in the response to protocol failure", async () => {
    const transport = vi.fn(async () => jsonResponse(200, typeSafeEnvelope("jev-latest")));
    const classificationProvider = new JevClassificationProvider({
      client: new TypeSafeJevClient({ apiKey: API_KEY, fetch: transport }),
    });

    await expect(classificationProvider.classify("classify me")).resolves.toMatchObject({
      ok: false,
      failure: { kind: "protocol" },
    });
  });

  it.each([
    [400, "request_rejected"],
    [401, "authentication"],
    [402, "quota"],
    [422, "request_rejected"],
    [429, "rate_limited"],
    [500, "upstream"],
    [529, "upstream"],
  ] as const)("maps official HTTP %s to %s", async (status, kind) => {
    const transport = vi.fn<FetchTransport>(async () =>
      jsonResponse(status, { error: { code: "safe_code" } }, {
        "x-typesafe-request-id": "request-safe-1",
        ...(status === 429 ? { "retry-after": "2" } : {}),
      }),
    );
    const classificationProvider = new JevClassificationProvider({
      client: new TypeSafeJevClient({ apiKey: API_KEY, fetch: transport }),
    });

    await expect(classificationProvider.classify("private message")).resolves.toEqual({
      ok: false,
      failure: {
        kind,
        summary: expect.any(String),
        status,
        upstreamCode: "safe_code",
        ...(status === 429 ? { retryAfterMs: 2000 } : {}),
        requestId: "request-safe-1",
      },
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("drops malformed failure metadata at the client before the shared provider sees it", async () => {
    const transport = vi.fn<FetchTransport>(async () =>
      jsonResponse(500, { error: { code: "account user-123 private detail" } }, {
        "retry-after": "not-a-delay",
        "x-typesafe-request-id": "account user-123 private detail",
      }),
    );
    const classificationProvider = new JevClassificationProvider({
      client: new TypeSafeJevClient({ apiKey: API_KEY, fetch: transport }),
    });

    const result = await classificationProvider.classify("private user message");

    expect(result).toEqual({
      ok: false,
      failure: {
        kind: "upstream",
        summary: "Classification upstream service failed",
        status: 500,
      },
    });
    expect(JSON.stringify(result)).not.toContain("user-123");
    expect(JSON.stringify(result)).not.toContain("private detail");
  });

  it("stays a single attempt even when the official status is retryable", async () => {
    const transport = vi.fn<FetchTransport>(async () => jsonResponse(500, undefined));
    const classificationProvider = new JevClassificationProvider({
      client: new TypeSafeJevClient({ apiKey: API_KEY, fetch: transport }),
    });

    await expect(classificationProvider.classify("private message")).resolves.toMatchObject({
      ok: false,
      failure: { kind: "upstream", status: 500 },
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("maps a transport connection failure to network without leaking the cause", async () => {
    const transport = vi.fn<FetchTransport>(async () => {
      throw new TypeError("private socket detail");
    });
    const classificationProvider = new JevClassificationProvider({
      client: new TypeSafeJevClient({ apiKey: API_KEY, fetch: transport }),
    });

    const result = await classificationProvider.classify("private message");

    expect(result).toMatchObject({ ok: false, failure: { kind: "network" } });
    expect(JSON.stringify(result)).not.toContain("private socket detail");
  });

  it("surfaces connection failures as the seam transport error for direct callers", async () => {
    const client = new TypeSafeJevClient({
      apiKey: API_KEY,
      fetch: async () => {
        throw new TypeError("private socket detail");
      },
    });
    const options: JevClientRequestOptions = {
      signal: new AbortController().signal,
      ensureActive: () => {},
    };

    await expect(
      client.evaluate(
        { state: "private message", questions: CLASSIFICATION_TEMPLATE_V1 },
        options,
      ),
    ).rejects.toBeInstanceOf(JevClientTransportError);
  });

  it("applies the shared deadline when the transport never settles", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    const transport = vi.fn<FetchTransport>(
      (_input, init) =>
        new Promise<Response>(() => {
          requestSignal = init?.signal ?? undefined;
        }),
    );
    const classificationProvider = new JevClassificationProvider({
      client: new TypeSafeJevClient({ apiKey: API_KEY, fetch: transport }),
    });

    const pendingResult = classificationProvider.classify("classify once");
    await vi.advanceTimersByTimeAsync(DEFAULT_CLASSIFICATION_TIMEOUT_MS);

    await expect(pendingResult).resolves.toMatchObject({
      ok: false,
      failure: { kind: "timeout" },
    });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(requestSignal?.aborted).toBe(true);
  });

  it("passes a caller abort through to the transport and reports aborted", async () => {
    const controller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const transport = vi.fn<FetchTransport>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          requestSignal = init?.signal ?? undefined;
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("The operation was aborted.", "AbortError")),
            { once: true },
          );
        }),
    );
    const classificationProvider = new JevClassificationProvider({
      client: new TypeSafeJevClient({ apiKey: API_KEY, fetch: transport }),
    });

    const pendingResult = classificationProvider.classify("classify once", {
      signal: controller.signal,
    });
    controller.abort();

    await expect(pendingResult).resolves.toMatchObject({
      ok: false,
      failure: { kind: "aborted" },
    });
    expect(requestSignal?.aborted).toBe(true);
  });

  it("fails as configuration for a blank credential without sending, ignoring ambient keys", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "ambient-key");
    const transport = vi.fn<FetchTransport>(async () => jsonResponse(200, typeSafeEnvelope()));
    const client = new TypeSafeJevClient({ apiKey: "   ", fetch: transport });
    const classificationProvider = new JevClassificationProvider({ client });

    expect(client.isConfigured()).toBe(false);

    await expect(classificationProvider.classify("private message")).resolves.toEqual({
      ok: false,
      failure: {
        kind: "configuration",
        summary: "Classification Provider configuration is invalid",
      },
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it("fails as configuration for a deadline that cannot bound an attempt", () => {
    const client = new TypeSafeJevClient({ apiKey: API_KEY, timeoutMs: 0, fetch: vi.fn() });

    expect(client.isConfigured()).toBe(false);
  });
});
