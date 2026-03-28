# CLAUDE.md — TechFusion Report Automations

This file provides persistent context for Claude Code sessions in this repository.
Read this before taking any action in the codebase.

---

## 🏢 Project Identity

**TechFusion Report (TFR)** is a professional tech-focused publication at `techfusionreport.com`.
It covers three content verticals: **Technology**, **Entertainment**, and **Productivity**.

This is a **business project** — not a personal or homelab experiment. All decisions here
should be made with production stability, content quality, and publication integrity in mind.
Do not conflate TFR work with personal homelab tinkering (see Scope Boundaries below).

---

## 🏗️ Stack Overview

### Hosting & Infrastructure
- **Website:** GitHub Pages (`TechFusionReport/Website` repo) — static site
- **Automation backend:** Cloudflare Workers (`techfusion-api`)
  - Worker URL: `https://techfusion-api.quiet-shadow-2fce.workers.dev`
  - Deployed via **GitHub UI direct edit** or **Cloudflare Git integration** (auto-deploys on push to main)
- **Content database:** Notion (Content Catalog v2)
- **VPS:** Hetzner TFR-Prod server — used for Claude Code sessions, repo management, and future self-hosted services (n8n, etc.)

### Content Pipeline Flow
```
YouTube RSS / HackerNews / RSS feeds
        ↓
  discovery.js (Cloudflare Worker)
  - Reads active channels from Notion Creator DB
  - Fetches RSS feeds, scores content, deduplicates via KV
        ↓
  Notion Content Catalog v2 (new record created with Option D template)
        ↓
  enhancement-poller.js (30-min cron)
  - Finds records with Status = "Ready to Enhance"
  - Calls Gemini AI for transcription, blog draft, SEO, social copy
  - Writes content into existing template toggle blocks
        ↓
  publisher-poller.js (30-min cron)
  - Finds records where "🚀 Publish to GitHub" = true AND "✅ Published To Github" = false
  - Commits HTML post to Website repo at _posts/YYYY-MM-DD-slug.html
  - Updates Notion record with published URL and date
        ↓
  GitHub Pages (live blog post at techfusionreport.com)
```

### Key File Locations
```
src/
  index.js               — Worker entry point, route handler, cron dispatcher
  agents/
    discovery.js         — RSS/YouTube/HackerNews discovery agent (v6.1.0)
    enhancement.js       — Gemini AI content enhancement agent
    publishing.js        — GitHub Pages publishing agent
    enhancement-poller.js — Polls Notion every 30 min for enhancement queue
    publisher-poller.js  — Polls Notion every 30 min for publish queue
wrangler.toml            — Cloudflare Worker config (KV bindings, cron schedule, queues)
```

### Key IDs & Endpoints
- **Content Catalog v2 DB:** `1fbbd080-de92-8043-89aa-dc02853c15c7`
- **Creator DB:** `0403b4267a54467a8bfd7dfb2cc4a7a8`
- **Content Catalog OG DB:** `88afd236-b35d-4dc3-ab13-00a9f5b90241`
- **Option D Record Template:** `325bd080-de92-813b-9322-cf1e63d512de`
- **Worker:** `https://techfusion-api.quiet-shadow-2fce.workers.dev`
- **Cron schedule:** `*/30 * * * *` (every 30 minutes)

### Notion Schema Notes
- `Status` property uses `{ status: { name: "..." } }` — NOT `select`
- `Source` and `Tags` are `multi_select`
- All v2 property names are emoji-prefixed (e.g. `🔗 Published URL`, `✅ Published To Github`, `🚀 Publish to GitHub`)
- Templates must be passed as `children` block arrays — Notion API does not support `template_id`

---

## 🚀 Deployment Rules

**NEVER run `wrangler` directly from this server's terminal.**
The Hetzner VPS runs Linux x86_64 which supports wrangler, but all deployments
should go through one of these two methods to keep things consistent and auditable:

1. **GitHub UI** — edit files directly on the main branch in github.com → Cloudflare Git
   integration auto-deploys within ~1 minute
2. **GitHub Codespaces** — for multi-file changes or complex refactors that need
   testing before committing

Secrets are stored in **Cloudflare KV** under the key `secrets` — never hardcode
API keys, tokens, or credentials in source files. Never commit `.env` files or
any file containing `sk-`, `Bearer`, or API key patterns.

---

## 🔑 Secrets Reference (names only — never log values)
- `NOTION_TOKEN` — Notion integration API key
- `YOUTUBE_API_KEY` — YouTube Data API key
- `GEMINI_API_KEY` — Google Gemini AI key
- `GITHUB_PAT` — GitHub Personal Access Token for committing posts

All rotated as of March 2026. Retrieve from Cloudflare KV, never from source files.

---

## 📐 Coding Standards

- **Runtime:** Cloudflare Workers (V8 isolate) — no Node.js APIs
  - Use `fetch()` not `axios`, `btoa()` not `Buffer.from()`, Web Crypto not Node crypto
