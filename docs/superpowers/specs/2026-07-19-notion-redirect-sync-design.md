# Notion → link-redirect KV Sync — Design

**Date:** 2026-07-19
**Status:** Approved, pending implementation plan

## Problem

`link-redirect` (Cloudflare Worker at `notion.techfusionreport.com`, source in `link-redirect/`) resolves slugs to destination URLs via a lookup against Workers KV namespace `LINKS` (id `1359ef24efa64810b23651a001542be5`). Today, adding a redirect means opening the Cloudflare dashboard and manually adding a KV key/value pair. This spec replaces that manual step with a Notion database as the entry point.

## Architecture

```
Notion "Redirects" DB (new database)
  Slug, URL, Status: Draft -> Ready -> Published -> Error, Last Error
        │
        │  Notion Database Automation: "when Status = Ready"
        │  (built-in Notion feature — instant push, not polling)
        ▼
  Send webhook → n8n Webhook node (Oracle)
        │
        ▼
  n8n workflow "Notion Redirect Sync":
    1. Receive webhook payload (page ID, Slug, URL)
    2. Validate & sanitize (see below)
       - invalid → Notion: Status=Error, Last Error=<reason> → stop
    3. HTTP Request → Cloudflare API:
       PUT /accounts/{account_id}/storage/kv/namespaces/1359ef24efa64810b23651a001542be5/values/{sanitized_slug}
       body: URL
       auth: n8n Credential (HTTP Header Auth, Cloudflare API token w/ KV write scope)
       - on failure → Notion: Status=Error, Last Error=<API error>,
                      post failure message to Discord (Axiom bot's ops channel,
                      reusing whatever mechanism the existing Axiom n8n workflow
                      uses to post — confirm exact node during implementation)
       - on success → continue
    4. Notion: update the same page — Slug=<sanitized_slug>, Status=Published
        │
        ▼
  notion.techfusionreport.com/{slug} now resolves via the existing, unmodified
  link-redirect Worker
```

Trigger choice: Notion's built-in Database Automation "Send webhook" action, not n8n's `Notion Trigger` node (which only polls Notion under the hood despite the name). This matches how instant, per-row automation should work here; it's distinct from the existing TFR pipeline workflows (Discovery/Enhancement/Publisher), which are legitimately cron-polling because they process batches of records, not single-row events.

**Domain scope:** Redirects continue to live under `notion.techfusionreport.com` (existing subdomain, existing Worker route). Considered moving to the apex (`techfusionreport.com/tasker-fix`) — verified no Cloudflare Worker or `routes` config currently claims the apex (the apex→www redirect is native GitHub Pages behavior tied to the `Website` repo's `CNAME` file, not a Worker route), so it would have been technically possible. Decided against it: moving would require `link-redirect`'s no-match branch to redirect to `www.techfusionreport.com{path}` instead of 404ing, to preserve existing apex traffic — an avoidable change to production routing for a URL-length win. Subdomain stays as-is.

## Notion "Redirects" DB schema

| Property | Type | Notes |
|---|---|---|
| `Slug` | Title | Path segment, e.g. `tasker-fix`. Overwritten with the sanitized value on success. |
| `URL` | URL | Destination link. |
| `Status` | Select: `Draft`, `Ready`, `Published`, `Error` | Gate — automation only fires on `Ready`. |
| `Last Error` | Text | Populated only when `Status = Error`. |

## Validation (runs before the Cloudflare write)

**Slug:**
1. Trim whitespace, lowercase, replace spaces/underscores with hyphens, strip any character that isn't `a-z0-9-`.
2. If the sanitized result is empty, or collides with another row already `Published`, set `Status = Error`, `Last Error = "invalid or duplicate slug"`, stop.
3. Otherwise the sanitized value is what gets written back to `Slug` and used as the KV key — keeps what's displayed in Notion in sync with what's actually live, and matches `link-redirect.js`'s own `toLowerCase()` normalization on read.

**URL:**
1. Must be non-empty and start with `http://` or `https://`.
2. Otherwise set `Status = Error`, `Last Error = "missing or invalid URL"`, stop.

## Error handling & observability

- Every workflow execution (success or failure) is visible in n8n's own execution log on Oracle regardless of outcome.
- On any failure (validation or Cloudflare API), the Notion row is set to `Status = Error` with a human-readable `Last Error`, so a broken redirect is visible directly in the database instead of silently stuck on `Ready`.
- On Cloudflare API failure specifically, also post a failure notification to Discord via the existing Axiom bot's posting mechanism, so failures surface without needing to open Notion or n8n.
- Re-running: fixing the row's `Slug`/`URL` and flipping `Status` back to `Ready` re-fires the automation.

## Explicitly out of scope (v1)

- **Edits to already-`Published` rows are not synced.** Changing a `URL` or `Slug` on a row that's already `Published` does not update KV automatically — the Database Automation only fires on transition *into* `Ready`. Fixing a live redirect after the fact is a manual KV dashboard edit (existing process), or requires manually resetting `Status` back to `Ready` on that row.
- **Deletes are not synced.** Archiving/deleting a Notion row does not remove the corresponding KV entry. Removing a live redirect stays a manual dashboard operation.
- Both are acceptable for v1 given low redirect volume; can be revisited if this becomes a frequent need.

## Credentials

Cloudflare API token (KV write scope) stored as an n8n Credential (HTTP Header Auth type), attached only to this workflow's HTTP Request node — not an Oracle env var, to keep it scoped and encrypted at rest by n8n rather than shared broadly the way `IDEOGRAM_API_KEY`/`N8N_API_KEY` are.

## Backfill

The existing `tasker-fix` KV entry (added directly via Cloudflare dashboard, predates this system) gets a matching row added to the new Redirects DB: `Slug = tasker-fix`, `URL = https://techfusionreport.notion.site/tasker-signature-solution`, `Status = Published` — so Notion becomes a complete record of all live redirects going forward, not just ones created after this system existed.

## Testing

- Create a test row with a throwaway slug, flip to `Ready`, confirm: KV entry appears, Notion row flips to `Published` with sanitized slug, and `notion.techfusionreport.com/<slug>` 302s correctly.
- Test validation: a row with an empty URL, and a row with a slug containing invalid characters — confirm both land in `Status = Error` with an appropriate `Last Error` and no KV write occurs.
- Test failure path: temporarily point the HTTP Request node at a bad Cloudflare namespace ID or invalid token, confirm `Status = Error` + Discord notification fire correctly, then revert.
