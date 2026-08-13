# TechFusion Report Automations

Read `Agents.md` before changing this repository. The current production stack and operational rules are documented there.

Active LLM calls use `src/utils/llm-client.mjs`, which routes through OmniRoute's exact `TFR Free Chain` combo ID. OmniRoute owns provider selection and provider-level retries. The application makes one gateway attempt and may fall back once to the legacy Gemini model. Configuration and troubleshooting are documented in `docs/omniroute.md`.

Notion remains the source of truth for pipeline state. Never deploy with Wrangler, commit secrets, or push directly to `main`.