- **No external npm dependencies** in Worker code — keep it dependency-free
- **Error handling:** On failure, write error details back to the Notion record's
  content (don't silently swallow errors)
- **KV TTLs:** Discovery dedup = 30-day TTL, Creator DB cache = 5-min TTL
- **Queue routing:** Enhancement messages route through `processMessage()` in enhancement.js

---

## 🧱 Content Standards

- Categories must be one of: `Technology`, `Entertainment`, `Productivity`
- Section values map from Creator DB `Content Type` field via `CONTENT_TYPE_MAP`
- Blog posts live at `_posts/YYYY-MM-DD-slug.html` in the Website repo
- `posts.json` in the Website repo must be updated when new posts are added
  (homepage auto-populates from this file)

---

## ⚠️ Known Open Issues (as of 2026-03-28)
- Repo still contains stale files needing cleanup: `techfusion-api/`, `techfusion-admin/`,
  `estate/`, `wrangler.toml.backup`, `wrangler-admin.toml`, old `.yaml`/`.py` scripts
- `blog.html` index auto-population not yet working
- Inline DB view + button setup on TechFusion OS dashboard needs manual Notion UI setup
- Enhancement agent writes blog draft to `📝 Blog Draft` property (2000 char limit due to
  Notion rich_text cap) — full draft does not populate the toggle blocks in page content yet
- Gemini model: uses `gemini-2.5-flash` (confirmed available for this API key as of 2026-03-28)

---

## 🏠 Scope Boundaries — TFR vs. Personal Homelab

This repository is **strictly TFR business scope**. Do not mix in:

| Personal / Homelab | TFR Business |
|---|---|
| Hetzner server config, Docker, Traefik, Portainer | Cloudflare Workers pipeline |
| Vaultwarden, Pi-hole, WireGuard, Home Assistant | Notion content database |
| Facebook Reels pipeline | GitHub Pages website |
| Personal n8n experiments | TFR content verticals |
| S25 Ultra Termux setup | Creator DB channel management |

If a task involves personal homelab infrastructure (server hardening, self-hosted apps,
personal automation ideas), that work does not belong in this repo. Keep a separate
workspace or notes for homelab/personal projects.

The Hetzner VPS is shared infrastructure — it hosts both TFR work (this repo) and
future personal homelab services — but the **code in this repo** is TFR-only.

---

## 📓 Notion Logging — MANDATORY

After every completed task or work session, you MUST update the TFR Notion workspace.
This is non-negotiable and does not require being asked. Do it automatically.

### Dev Log
**Page ID:** `313bd080-de92-8159-bcee-c3fc4ed83462`
**URL:** https://www.notion.so/313bd080de928159bceec3fc4ed83462

Add a new session entry under `## 🗓️ Session Logs` as a `<details>` toggle block with today's date:

```
📅 YYYY-MM-DD — [Brief session title]

What we did:
- Bullet list of everything completed this session

Issues encountered:
- Any errors, blockers, or unexpected behavior

How we corrected them:
- Solutions and workarounds applied

Next steps:
- What should happen next in priority order
```

### Known Issues Table
Also update the `## 🐛 Known Issues` table in the same dev log page:
- Mark completed tasks as `🟢 Fixed` with a note on how it was resolved
- Add new issues discovered as `🔴 Open`
- Update `🟡 In Progress` items with current status
- Move items to `⏳ Phase 2` if deferred

### CLAUDE.md Self-Maintenance
This file must stay current. Update it whenever any of the following change:
- A new agent, file, or route is added to the codebase
- A Notion DB ID, Worker URL, or secret name changes
- A known issue is resolved or a new one is discovered
- The deployment process changes
- The pipeline flow changes (new steps, removed steps, new pollers)
- A new repo or service is added to the stack
- The priority order shifts

Update CLAUDE.md **in the same commit** as the code change that made it stale.
Do not defer CLAUDE.md updates — an outdated context file causes bad decisions in future sessions.

### Logging Frequency
- **After every discrete task** — if you fix a bug, add a feature, or complete a refactor, log it
- **At minimum once per session** — even if the session was exploratory or inconclusive
- **Always log before ending a session** — never leave a session without updating the dev log

### What to Capture
Always include: what was attempted, what worked, what didn't, any error messages encountered,
the solution applied, and the explicit next action. Be specific — vague entries like
"fixed some stuff" are not acceptable. Future sessions depend on this log being accurate.

---

## 🎯 Current Priority Order
1. ~~Run end-to-end pipeline test~~ ✅ Complete (2026-03-28)
2. Clean up stale files from repo root and src/
3. Fix blog.html index auto-population from posts.json
4. Set up Content Queue linked DB view on TechFusion OS dashboard
5. Phase 2: n8n orchestration (Add Channel workflow, error notifications, cron management)
