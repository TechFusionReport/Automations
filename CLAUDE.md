# CLAUDE.md — TechFusion Report Automations

This file provides persistent context for Claude Code and Codex sessions in this repository.
Read this before taking any action in the codebase.

---

## 🗣️ Terminology & Shorthand

When Justin uses these phrases, this is exactly what they mean. Never interpret them differently.

| What Justin Says | What It Means |
|---|---|
| **task tracker** | ⚡ TFR Task Tracker — TFR business tasks only (`30e1920a-4e2e-4dfc-8715-77aedd2115f8`) |
| **Life Task Tracker** | 🗂️ Personal tasks only (`6a3e9f805a4c40d4871f12564cf44c8a`) |
| **Life Dashboard / Life OS** | 🧭 Personal PARA home — tasks, habits, second brain (`331bd080-de92-81f2-af00-efe2b392d82a`) |
| **Control Center** | 🧠 Top-level workspace hub — Attention triage + links to both sides (`360bd080-de92-8119-91f3-c2d4773d077c`) |
| **Personal Data Layer** | 🗄️ All personal master DBs — Life Task Tracker, Ventures, Time Log, etc. (`360bd080-de92-819d-a6aa-c4c454e1e0ca`) |
| **Second Brain** | 🧠 Digital Memory Hub — personal knowledge databases (`331bd080-de92-8145-99c2-d270c05aff28`) |
| **Time Log** | ⏱️ Master time tracking DB — covers TFR and personal sessions (`c093ef06-f33c-4ab5-b44e-f2b49bf7ac78`) |
| **dev log** | 🛠️ Blog Automation Dev Log (`313bd080-de92-8159-bcee-c3fc4ed83462`) |
| **the pipeline** | Full Cloudflare Workers content pipeline (discovery → enhancement → publishing) |
| **the worker** | `techfusion-api` Worker at `https://techfusion-api.quiet-shadow-2fce.workers.dev` |
| **the dashboard / TFR OS / the OS** | ⚡ TechFusion OS (`31cbd080-de92-81e3-aa4c-d1aed5a4c05a`) |
| **the catalog** | Content Catalog v2 (`1fbbd080-de92-8043-89aa-dc02853c15c7`) |
| **the creator DB** | Content Creators DB (`0403b4267a54467a8bfd7dfb2cc4a7a8`) |
| **the homelab / phonelab** | Personal S25 Ultra + Hetzner — NOT TFR scope. Runs under `justin` user at `~/homelab/` |
| **the server / TFR-Prod** | Hetzner VPS at TFR-Prod hostname |
| **Automations repo** | `TechFusionReport/Automations` (this repo) |
| **Website repo** | `TechFusionReport/Website` |
| **deploy it** | Commit to main → Cloudflare Git integration auto-deploys. Never run wrangler manually. |
| **the poller** | Whichever of `enhancement-poller.js` or `publisher-poller.js` is relevant in context |
| **end-to-end test** | One full record: discovery → Content Catalog v2 → enhancement → publish → GitHub Pages |

**Priority hierarchy:**
🔴 Critical = blocking/today | 🟠 High = this week | 🟡 Medium = this month | ⚪ Low = someday

---

## 🏢 Project Identity

TechFusion Report is a professional tech publication at `techfusionreport.com` covering **Technology**, **Entertainment**, and **Productivity**. This is a business project — not a homelab experiment. All decisions should be made with production stability, content quality, and publication integrity in mind.

---

## 🏗️ Stack Overview

### Hosting & Infrastructure
- **Command center:** ⚡ TechFusion OS in Notion
- **Cloudflare Worker:** `techfusion-api` — deploy via GitHub UI or Codespaces. Never wrangler manually.
- **Content database:** Notion Content Catalog v2
- **VPS:** Hetzner TFR-Prod (`tfr` user)

### GitHub Structure
- `Automations` — Cloudflare Workers backend, agents, pipeline logic (this repo)
- `Website` — GitHub Pages frontend, HTML/CSS/JS, blog posts
- `Master` — reference/docs
- `DiscordBot` — Discord integration

Personal account (`jmsmith1003`) = homelab/personal only. Nothing personal in TechFusionReport org.

### Content Pipeline Flow
```
YouTube RSS / HackerNews / RSS feeds
        ↓
  discovery.js (Cloudflare Worker)
        ↓
  Notion Content Catalog v2
        ↓
  enhancement-poller.js (30-min cron) — Gemini AI
        ↓
  publisher-poller.js (30-min cron) — GitHub Pages commit
        ↓
  techfusionreport.com
```

### Key File Locations
```
src/
  index.js                   — Worker entry, route handler, cron dispatcher
  agents/
    discovery.js             — RSS/YouTube/HackerNews (v6.1.0)
    enhancement.js           — Gemini AI content agent
    publishing.js            — GitHub Pages publishing agent
    enhancement-poller.js    — 30-min Notion poll for enhancement queue
    publisher-poller.js      — 30-min Notion poll for publish queue
  utils/                     — Empty placeholder, intentional
wrangler.toml                — KV bindings, cron schedule, queues
```

### Key IDs & Endpoints
- **Content Catalog v2:** `1fbbd080-de92-8043-89aa-dc02853c15c7`
- **Creator DB:** `0403b4267a54467a8bfd7dfb2cc4a7a8`
- **Option D Record Template:** `325bd080-de92-813b-9322-cf1e63d512de`
- **Worker URL:** `https://techfusion-api.quiet-shadow-2fce.workers.dev`
- **Cron:** `*/30 * * * *`

