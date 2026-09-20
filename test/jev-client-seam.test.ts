import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CLASSIFICATION_TEMPLATE_V1,
  DEFAULT_CLASSIFICATION_TIMEOUT_MS,
  JevClassificationProvider,
} from "../src/classification-provider.js";
import {
  CLASSIFICATION_MODEL,
  OPENROUTER_DECISIONS_URL,
  OpenRouterJevClient,
} from "../src/openrouter-jev-client.js";
import type {
  JevClient,
  JevClientRequest,
  JevClientRequestOptions,
  JevClientResponse,
} from "../src/jev-client.js";

const FAKE_MODEL = "fake/jev-1.13";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function envelope(model: unknown = FAKE_MODEL): unknown {
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

function fakeClient(
  evaluate: (
    request: JevClientRequest,
    options: JevClientRequestOptions,
  ) => Promise<JevClientResponse>,
  configured = true,
): JevClient {
  return {
    isConfigured: () => configured,
    evaluate,
    acceptsModelIdentity(value: unknown): value is string {
      return value === FAKE_MODEL;
    },
  };
}

describe("Jev Client seam", () => {
  it("runs the shared question template and envelope mapping through a fake Jev Client", async () => {
    const evaluate = vi.fn(async (): Promise<JevClientResponse> => ({
      ok: true,
      status: 200,
      envelope: envelope(),
    }));
    const classificationProvider = new JevClassificationProvider({
      client: fakeClient(evaluate),
    });

    const result = await classificationProvider.classify("classify the whole request");

    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(evaluate).toHaveBeenCalledWith(
      {
        state: "classify the whole request",
        questions: CLASSIFICATION_TEMPLATE_V1,
      },
      {
        signal: expect.any(AbortSignal),
        ensureActive: expect.any(Function),
      },
    );
    expect(result).toEqual({
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

  it("uses the Jev Client's model identity assertion for shared envelope validation", async () => {
    const classificationProvider = new JevClassificationProvider({
      client: fakeClient(async () => ({
        ok: true,
        status: 200,
        envelope: envelope(CLASSIFICATION_MODEL),
      })),
    });

    await expect(classificationProvider.classify("classify me")).resolves.toEqual({
      ok: false,
      failure: {
        kind: "protocol",
        summary: "Classification response was invalid",
      },
    });
  });

  it.each([
    ["missing envelope", undefined],
    ["primitive envelope", "invalid"],
    ["missing usage", { ...(envelope() as Record<string, unknown>), usage: undefined }],
    [
      "wrong answer set",
      {
        ...(envelope() as Record<string, unknown>),
        answers: { codeWork: { type: "noul", noul: 0.8 } },
      },
    ],
  ])("maps %s from a fake Jev Client to protocol failure", async (_name, invalidEnvelope) => {
    const classificationProvider = new JevClassificationProvider({
      client: fakeClient(async () => ({
        ok: true,
        status: 200,
        envelope: invalidEnvelope,
      })),
    });

    await expect(classificationProvider.classify("classify me")).resolves.toMatchObject({
      ok: false,
      failure: { kind: "protocol" },
    });
  });

  it("returns configuration failure without calling an unconfigured fake Jev Client", async () => {
    const evaluate = vi.fn(async (): Promise<JevClientResponse> => ({
      ok: true,
      status: 200,
      envelope: envelope(),
    }));
    const classificationProvider = new JevClassificationProvider({
      client: fakeClient(evaluate, false),
    });

    await expect(classificationProvider.classify("private message")).resolves.toMatchObject({
      ok: false,
      failure: { kind: "configuration" },
    });
    expect(evaluate).not.toHaveBeenCalled();
  });

  it.each([
    [400, "request_rejected"],
    [401, "authentication"],
    [402, "quota"],
    [429, "rate_limited"],
    [500, "upstream"],
    [418, "unexpected_http"],
  ] as const)("maps fake Jev Client HTTP %s to %s", async (status, kind) => {
    const classificationProvider = new JevClassificationProvider({
      client: fakeClient(async () => ({
        ok: false,
        status,
        envelope: undefined,
        upstreamCode: "safe_code",
        retryAfterMs: 2000,
        requestId: "request-safe-1",
      })),
    });

    await expect(classificationProvider.classify("private message")).resolves.toMatchObject({
      ok: false,
      failure: {
        kind,
        status,
        upstreamCode: "safe_code",
        retryAfterMs: 2000,
        requestId: "request-safe-1",
      },
    });
  });

  it("applies the shared deadline when a fake Jev Client never settles", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    const evaluate = vi.fn(
      async (_request: JevClientRequest, options: JevClientRequestOptions) => {
        requestSignal = options.signal;
        return await new Promise<JevClientResponse>(() => {});
      },
    );
    const classificationProvider = new JevClassificationProvider({
      client: fakeClient(evaluate),
    });

    const pendingResult = classificationProvider.classify("classify once");
    await vi.advanceTimersByTimeAsync(DEFAULT_CLASSIFICATION_TIMEOUT_MS);

    await expect(pendingResult).resolves.toMatchObject({
      ok: false,
      failure: { kind: "timeout" },
    });
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(requestSignal?.aborted).toBe(true);
  });

  it("applies caller abort and cancels the fake Jev Client request", async () => {
    const controller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const classificationProvider = new JevClassificationProvider({
      client: fakeClient(async (_request, options) => {
        requestSignal = options.signal;
        return await new Promise<JevClientResponse>(() => {});
      }),
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

  it("maps a fake Jev Client transport failure to network", async () => {
    const classificationProvider = new JevClassificationProvider({
      client: fakeClient(async () => {
        throw new TypeError("private network detail");
      }),
    });

    const result = await classificationProvider.classify("private message");

    expect(result).toMatchObject({ ok: false, failure: { kind: "network" } });
    expect(JSON.stringify(result)).not.toContain("private network detail");
  });
});

describe("OpenRouter Jev Client", () => {
  it("reports a blank API key as unconfigured and fails as configuration without sending", async () => {
    const transport = vi.fn();
    const client = new OpenRouterJevClient({ apiKey: "   ", fetch: transport });
    const classificationProvider = new JevClassificationProvider({ client });

    expect(client.isConfigured()).toBe(false);
    await expect(classificationProvider.classify("private user message")).resolves.toEqual({
      ok: false,
      failure: {
        kind: "configuration",
        summary: "Classification Provider configuration is invalid",
      },
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it("drops malformed metadata at the client before the shared provider sees it", async () => {
    const transport = vi.fn(async () =>
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
    );
    const classificationProvider = new JevClassificationProvider({
      client: new OpenRouterJevClient({ apiKey: "secret-key", fetch: transport }),
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

  it("keeps the existing OpenRouter Decisions protocol behind the seam", async () => {
    const transport = vi.fn(async () =>
      new Response(JSON.stringify(envelope("typesafe/jev-1.13-20260917"))),
    );
    const classificationProvider = new JevClassificationProvider({
      client: new OpenRouterJevClient({ apiKey: "secret-key", fetch: transport }),
    });
    const message = "Read src/index.ts, then check the current OpenRouter docs.";

    await expect(classificationProvider.classify(message)).resolves.toMatchObject({ ok: true });
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
  });
});
