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

## Manual publishing

The authenticated `POST /admin/publish-poll` route runs one publisher pass.

## Preview Ops UI

`TechFusionReport/Website` owns the canonical `ops/` directory. This repository
keeps a synced copy used only by the preview Worker. Run `npm run sync-ops-ui`
to re-sync from Website's `preview` branch, or pass `-- --ref <ref>` to use a
different ref. Commit the updated `ops/` tree and root `ops-sync.json` together.
Never edit the synced `ops/` files by hand.
