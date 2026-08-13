# TechFusion Report Automations

Cloudflare Workers automation for the TechFusion Report content pipeline. Notion remains the source of truth for workflow and content state.

The production flow is discovery → Content Catalog v2 → enhancement → publishing. Active LLM work is routed centrally through the self-hosted OmniRoute `TFR Free Chain`, with a controlled direct-Gemini fallback for OmniRoute outages. See [OmniRoute integration](docs/omniroute.md) for configuration, architecture, telemetry, and troubleshooting.

Run the available tests with:

```sh
node --test tests/*.test.js tests/*.test.mjs
```
                   
