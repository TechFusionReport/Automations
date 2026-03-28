# CLAUDE.md — TechFusion Report Automations

This file provides persistent context for Claude Code sessions in this repository.
Read this before taking any action in the codebase.

---

## 🗣️ Terminology & Shorthand

When Justin uses these phrases, this is exactly what they mean. Never interpret them differently.

| What Justin Says | What It Means |
|---|---|
| **task tracker** | ⚡ TFR Task Tracker — TFR business tasks only. https://www.notion.so/techfusionreport/9a75e952ff6140c786a1e364ce60eea6?v=31cbd080de9280cba772000c3ac26b91 |
| **Life Task Tracker** | 🗂️ Personal tasks only — Personal, Homelab, Life Admin, Health, Finance (`6a3e9f805a4c40d4871f12564cf44c8a`) |
| **Life OS** | 🧭 PARA home — both trackers, Projects, Areas, Resources, Archive (`331bd080-de92-81f2-af00-efe2b392d82a`) |
| **Second Brain** | 🧠 Digital Memory Hub — personal knowledge databases (`331bd080-de92-8145-99c2-d270c05aff28`) |
| **dev log** | The 🛠️ Blog Automation Dev Log page in Notion (`313bd080-de92-8159-bcee-c3fc4ed83462`) |
| **the pipeline** | The full Cloudflare Workers content pipeline (discovery → enhancement → publishing) |
| **the worker** | `techfusion-api` Cloudflare Worker at `https://techfusion-api.quiet-shadow-2fce.workers.dev` |
| **the dashboard** / **TFR OS** / **the OS** | ⚡ TechFusion OS — TFR command center (`31cbd080-de92-81e3-aa4c-d1aed5a4c05a`) |
| **the catalog** | Content Catalog v2 Notion database (`1fbbd080-de92-8043-89aa-dc02853c15c7`) |
| **the creator DB** | Content Creators Notion database (`0403b4267a54467a8bfd7dfb2cc4a7a8`) |
| **the homelab** / **phonelab** | Personal S25 Ultra + Hetzner cloud setup — NOT TFR business scope. Runs under `justin` user at `~/homelab/` |
| **the server** / **TFR-Prod** | The Hetzner VPS running at the TFR-Prod hostname |
| **Automations repo** | `TechFusionReport/Automations` GitHub repository (this repo) |
| **Website repo** | `TechFusionReport/Website` GitHub repository |
| **deploy it** | Commit to main → Cloudflare Git integration auto-deploys. Never run wrangler manually. |
| **the poller** | Whichever of `enhancement-poller.js` or `publisher-poller.js` is relevant in context |
| **end-to-end test** | One full record flowing: discovery → Content Catalog v2 → enhancement → publish → GitHub Pages |

**Priority hierarchy — used in both TFR Task Tracker and Life Task Tracker:**
🔴 Critical = blocking or must happen today | 🟠 High = this week | 🟡 Medium = this month | ⚪ Low = someday

When in doubt about what a phrase refers to, check this list before asking for clarification.

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
- **Command center:** ⚡ TechFusion OS in Notion (`31cbd080-de92-81e3-aa4c-d1aed5a4c05a`)
- **Cloudflare Worker:** `techfusion-api` — `https://techfusion-api.quiet-shadow-2fce.workers.dev`
  - Deploy via GitHub UI direct edit or Cloudflare Git integration. Never run wrangler manually.
- **Content database:** Notion Content Catalog v2
- **VPS:** Hetzner TFR-Prod (`tfr` user) — Claude Code sessions, repo management

### GitHub Structure
**TechFusionReport org** = TFR business only. All repos are peers — no hierarchy:
- `Automations` — Cloudflare Workers backend, agents, pipeline logic (this repo)
- `Website` — GitHub Pages frontend, HTML/CSS/JS, blog posts
- `Master` — reference/docs
- `DiscordBot` — Discord integration

**Personal account (`jmsmith1003`)** = homelab scripts, personal projects, experiments. Nothing personal belongs in the TechFusionReport org.

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
- `blog.html` index auto-population not yet working
- Inline DB view + button setup on TechFusion OS dashboard needs manual Notion UI setup
- `src/utils/` is empty — placeholder kept intentionally

---

## 🏠 Scope Boundaries — TFR vs. Personal Homelab

### Server User Structure
The Hetzner TFR-Prod server runs two users with deliberate separation:

| User | Purpose | Scope |
|---|---|---|
| `tfr` | TFR business work | This repo — Claude Code, Automations, Website |
| `justin` | Personal homelab | Docker, n8n, Vaultwarden, personal projects |

**You are always operating as the `tfr` user.** If a task belongs to the `justin` user
or the homelab, stop and say so. Do not cross user boundaries.

### tmux Window Layout
```
tmux session: tfr
  Window 0 (tfr)     → Claude Code in ~/tfr/Automations — TFR ONLY
  Window 1 (homelab) → ~/homelab work — PERSONAL ONLY
```
Switch windows: Ctrl+B then 0 (TFR) or Ctrl+B then 1 (homelab).

### What Belongs Here vs. Homelab

| ❌ Personal / Homelab (justin user) | ✅ TFR Business (tfr user) |
|---|---|
| Docker, Traefik, Portainer | Cloudflare Workers pipeline |
| Vaultwarden, n8n personal | Notion content database |
| Home Assistant, Pi-hole | GitHub Pages website |
| Facebook Reels pipeline | Creator DB channel management |
| Server config, system-level changes | TFR content verticals |

### Why This Separation Exists
TechFusion Report is a professional publication with revenue potential.
Keeping personal projects out of TFR infrastructure ensures clean documentation,
professional credibility, and clear boundaries if TFR ever becomes a formal business entity.
This is not just a preference — treat it as a hard rule.

The homelab has its own CLAUDE.md at `~/homelab/CLAUDE.md` with its own context.
If Justin switches to homelab work, he will launch Claude Code from that directory instead.

---

## 📓 Notion Logging — MANDATORY (no prompting needed)

**TFR Task Tracker** — update TFR task status whenever something starts, completes, blocks, or is discovered. Keeps Justin productive on the business side.
URL: https://www.notion.so/techfusionreport/9a75e952ff6140c786a1e364ce60eea6?v=31cbd080de9280cba772000c3ac26b91

**Dev Log** — add a dated session entry after every session. What was done, what failed, how it was fixed, what's next. Update the Known Issues table (`## 🐛 Known Issues`) in the same pass.
Page ID: `313bd080-de92-8159-bcee-c3fc4ed83462`

**CLAUDE.md** — update in the same commit as any stack change. Never let it go stale.

---

## 🎯 Current Priority Order
1. ~~Run end-to-end pipeline test~~ ✅ Complete (2026-03-28)
2. ~~Clean up stale files from repo root and src/~~ ✅ Complete (2026-03-28)
3. Fix blog.html index auto-population from posts.json
4. Set up Content Queue linked DB view on TechFusion OS dashboard
5. Phase 2: n8n orchestration (Add Channel workflow, error notifications, cron management)
