# TechFusion Report Automations

Cloudflare Workers automation for the TechFusion Report content pipeline. Notion remains the source of truth for workflow and content state.

The production flow is discovery → Content Catalog v2 → enhancement → publishing. Active LLM work is routed centrally through the self-hosted OmniRoute `TFR Free Chain`, with a controlled direct-Gemini fallback for OmniRoute outages. See [OmniRoute integration](docs/omniroute.md) for configuration, architecture, telemetry, and troubleshooting.

Run the available tests with:

```sh
node --test tests/*.test.js tests/*.test.mjs
```

## Approval receipts

`OPS_RECEIPT_KEY` is a Worker secret used to sign and verify /ops approval receipts.
`POST /receipts/verify` uses the Worker’s existing authentication and returns a
verdict for a live Content Catalog record and gate.
