# Archive — TechFusion Report Automations

Unused code preserved here for reference. These files are NOT imported anywhere in the active pipeline.
Each entry notes what it does and what phase it belongs to.

---

## utils/analytics.js — `AnalyticsReporter`

**What it does:**
- `getDashboard()` — aggregates all KV `article:` keys into a stats object (totals by category/section, top 10 by views)
- `trackClick(slug, type)` — increments a click counter in KV for a given slug + type

**Note:** References `this.env.ANALYTICS` (Cloudflare Analytics Engine binding) which is not currently configured in `wrangler.toml`.

**Phase:** Phase 3 — wire up when Analytics Engine binding is added and traffic warrants a dashboard.

---

## utils/newsletter.js — `NewsletterGenerator`

**What it does:**
- `generateWeekly()` — pulls last 7 days of articles from KV, sends to Gemini to generate a newsletter (subject line + body)
- `sendWeekly()` — sends the generated newsletter via Buttondown API (currently set to `status: 'draft'`)
- `generatePreview()` — returns the newsletter JSON without sending

**Note:** Uses `gemini-2.0-flash` (outdated — update to `gemini-2.5-flash` before activating). Requires `BUTTONDOWN_API_KEY` in KV secrets.

**Phase:** Phase 3 — wire up when newsletter list is established. Add `/newsletter/send` and `/newsletter/preview` routes in `index.js`.

---

## utils/refresh.js — `ContentRefresher`

**What it does:**
- `identifyStale()` — finds articles older than 6 months, checks each via Gemini for outdated content, queues refresh jobs via `REFRESH_QUEUE`
- `checkFreshness(article)` — asks Gemini to identify outdated info (versions, deprecated APIs, broken links)
- `refreshArticle(slug)` — generates an updated draft and stores it under `refresh:{slug}` in KV
- `createUpdateTask(article, issues)` — creates an "Update Review" Notion page for editorial review

**Note:** Uses `gemini-2.0-flash` (outdated). References `REFRESH_QUEUE` binding not in `wrangler.toml`. Notion property `Status` uses `select` type (wrong — v2 uses `status` type).

**Phase:** Phase 4 — content refresh loop. Requires REFRESH_QUEUE binding + Notion property fix before use.
