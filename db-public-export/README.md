# db-public-export

Worker that turns five Notion databases into cleaned public JSON in R2, for the client-side search pages on techfusionreport.com. It makes no AI/LLM calls and writes nothing to Notion.

## Routes (attach `www.techfusionreport.com/data/*`)

| Route | What it does |
|---|---|
| `GET /data/{smartphone-apps,gtk-websites,ai-tools,open-source-alternatives,self-hosting-tools}.json` | Serves the object from R2. `Cache-Control: public, max-age=300`, CORS `*`. Any other name is a JSON 404, and so is a file that has not been exported yet. |
| `POST /data/_export` | Header `X-Export-Key` must equal `EXPORT_KEY` (constant-time compare, `401` otherwise). Runs the export for all five databases and returns `{ ok, results, finishedAt }`. |

There is no cron here. n8n schedules the `POST` later. The response is `200` even when a database failed; check `ok` and each `results[name].status` (`written`, `kept_old`, `error`).

## File shape

```json
{ "updated": "ISO timestamp", "count": 0, "items": [
  { "id": "slug", "name": "", "url": "https://", "description": "", "category": "", "tags": [],
    "platform": "", "price": "", "pricing": "", "rating": "", "alternativeTo": "", "badges": [] } ] }
```

`id`, `name`, `url` and `tags` are always present. Other fields are omitted when empty. `badges` is an optional array of fixed keys, only `"editors-choice"` and/or `"area-j"`; it is present (`[]` when none) for sources that have the checkboxes (today: Self-Hosting Tools) and omitted for the others. `alternativeTo` is a string for Open Source Alternatives and an array of strings for Self-Hosting Tools. Notion page ids and URLs are never exported.

## What is read (allowlist)

Only these Notion properties are requested or read. Everything else is ignored.

| Database | Properties |
|---|---|
| Smartphone Apps | Name, Description, Platform, Paid/Free, Price, Rating, Tags, URL; Verdict and Discontinued for filtering only (keep `Verdict = Keep`, drop Discontinued) |
| GTK Websites | Website, URL, Category, Description, Tags |
| AI Tools | AI Tool, `Descripton` (misspelled in Notion, on purpose), URL, Price, Pricing, Tags |
| Open Source Alternatives | Name, AlternativeTo, Home Website, Tags. `Brief` and `OSAT Link` are not exported (third-party content, licensing unresolved). |
| Self-Hosting Tools | App Name, Website, `Desciption` (misspelled in Notion, on purpose), Workflow, Alternative To, Why (as tags); checkboxes `Editor's Choice` (straight apostrophe) and `Area J` for badges. **No Evaluated filter**: every row with a name and a valid `https` URL is exported. Host, Status, Notes, Final Review, Sourced From, Date Added, Evaluated and page bodies are never read. |

Rows without a name or a valid `https` URL are skipped (`http` is upgraded). Ids are slugs of the name, sorted by name before suffixes (`-2`, `-3`) are assigned, so they do not depend on Notion's row order.

## Tags

Only tags listed in [`db-public-export/public-tags.json`](public-tags.json) are published. It ships empty, so **no tags are published** until an approved list is committed:

```json
{ "allow": ["Notes", "Budgeting"], "aliases": { "Finances": "Budgeting" } }
```

Matching is case-insensitive. An alias maps a Notion tag to an allowed tag.

## Safety guard

Each database is written only after it was fully fetched and mapped. If the new count is below 50% of the existing R2 file's count (when that count is above 10), or the Notion call failed, the old file is kept and the run reports it. One database failing never stops the others.

## Notion API

Uses `Notion-Version: 2025-09-03`. `GET /v1/databases/{id}` resolves the database's data source, then `POST /v1/data_sources/{id}/query` (page_size 100, cursor, `filter_properties` limited to the allowlist). A `DB_*` value may be a database id or a data source id. Requests are spaced about 350 ms apart; 429 (honouring `Retry-After`) and 5xx are retried with backoff. The integration must be read-only and shared with each database.

## SETUP CHECKLIST (Justin)

1. Create the R2 bucket (name it `tfr-public-data`, or change `bucket_name` in `wrangler.toml` to match).
2. Create the Worker `db-public-export` in Cloudflare Workers Builds from this repo. Use `db-public-export/` as the root directory; the Worker is self-contained (it imports only files in that folder). Do not use `wrangler` on the ARM64 box.
3. Confirm the `DATA_BUCKET` binding points at the bucket.
4. Add Worker **secrets** in the dashboard: `NOTION_TOKEN` (read-only integration) and `EXPORT_KEY` (a long random string).
5. Add Worker **variables**: `DB_SMARTPHONE_APPS`, `DB_GTK_WEBSITES`, `DB_AI_TOOLS`, `DB_OPEN_SOURCE_ALTERNATIVES`, `DB_SELF_HOSTING_TOOLS` (database ids). `keep_vars = true` stops deploys from wiping them.
6. Share each of the five databases with the read-only Notion integration. The Self-Hosting Tools database lives under Control Center / Master Data Layer, so share it from there (sharing a parent page also covers its children). If a badge checkbox is missing from the schema the export warns and carries on; if App Name or Website is missing, that database fails and the others still run.
7. Add the route `www.techfusionreport.com/data/*` to the Worker.
8. Approve a tag list and commit it to `db-public-export/public-tags.json` (optional; until then no tags are published).
9. Trigger the first export: `curl -X POST -H "X-Export-Key: $EXPORT_KEY" https://www.techfusionreport.com/data/_export`, then check `ok: true` and open one `/data/*.json` file.
10. Add the n8n schedule that calls the same `POST`.

This Worker is not in `.github/workflows/deploy.yml`. Deployment goes through Workers Builds, as above.

## Tests and dry run

```sh
node --test tests/*.test.js tests/*.test.mjs
```

`scripts/db-export-dry-run.mjs` runs the same mapping against real Notion, read-only, and writes the would-be JSON to `./out/` (gitignored). It prints counts, skip reasons and a tag-frequency table, never row text. It reads `TFR_NOTION_READONLY_TOKEN`, `TFR_DB_SMARTPHONE_APPS`, `TFR_DB_GTK_WEBSITES`, `TFR_DB_AI_TOOLS` and `TFR_DB_OPEN_SOURCE_ALTERNATIVES` and `TFR_DB_SELF_HOSTING_TOOLS` from your shell. It also prints, per database, how many rows carry at least one badge (a count only, no row text).
