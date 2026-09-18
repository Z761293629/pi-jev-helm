import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CLASSIFICATION_MODEL,
  CLASSIFICATION_TEMPLATE_V1,
  DEFAULT_CLASSIFICATION_TIMEOUT_MS,
  OPENROUTER_DECISIONS_URL,
  OpenRouterJevClassificationProvider,
} from "../src/classification-provider.js";
import { createDecisionsResponse } from "./fixtures.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("OpenRouter Jev Classification Provider", () => {
  it("publishes the versioned three-Noul whole-request template", () => {
    expect(CLASSIFICATION_TEMPLATE_V1).toEqual({
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
    });
  });

  it("sends one fixed Decisions request and preserves the current user message as state", async () => {
    const transport = vi.fn(async () =>
      createDecisionsResponse({ codeWork: 0.8, deepReasoning: 0.3, externalResearch: 0.1 }),
    );
    const classificationProvider = new OpenRouterJevClassificationProvider({
      apiKey: "secret-key",
      fetch: transport,
    });
    const message = "Read src/index.ts, then check the current OpenRouter docs.\nDo not rewrite this.";

    const result = await classificationProvider.classify(message);

    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledWith(OPENROUTER_DECISIONS_URL, {
      method: "POST",
      headers: {
        Authorization: "Bearer secret-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: CLASSIFICATION_MODEL,
        state: message,
        questions: CLASSIFICATION_TEMPLATE_V1,
        provider: { zdr: true },
      }),
      signal: expect.any(AbortSignal),
    });
    expect(Object.keys(CLASSIFICATION_TEMPLATE_V1)).toEqual([
      "codeWork",
      "deepReasoning",
      "externalResearch",
    ]);
    expect(result).toEqual({
      ok: true,
      classification: {
        schemaVersion: 1,
        signals: {
          codeWork: { value: true, confidence: 0.8 },
          deepReasoning: { value: false, confidence: 0.7 },
          externalResearch: { value: false, confidence: 0.9 },
        },
      },
    });
  });

  it.each([
    [0, false, 1],
    [0.49, false, 0.51],
    [0.5, true, 0.5],
    [1, true, 1],
  ] as const)("maps Noul probability %s to value %s and confidence %s", async (p, value, confidence) => {
    const classificationProvider = new OpenRouterJevClassificationProvider({
      apiKey: "secret-key",
      fetch: async () => createDecisionsResponse({ codeWork: p, deepReasoning: p, externalResearch: p }),
    });

    const result = await classificationProvider.classify("classify me");

    expect(result).toEqual({
      ok: true,
      classification: {
        schemaVersion: 1,
        signals: {
          codeWork: { value, confidence },
          deepReasoning: { value, confidence },
          externalResearch: { value, confidence },
        },
      },
    });
  });

  it.each([
    ["empty API key", { apiKey: "" }],
    ["blank API key", { apiKey: "   " }],
    ["zero timeout", { apiKey: "secret-key", timeoutMs: 0 }],
    ["NaN timeout", { apiKey: "secret-key", timeoutMs: Number.NaN }],
    ["infinite timeout", { apiKey: "secret-key", timeoutMs: Number.POSITIVE_INFINITY }],
  ] as const)("returns a configuration failure for %s without sending", async (_name, classificationProviderOptions) => {
    const transport = vi.fn(async () =>
      createDecisionsResponse({ codeWork: 0.1, deepReasoning: 0.1, externalResearch: 0.1 }),
    );
    const classificationProvider = new OpenRouterJevClassificationProvider({
      ...classificationProviderOptions,
      fetch: transport,
    });

    await expect(classificationProvider.classify("private user message")).resolves.toEqual({
      ok: false,
      failure: {
        kind: "configuration",
        summary: "Classification Provider configuration is invalid",
      },
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it("fails as configuration without sending when the fixed request template is invalid", async () => {
    const mutableTemplate = CLASSIFICATION_TEMPLATE_V1 as {
      codeWork: { type: string };
    };
    const originalType = mutableTemplate.codeWork.type;
    mutableTemplate.codeWork.type = "score";
    const transport = vi.fn();
    const classificationProvider = new OpenRouterJevClassificationProvider({
      apiKey: "secret-key",
      fetch: transport,
    });

    try {
      await expect(classificationProvider.classify("private user message")).resolves.toMatchObject({
        ok: false,
        failure: { kind: "configuration" },
      });
      expect(transport).not.toHaveBeenCalled();
    } finally {
      mutableTemplate.codeWork.type = originalType;
    }
  });

  it("maps caller cancellation to aborted without sending when already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const transport = vi.fn();
    const classificationProvider = new OpenRouterJevClassificationProvider({
      apiKey: "secret-key",
      fetch: transport,
    });

    await expect(classificationProvider.classify("private user message", { signal: controller.signal })).resolves.toEqual({
      ok: false,
      failure: { kind: "aborted", summary: "Classification request was cancelled" },
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it("maps caller cancellation during the only attempt to aborted", async () => {
    const controller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const transport = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        requestSignal = init?.signal ?? undefined;
        return await new Promise<Response>(() => {});
      },
    );
    const classificationProvider = new OpenRouterJevClassificationProvider({
      apiKey: "secret-key",
      fetch: transport,
    });

    const pendingResult = classificationProvider.classify("private user message", { signal: controller.signal });
    controller.abort();

    await expect(pendingResult).resolves.toEqual({
      ok: false,
      failure: { kind: "aborted", summary: "Classification request was cancelled" },
    });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(requestSignal?.aborted).toBe(true);
  });

  it("maps a transport AbortError to network when caller cancellation did not occur", async () => {
    const classificationProvider = new OpenRouterJevClassificationProvider({
      apiKey: "secret-key",
      fetch: async () => {
        throw new DOMException("private cancellation reason", "AbortError");
      },
    });

    const result = await classificationProvider.classify("private user message");

    expect(result).toEqual({
      ok: false,
      failure: { kind: "network", summary: "Classification transport failed" },
    });
    expect(JSON.stringify(result)).not.toContain("private cancellation reason");
  });

  it("maps transport failures to network without retrying or exposing error text", async () => {
    const transport = vi.fn(async () => {
      throw new TypeError("private DNS detail");
    });
    const classificationProvider = new OpenRouterJevClassificationProvider({
      apiKey: "secret-key",
      fetch: transport,
    });

    const result = await classificationProvider.classify("private user message");

    expect(result).toEqual({
      ok: false,
      failure: { kind: "network", summary: "Classification transport failed" },
    });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain("private DNS detail");
  });

  it("allows unexpected programming errors to reach the Routed Run boundary", async () => {
    const programmingError = new Error("unexpected private detail");
    const classificationProvider = new OpenRouterJevClassificationProvider({
      apiKey: "secret-key",
      fetch: async () => {
        throw programmingError;
      },
    });

    await expect(classificationProvider.classify("private user message")).rejects.toBe(programmingError);
  });

  it("applies one total default deadline even when the transport ignores cancellation", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    const transport = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        requestSignal = init?.signal ?? undefined;
        return await new Promise<Response>(() => {});
      },
    );
    const classificationProvider = new OpenRouterJevClassificationProvider({
      apiKey: "secret-key",
      fetch: transport,
    });

    const pendingResult = classificationProvider.classify("classify once");
    await vi.advanceTimersByTimeAsync(DEFAULT_CLASSIFICATION_TIMEOUT_MS);

    await expect(pendingResult).resolves.toEqual({
      ok: false,
      failure: { kind: "timeout", summary: "Classification request timed out" },
    });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(requestSignal?.aborted).toBe(true);
  });

  it("does not send when request serialization exhausts the total deadline", async () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const originalStringify = JSON.stringify;
    vi.spyOn(JSON, "stringify").mockImplementation((value: unknown) => {
      const serialized = originalStringify(value);
      now = 101;
      return serialized;
    });
    const transport = vi.fn();
    const classificationProvider = new OpenRouterJevClassificationProvider({
      apiKey: "secret-key",
      timeoutMs: 100,
      fetch: transport,
    });

    await expect(classificationProvider.classify("classify once")).resolves.toMatchObject({
      ok: false,
      failure: { kind: "timeout" },
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it("applies the same total deadline while reading the response", async () => {
    vi.useFakeTimers();
    const transport = vi.fn(async () =>
      ({
        text: async () => await new Promise<string>(() => {}),
      }) as Response,
    );
    const classificationProvider = new OpenRouterJevClassificationProvider({
      apiKey: "secret-key",
      timeoutMs: 100,
      fetch: transport,
    });

    const pendingResult = classificationProvider.classify("classify once");
    await vi.advanceTimersByTimeAsync(100);

    await expect(pendingResult).resolves.toMatchObject({
      ok: false,
      failure: { kind: "timeout" },
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("rejects a response when parsing finishes past the total deadline", async () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const originalParse = JSON.parse;
    vi.spyOn(JSON, "parse").mockImplementation((text: string) => {
      const parsed = originalParse(text) as unknown;
      now = 101;
      return parsed;
    });
    const classificationProvider = new OpenRouterJevClassificationProvider({
      apiKey: "secret-key",
      timeoutMs: 100,
      fetch: async () =>
        createDecisionsResponse({ codeWork: 0.8, deepReasoning: 0.2, externalResearch: 0.1 }),
    });

    await expect(classificationProvider.classify("classify once")).resolves.toMatchObject({
      ok: false,
      failure: { kind: "timeout" },
    });
  });

  it("rejects a response when semantic validation finishes past the total deadline", async () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const originalKeys = Object.keys;
    vi.spyOn(Object, "keys").mockImplementation((value: object) => {
      const keys = originalKeys(value);
      if (
        keys.includes("codeWork") &&
        typeof (value as { codeWork?: unknown }).codeWork === "object" &&
        (value as { codeWork?: { noul?: unknown } }).codeWork?.noul !== undefined
      ) {
        now = 101;
      }
      return keys;
    });
    const classificationProvider = new OpenRouterJevClassificationProvider({
      apiKey: "secret-key",
      timeoutMs: 100,
      fetch: async () =>
        createDecisionsResponse({ codeWork: 0.8, deepReasoning: 0.2, externalResearch: 0.1 }),
    });

    await expect(classificationProvider.classify("classify once")).resolves.toMatchObject({
      ok: false,
      failure: { kind: "timeout" },
    });
  });

  it.each([
    CLASSIFICATION_MODEL,
    `${CLASSIFICATION_MODEL}-20260917`,
  ] as const)("accepts model identity %s and unknown fields in otherwise valid objects", async (responseModel) => {
    const classificationProvider = new OpenRouterJevClassificationProvider({
      apiKey: "secret-key",
      fetch: async () =>
        new Response(
          JSON.stringify({
            model: responseModel,
            futureTopLevelField: { ignored: true },
            usage: {
              input_tokens: 12,
              output_tokens: 3,
              cost: 0.01,
              futureUsageField: "ignored",
            },
            answers: {
              codeWork: { type: "noul", noul: 0.8, futureAnswerField: true },
              deepReasoning: { type: "noul", noul: 0.2, futureAnswerField: true },
              externalResearch: { type: "noul", noul: 0.1, futureAnswerField: true },
            },
          }),
        ),
    });

    await expect(classificationProvider.classify("classify me")).resolves.toMatchObject({
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
  });

  it.each(
    (() => {
      const valid = () => ({
        model: "typesafe/jev-1.13-20260917",
        usage: { input_tokens: 12, output_tokens: 3 },
        answers: {
          codeWork: { type: "noul", noul: 0.8 },
          deepReasoning: { type: "noul", noul: 0.2 },
          externalResearch: { type: "noul", noul: 0.1 },
        },
      });
      return [
        ["non-JSON body", "not JSON"],
        ["missing model", (() => { const body = valid(); delete (body as Partial<typeof body>).model; return body; })()],
        ["blank model", { ...valid(), model: "   " }],
        ["unqualified model identity", { ...valid(), model: "jev-1.13" }],
        ["unrelated qualified model identity", { ...valid(), model: "other/model" }],
        ["unrecognized canonical suffix", { ...valid(), model: "typesafe/jev-1.13-not-a-version" }],
        ["model identity containing whitespace", { ...valid(), model: "typesafe/jev 1.13" }],
        ["non-string model", { ...valid(), model: 13 }],
        ["missing usage", (() => { const body = valid(); delete (body as Partial<typeof body>).usage; return body; })()],
        ["negative input count", { ...valid(), usage: { input_tokens: -1, output_tokens: 3 } }],
        ["fractional output count", { ...valid(), usage: { input_tokens: 12, output_tokens: 1.5 } }],
        ["coerced token count", { ...valid(), usage: { input_tokens: "12", output_tokens: 3 } }],
        ["missing answers", (() => { const body = valid(); delete (body as Partial<typeof body>).answers; return body; })()],
        ["array answers", { ...valid(), answers: [] }],
        ["missing answer", (() => { const body = valid(); delete (body.answers as Partial<typeof body.answers>).codeWork; return body; })()],
        ["extra answer", { ...valid(), answers: { ...valid().answers, taskType: { type: "noul", noul: 1 } } }],
        ["mismatched answer type", { ...valid(), answers: { ...valid().answers, codeWork: { type: "score", noul: 0.8 } } }],
        ["primitive answer", { ...valid(), answers: { ...valid().answers, codeWork: 0.8 } }],
        ["coerced probability", { ...valid(), answers: { ...valid().answers, codeWork: { type: "noul", noul: "0.8" } } }],
        ["missing probability", { ...valid(), answers: { ...valid().answers, codeWork: { type: "noul" } } }],
        ["probability below range", { ...valid(), answers: { ...valid().answers, codeWork: { type: "noul", noul: -0.01 } } }],
        ["probability above range", { ...valid(), answers: { ...valid().answers, codeWork: { type: "noul", noul: 1.01 } } }],
        ["nonnumeric probability", { ...valid(), answers: { ...valid().answers, codeWork: { type: "noul", noul: null } } }],
      ] as const;
    })(),
  )("rejects %s as a protocol failure without repair", async (_name, body) => {
    const classificationProvider = new OpenRouterJevClassificationProvider({
      apiKey: "secret-key",
      fetch: async () =>
        new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200 }),
    });

    await expect(classificationProvider.classify("private user message")).resolves.toEqual({
      ok: false,
      failure: { kind: "protocol", summary: "Classification response was invalid" },
    });
  });

  it("returns only safe structured HTTP metadata", async () => {
    const classificationProvider = new OpenRouterJevClassificationProvider({
      apiKey: "secret-key",
      fetch: async () =>
        new Response(
          JSON.stringify({ error: { code: "rate_limit_exceeded", message: "private detail" } }),
          {
            status: 429,
            headers: {
              "retry-after": "3",
              "x-request-id": "request-safe-123",
            },
          },
        ),
    });

    await expect(classificationProvider.classify("private user message")).resolves.toEqual({
      ok: false,
      failure: {
        kind: "rate_limited",
        summary: "Classification request was rate limited",
        status: 429,
        upstreamCode: "rate_limit_exceeded",
        retryAfterMs: 3000,
        requestId: "request-safe-123",
      },
    });
  });

  it("drops otherwise valid metadata that could expose the API key or user message", async () => {
    const classificationProvider = new OpenRouterJevClassificationProvider({
      apiKey: "secret-key-123",
      fetch: async () =>
        new Response(
          JSON.stringify({ error: { code: "secret-key-123" } }),
          {
            status: 500,
            headers: { "x-request-id": "private_user_message" },
          },
        ),
    });

    const result = await classificationProvider.classify("private_user_message");

    expect(result).toEqual({
      ok: false,
      failure: {
        kind: "upstream",
        summary: "Classification upstream service failed",
        status: 500,
      },
    });
    expect(JSON.stringify(result)).not.toContain("secret-key-123");
    expect(JSON.stringify(result)).not.toContain("private_user_message");
  });

  it("drops malformed metadata rather than returning possible upstream text", async () => {
    const classificationProvider = new OpenRouterJevClassificationProvider({
      apiKey: "secret-key",
      fetch: async () =>
        new Response(
          JSON.stringify({ error: { code: "account user-123 private detail" } }),
          {
            status: 500,
            headers: {
              "retry-after": "not-a-delay",
              "x-request-id": "account user-123 private detail",
            },
          },
        ),
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

  it.each([
    [400, "request_rejected"],
    [404, "request_rejected"],
    [413, "request_rejected"],
    [422, "request_rejected"],
    [401, "authentication"],
    [403, "authentication"],
    [402, "quota"],
    [429, "rate_limited"],
    [500, "upstream"],
    [502, "upstream"],
    [503, "upstream"],
    [524, "upstream"],
    [529, "upstream"],
    [418, "unexpected_http"],
  ] as const)("maps HTTP %s to the %s failure kind without leaking upstream text", async (status, kind) => {
    const transport = vi.fn(async () =>
      new Response(
        JSON.stringify({
          error: {
            code: status,
            message: "account=user-123 secret upstream detail",
          },
        }),
        { status },
      ),
    );
    const classificationProvider = new OpenRouterJevClassificationProvider({
      apiKey: "secret-key",
      fetch: transport,
    });

    const result = await classificationProvider.classify("private user message");

    expect(transport).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      ok: false,
      failure: { kind, status, upstreamCode: status },
    });
    expect(JSON.stringify(result)).not.toContain("private user message");
    expect(JSON.stringify(result)).not.toContain("secret-key");
    expect(JSON.stringify(result)).not.toContain("user-123");
    expect(JSON.stringify(result)).not.toContain("secret upstream detail");
  });
});
