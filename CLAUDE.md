# TechFusion Report Automations

Read `Agents.md` before changing this repository. The current production stack and operational rules are documented there.

Active LLM calls use `src/utils/llm-client.mjs`, which routes through OmniRoute's exact `TFR Free Chain` combo ID. OmniRoute owns provider selection and provider-level retries. The application makes one gateway attempt and may fall back once to the legacy Gemini model. Configuration and troubleshooting are documented in `docs/omniroute.md`.

Notion remains the source of truth for pipeline state. Never deploy with Wrangler, commit secrets, or push directly to `main`.

The `/ops/api/attention` endpoint is the unified operator action queue. It aggregates—not duplicates—Notion content exceptions and the existing Command Center's authoritative task, GitHub, and service-health signals. Content records expose a stable `jobId` in the form `tfr:<32-character Notion page id>` so later n8n, extractor, OmniRoute, GitHub, and observability events can use the same correlation key.

Enhancement ownership is intentionally split by capability: `/ops` records human authorization and audit metadata, while n8n workflow `YF1dipB0E8BSF5Ae` is the sole enhancement processor and Status narrator. The Cloudflare Worker no longer runs enhancement polling or accepts direct, admin, batch, or queue-triggered enhancement writes; legacy HTTP endpoints return `410 Gone`. Publishing remains Worker-enabled until its ownership is migrated separately.