### Notion Schema Notes
- `Status` uses `{ status: { name: "..." } }` — NOT `select`
- `Source` and `Tags` are `multi_select`
- All v2 property names are emoji-prefixed (`🔗 Published URL`, `✅ Published To Github`, `🚀 Publish to GitHub`)

---

## 🚀 Deployment Rules

Never run `wrangler` directly. Deploy via:
1. **GitHub UI** — edit on main branch → auto-deploys in ~1 min
2. **GitHub Codespaces** — multi-file changes or complex refactors

Secrets stored in **Cloudflare KV** under key `secrets`. Never hardcode keys, commit `.env`, or include `sk-`/`Bearer`/API key patterns in source.

---

## 🔑 Secrets Reference (names only)
- `NOTION_TOKEN`
- `YOUTUBE_API_KEY`
- `GEMINI_API_KEY`
- `GITHUB_PAT`

All rotated March 2026. Retrieve from Cloudflare KV only.

---

## 📐 Coding Standards

- **Runtime:** Cloudflare Workers (V8 isolate) — no Node.js APIs
  - Use `fetch()` not `axios`, `btoa()` not `Buffer.from()`, Web Crypto not Node crypto
- **No external npm deps** in Worker code
- **Error handling:** write failures back to Notion record — never swallow silently
- **KV TTLs:** Discovery dedup = 30-day, Creator DB cache = 5-min

---

## 🧱 Content Standards

- Categories: `Technology`, `Entertainment`, `Productivity` only
- Blog posts: `_posts/YYYY-MM-DD-slug.html` in Website repo
- `posts.json` must be updated after every new post (homepage pulls from it)

---

## 🤖 Codex Agent — Rules & Known Walls

Codex operates in a sandboxed cloud environment. These rules are non-negotiable.

**What Codex CAN do in this repo:**
- Read and edit all JS worker files under `src/`
- Write new agents, utility functions, and GitHub Actions workflows
- Fix bugs in discovery.js, enhancement.js, publishing.js
- Write shell scripts for server-side use (human runs them)
- Write n8n workflow JSON exports and webhook handler modules

**What Codex CANNOT do — hard walls:**
- Deploy to Cloudflare — no wrangler auth in sandbox. Write code only. Human deploys via GitHub UI → auto-deploys in ~1 min.
- Read or write Cloudflare KV — secrets are not accessible. Use placeholder strings in code, document where real values go. Never hardcode real keys.
- SSH to Hetzner or Oracle — code changes only, no server-side execution.
- Test against live Notion workspace — mock Notion API responses in unit tests.
- Run wrangler commands — ARM64 incompatibility + no auth. Always GitHub UI deploy.

**Branch rules for Codex — MANDATORY:**
- ALL changes go to `preview` branch — one branch, all tasks
- Never push to `main` under any circumstances
- Never create additional branches
- Human reviews preview and decides when to push to main
- Main branch auto-deploys to Cloudflare on merge

**When Codex writes code that needs secrets:**
- Use descriptive placeholder: `const token = "NOTION_TOKEN_FROM_KV";`
- Add a comment: `// Retrieved from KV: await env.KV.get('secrets') → parse → .NOTION_TOKEN`
- Never use real token values, never commit .env files

---

## ⚠️ Known Open Issues (last updated 2026-05-14)

- `src/utils/` is empty placeholder — intentional
- 2 posts (Griply, iPhone Air) published with placeholder content — needs re-approval
- XtreamDroid channel: silent discovery failure — RSS feed confirmed valid but records not landing in Content Catalog v2. Root cause unresolved.
- Start Timer button not yet added to TFR Task Tracker — pending manual Notion UI setup (see handoff doc in Control Center)
- Time Log DB relation wired but n8n webhook not yet built — manual time logging interim

---

## 🏠 Scope Boundaries — TFR vs. Homelab

### Server User Structure

| User | Purpose | Scope |
|---|---|---|
| `tfr` | TFR business | This repo — Claude Code, Automations, Website |
| `justin` | Personal homelab | Docker, n8n, Vaultwarden, personal projects |

You are always operating as `tfr`. If a task belongs to `justin`/homelab, stop and say so.

### tmux Layout
```
tmux session: tfr
  Window 0 (tfr)     → Claude Code in ~/tfr/Automations — TFR ONLY
  Window 1 (homelab) → ~/homelab — PERSONAL ONLY
```

---

## 📓 Notion Logging — MANDATORY

**TFR Task Tracker** — update status when tasks start, complete, block, or are discovered.
**Dev Log** — add dated session entry after every session. What was done, what failed, how fixed, what's next. Update Known Issues in same pass.
**CLAUDE.md** — update in the same commit as any stack change. Never let it go stale.

---

## 🎯 Current Priority Order (as of 2026-05-14)

1. ~~Run end-to-end pipeline test~~ ✅
2. ~~Clean up stale files~~ ✅
3. ~~Fix blog.html index~~ ✅
4. ~~Add RSS sources to Creator DB~~ ✅
5. ~~Fix publisher placeholder content bug~~ ✅
6. ~~Set up Content Queue linked DB view on TechFusion OS~~ ✅ (now lives in Control Center)
7. Diagnose XtreamDroid silent discovery failure
8. Build SVG → PNG GitHub Actions workflow
9. Wire GA4 analytics tag into blog-post-template.html and index.html
10. Phase 2: n8n orchestration (error notifications, cron management, Time Log webhook)
