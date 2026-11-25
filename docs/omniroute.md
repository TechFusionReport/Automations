# OmniRoute integration

## Role and request flow

OmniRoute centralizes provider selection for active production LLM requests. Notion continues to own content and workflow state.

```text
Discovery / Enhancement / Publishing
                |
                v
       shared LLM client (one attempt)
                |
                v
 OmniRoute / TFR Free Chain
                |
                v
 provider routing, retries, cooldowns, failover

If the OmniRoute request fails:
shared LLM client -> direct Gemini compatibility fallback
```

The application does not retry OmniRoute. This avoids multiplying retries already owned by the chain. A failed OmniRoute request can activate one legacy direct-provider attempt when fallback is enabled, except authentication and authorization failures (`401`/`403`), which fail closed so broken credentials cannot remain hidden. Existing workflow/queue retry behavior remains unchanged.

## Verified live API contract

Contract checked against `https://omniroute.techfusionreport.com` on 2026-08-13 (OmniRoute response version `3.8.49`) and cross-checked with the deployed UI and the upstream [OmniRoute repository](https://github.com/diegosouzapw/OmniRoute).

- Base API: `https://omniroute.techfusionreport.com/v1`
- Chat endpoint: `POST /v1/chat/completions`
- Compatibility: OpenAI Chat Completions request/response format
- Chain invocation: set the ordinary `model` field to the exact combo ID `TFR Free Chain`
- Catalog proof: `GET /v1/models` returns `{ "id": "TFR Free Chain", "owned_by": "combo" }`
- Authentication: the gateway is now behind Cloudflare Access. See Authentication below for the current Worker requirements.
- Non-streaming response: standard `chat.completion`; text is at `choices[0].message.content`
- Streaming response: `text/event-stream` with `chat.completion.chunk` events, followed by `data: [DONE]`
- Provider attribution: the live response reliably exposed `x-omniroute-provider` and `x-omniroute-model`, plus `x-omniroute-decision`. The client records only the two explicit attribution headers. It does not guess when either is absent.
- Request identity: `x-omniroute-request-id` is preferred, with `x-request-id` as a request-ID fallback.
- Errors: HTTP `401/403`, `429`, other `4xx`, and `5xx` are normalized as authentication, rate-limit, request, and unavailable categories. Network errors, malformed success bodies, and client timeouts have separate categories. Authentication errors never invoke the direct Gemini fallback.
- Retry semantics: OmniRoute exposes combo/provider retry and failover controls. The application deliberately performs zero OmniRoute retries.
- Timeouts: the application aborts its request after its configured timeout. Provider timeout/retry behavior remains an OmniRoute concern.

The Worker currently requests non-streaming completions. Streaming was verified for compatibility but is not needed by the migrated workflows.

## Authentication

OmniRoute is behind a Cloudflare Access application. Use a dedicated Access
service token for the Worker and provide both Worker Secrets:
`OMNIROUTE_ACCESS_CLIENT_ID` and `OMNIROUTE_ACCESS_CLIENT_SECRET`. The client
and the Command Center probe send the pair only to OmniRoute. If OmniRoute also
requires its API credential, the existing optional bearer header still applies.

An Access redirect or recognizable Access denial is classified as an
authentication error. Authentication failures fail closed, so the Worker
does not invoke the Gemini fallback for them.

## Configuration

Non-secret defaults live in `wrangler.toml`:

| Variable | Default | Purpose |
|---|---|---|
| `OMNIROUTE_ENABLED` | `true` | Migration/rollback switch |
| `OMNIROUTE_BASE_URL` | `https://omniroute.techfusionreport.com` | Gateway origin, without `/v1` |
| `OMNIROUTE_CHAIN` | `TFR Free Chain` | Exact live combo ID |
| `OMNIROUTE_TIMEOUT_MS` | `30000` | Per-request application timeout |
| `OMNIROUTE_FALLBACK_ENABLED` | `true` | Allow one direct Gemini outage fallback |

Worker Secret bindings take precedence over the optional KV fields
`omniroute_access_client_id` and `omniroute_access_client_secret`. Empty
bindings fall back to KV. The client sends neither header if it only has one
value and emits a configuration warning naming the missing binding. Keep the
existing `omniroute_api_key` for optional bearer authentication and
`gemini_api_key` for outage fallback.

Roll out in this order:

1. Create a dedicated Cloudflare Access service token and add it to the OmniRoute Access policy.
2. Set both Worker Secrets on the preview Worker.
3. Verify an authenticated preview request and the Command Center probe.
4. Promote after verification and configure both Secrets for production before relying on the new path.

The same keys can be placed in the KV secret object in lowercase (`omniroute_base_url`, `omniroute_chain`, `omniroute_timeout_ms`, `omniroute_enabled`, and `omniroute_fallback_enabled`), but Worker environment variables take precedence. Central configuration applies to every agent; there are no per-agent OmniRoute endpoints or chain IDs.

## Migrated workflows

- Discovery relevance scoring (legacy fallback model: `gemini-2.0-flash`)
- Enhancement draft, validation, transcript comparison, SEO, and social generation (`gemini-2.5-flash` fallback)
- Publishing social generation (`gemini-2.5-flash` fallback, followed by its pre-existing static-copy fallback)

Archived utilities are not runtime code and intentionally retain their historical direct Gemini calls. YouTube metadata requests are not LLM requests and remain direct.

## Observability

Each attempt emits one structured JSON log with `event: "llm_request"` and the workflow name, requested route/chain, duration, success, error category/status, retry count (`0`), and fallback activation. Successful OmniRoute calls also include request ID and downstream provider/model only when their explicit OmniRoute headers are present.

Prompts, response content, credentials, and full upstream error bodies are not logged. Error body excerpts are bounded for thrown diagnostics.

## Troubleshooting and rollback

1. Check structured Worker logs for `event=llm_request`, `errorCategory`, and `fallbackActivated`.
2. Use the request ID in OmniRoute call logs to inspect the routing decision and provider-side failure.
3. Confirm `GET /v1/models` still contains the exact `TFR Free Chain` ID.
4. For an Access authentication block, check the service-token policy and both Worker Secret bindings. For a gateway bearer denial, check the existing OmniRoute API credential.
5. For repeated `timeout` or `unavailable` events, inspect OmniRoute health and provider cooldowns before increasing the Worker timeout.

Immediate routing rollback does not require a code revert: set `OMNIROUTE_ENABLED` to `false`. All migrated calls then use their legacy Gemini models directly. Keep `OMNIROUTE_FALLBACK_ENABLED=true` during normal operation to prevent the gateway from becoming a single point of failure. To remove the new Access headers, unset both Access Worker Secrets and ensure no equivalent KV fallback is configured. If Access still enforces service-token authentication, clearing the pair leaves OmniRoute blocked. Use `OMNIROUTE_ENABLED=false` for an explicit routing rollback.
