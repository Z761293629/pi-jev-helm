# Keep one Classification Provider behind a Jev Client seam

Pi Jev Helm keeps Task Classification a single Classification Provider implementation and varies only a Jev Client seam beneath it — the OpenRouter Jev Client (raw fetch against the Decisions API, keeping its `provider.zdr` flag and `typesafe/jev-1.13` model identity) and the TypeSafe Jev Client (the official `@typesafe-ai/sdk` against `api.typesafe.ai/v1/systemone`, model pinned to `jev-1.13.0`) — because classification is one thing, Jev evaluation, and only the vendor protocol varies; splitting the provider per vendor would duplicate the timeout, abort, failure-taxonomy, and envelope-validation scaffolding and misrepresent one classifier as two. The SDK-versus-fetch asymmetry is deliberate: the official SDK owns TypeSafe's protocol evolution while the audited in-repo transport already serves the OpenRouter endpoint; the SDK must be configurable to a single attempt inside the shared classification deadline with abort pass-through, and if its configuration cannot express that, the TypeSafe Jev Client falls back to raw fetch like its sibling (this conditional was resolved on 2026-09-20 — the guardrail holds, so the fallback never arms; see the Resolution below).

## Resolution: SDK guardrail confirmed (2026-09-20, issue #48)

Verified against the shipped `@typesafe-ai/sdk@0.6.0` package (`.d.ts` plus `dist/index.mjs`; the shipped package is the authoritative artifact). All four required capabilities hold, so the TypeSafe Jev Client uses the official SDK and the raw-fetch fallback never arms:

| Guardrail | Citation in `@typesafe-ai/sdk@0.6.0` |
| --- | --- |
| Single attempt | `TypeSafeClientConfig.retry.maxRetries: 0` disables retries (default is 2). |
| Deadline-bounded timeout | `TypeSafeClientConfig.timeout` bounds one attempt in milliseconds (default is 10000); Helm sets it to the shared classification deadline. |
| Abort pass-through | `RequestOptions.signal` cancels the request (and any pending retry), surfacing as `APIUserAbortError`. |
| Injectable transport | `TypeSafeClientConfig.fetch` swaps the HTTP transport, which is how the seam tests inject failures. |

The error surface is what the existing failure taxonomy maps from: non-2xx responses reject with `APIError` (`status`, `headers`, `body`, `requestId` from `x-typesafe-request-id`), connection failures with `APIConnectionError`/`APITimeoutError`, caller aborts with `APIUserAbortError`. The client passes the Pi-resolved key explicitly via the `apiKey` config field — the SDK's `TYPESAFE_API_KEY` env fallback is pinned out along with `TYPESAFE_BASE_URL` and `TYPESAFE_DEFAULT_MODEL`, so no ambient value can change the credential, endpoint, or model identity; `jev-1.13.0` is sent verbatim and aliases (for example `jev-latest`) are never requested or trusted.
