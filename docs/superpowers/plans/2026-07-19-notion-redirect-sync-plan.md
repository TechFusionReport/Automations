# Notion Redirect Sync — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace manual Cloudflare-dashboard KV edits with a Notion database as the entry point for `link-redirect` redirects, plus a `!link` Discord shortcut, per `docs/superpowers/specs/2026-07-19-notion-redirect-sync-design.md`.

**Architecture:** Notion "Redirects" DB → Notion's built-in Database Automation (instant webhook on `Status = Ready`) → new n8n workflow "Notion Redirect Sync" (validates/sanitizes, writes to the existing Cloudflare Workers KV namespace `LINKS`, updates the Notion page) → existing `link-redirect` Worker serves it unchanged. A second entry point, `!link`, is added to the existing Axiom Ops Bot n8n workflow.

**Tech Stack:** Notion API (via MCP), n8n (Oracle instance, via n8n-mcp), Cloudflare API (KV write, via HTTP Request node), Discord (via existing Axiom bot's Discord node pattern).

## Global Constraints

- Cloudflare account ID: `f1310d4330378e55242e878cf33d0a29` (from project memory — verify against `get_publishable_keys`/dashboard if a call fails with an auth/account error).
- KV namespace `LINKS` id: `1359ef24efa64810b23651a001542be5` (existing, already bound to `link-redirect`, do not recreate).
- Cloudflare API auth scheme is `Authorization: Bearer <token>` → n8n credential type is **`httpBearerAuth`**, not `httpHeaderAuth`.
- Notion's native **Database Automations** (the "when Status = Ready → send webhook" feature) are **not exposed by the public Notion API** — no MCP tool can create them. That step is manual, done once by the user in the Notion UI, and is called out explicitly below rather than glossed over.
- The Cloudflare API token itself is a secret — no tool call should ever construct, print, or transmit its raw value in chat or logs. The user pastes it directly into n8n's credential UI.
- Sanitization rule (from spec): trim → lowercase → replace spaces/underscores with hyphens → strip anything not `a-z0-9-`.
- URL validation rule (from spec): non-empty, must start with `http://` or `https://`.
- Axiom Ops Bot workflow id: `JNNqAf1f4NZ6Qs1D`. Existing pattern: `Axiom Webhook` (webhook) → `Parse Command` (code, splits `!cmd args`) → `Command Router` (switch, exact-match on `$json.command`) → one Handler code node per command → `Respond to Discord` (posts `{{ $json.message }}` to guild `1517591908799746239` / channel `1519318363745026210`). A second Discord node, `Ops Log`, already posts every command run to channel `1519318399056871444` — reuse this exact guild/channel pair for the Notion Redirect Sync workflow's failure notifications instead of guessing a new channel.

---

### Task 1: Create the Notion "Redirects" database

**Files:** none (external Notion state) — record the created database ID in a comment at the top of Task 4's workflow once known.

**Interfaces:**
- Produces: a Notion database with properties `Slug` (title), `URL` (url), `Status` (select: `Draft`/`Ready`/`Published`/`Error`), `Last Error` (rich_text). Later tasks reference this database by ID.

- [ ] **Step 1: Load the Notion MCP tools**

Call `ToolSearch` with query `"select:mcp__4d63e4af-79f0-4661-842d-27a7ac93431b__notion-create-database,mcp__4d63e4af-79f0-4661-842d-27a7ac93431b__notion-create-pages,mcp__4d63e4af-79f0-4661-842d-27a7ac93431b__notion-search,mcp__4d63e4af-79f0-4661-842d-27a7ac93431b__notion-update-page"` before calling any of them — their schemas aren't loaded yet.

- [ ] **Step 2: Find a parent page to hold the new database**

Call `notion-search` with a query for wherever redirects-adjacent tooling lives (e.g. `"Automations"` or `"TechFusion OS"` — ask the user which Notion page should be the parent if search doesn't surface an obvious candidate; don't guess a page to nest it under).

- [ ] **Step 3: Create the database**

Call `notion-create-database` with:
- `parent`: the page ID chosen in Step 2
- `title`: `Redirects`
- `properties`:
  - `Slug`: `{ "title": {} }`
  - `URL`: `{ "url": {} }`
  - `Status`: `{ "select": { "options": [{"name": "Draft"}, {"name": "Ready"}, {"name": "Published"}, {"name": "Error"}] } }`
  - `Last Error`: `{ "rich_text": {} }`

Record the returned database ID — every later task that touches Notion needs it.

- [ ] **Step 4: Add the instructions toggle block**

Use the Notion MCP block-append capability (or `notion-update-page` if blocks are appended via page content) to add a toggle block as the first child of the database's page, with this exact copy (verbatim from the spec):

```
▸ ℹ️ How this works — read before adding a redirect
- Add a redirect: fill in Slug (lowercase, hyphens only — spaces/capitals get auto-cleaned) and URL, then set Status to Ready. It goes live within seconds.
- Status meanings: Draft = not ready yet, Ready = triggers publishing, Published = live at notion.techfusionreport.com/<slug>, Error = check Last Error, fix the row, and flip back to Ready to retry.
- Editing or deleting a row that's already Published does not update the live redirect automatically (v1 limitation) — that still needs a manual edit in the Cloudflare KV dashboard.
- Discord shortcut, from the Axiom bot: !link <slug> looks up an existing redirect; !link <slug> <url> creates a new one the same way as adding a row here.
```

If the connected Notion MCP tools don't expose direct block-append for a database's page content, do this step manually in the Notion UI instead and note that in the plan's execution log — don't skip the toggle, just change the method.

- [ ] **Step 5: Backfill the `tasker-fix` row**

Call `notion-create-pages` (or the create-page equivalent) against the new database with:
- `Slug`: `tasker-fix`
- `URL`: `https://techfusionreport.notion.site/tasker-signature-solution`
- `Status`: `Published`

- [ ] **Step 6: Verify**

Query the database (`notion-fetch` or equivalent read) and confirm: 4 properties exist with the right types, the toggle block is visible at the top, and exactly one row (`tasker-fix`, `Published`) exists.

- [ ] **Step 7: Commit**

Nothing to commit to git — this task only touches Notion. Move on to Task 2 once verified.

---

### Task 2: Manual step — configure the Notion Database Automation

**Files:** none.

**Interfaces:**
- Consumes: the database ID from Task 1.
- Produces: a webhook URL that Notion will POST to. This becomes the target URL configured in Task 4's n8n Webhook node — but note the *dependency direction*: you need the n8n Webhook node's URL (Task 4) before you can finish this step, and you need this automation before Task 6's end-to-end test can pass. Do Task 4 far enough to get the webhook URL, then come back here, then finish Task 4's remaining nodes.

This step cannot be done by any connected tool — Notion's public API does not expose Database Automations. Do it directly in the Notion UI:

- [ ] **Step 1:** Open the Redirects database in Notion.
- [ ] **Step 2:** Open the Automations panel (⚡ icon in the database toolbar) → **New automation**.
- [ ] **Step 3:** Trigger: **When** → `Status` → **is** → `Ready`.
- [ ] **Step 4:** Action: **Send webhook**. Paste in the production URL of the n8n Webhook node created in Task 4, Step 2 (e.g. `https://<oracle-n8n-host>/webhook/notion-redirect-sync`).
- [ ] **Step 5:** Save the automation.
- [ ] **Step 6: Verify** — Notion's automation UI usually offers a "send test event" option; use it if available and confirm the n8n workflow's execution log (Task 5) shows an incoming run. If no test option exists, this gets verified for real in Task 6.

---

### Task 3: Manual step — create the Cloudflare API token and n8n credential

**Files:** none.

**Interfaces:**
- Produces: an n8n Credential (type `httpBearerAuth`, suggested name `Cloudflare KV Write`) that Task 4's HTTP Request node references by name via `newCredential('Cloudflare KV Write')`.

- [ ] **Step 1:** In the Cloudflare dashboard, create an API token (My Profile → API Tokens → Create Token) scoped to **Workers KV Storage: Edit** for the account containing namespace `1359ef24efa64810b23651a001542be5`. Do not use the Global API Key.
- [ ] **Step 2:** In n8n (Oracle instance), go to Credentials → New → **Bearer Auth**. Name it exactly `Cloudflare KV Write`. Paste the token from Step 1 into the Token field. Save.
- [ ] **Step 3: Verify** — n8n credential list shows `Cloudflare KV Write` with type Bearer Auth. Do not paste the token anywhere else (chat, this plan file, git).

---

### Task 4: Build the "Notion Redirect Sync" n8n workflow

**Files:** none local — this workflow is created directly on the Oracle n8n instance via n8n-mcp tools. If you want a local backup, export it to `link-redirect/n8n/notion-redirect-sync.json` in the Automations repo (new directory) after Step 5.

**Interfaces:**
- Consumes: Notion Database Automation webhook payload (Task 2), Cloudflare credential `Cloudflare KV Write` (Task 3), account/namespace IDs from Global Constraints.
- Produces: an active n8n workflow reachable at a webhook path; on success sets the Notion page `Status = Published` and writes the KV entry; on failure sets `Status = Error` + `Last Error` and posts to Discord channel `1519318399056871444` in guild `1517591908799746239`.

- [ ] **Step 1: Confirm SDK/node references are loaded**

Already retrieved this session: `get_sdk_reference`, `get_workflow_best_practices` (`data_persistence`, `notification`), and `get_node_types` for `n8n-nodes-base.notion` (`databasePage` create/update/getAll), `n8n-nodes-base.httpRequest`, `n8n-nodes-base.webhook`, `n8n-nodes-base.code`, `n8n-nodes-base.discord`. If executing this plan in a fresh session, re-fetch these first — don't guess node parameter shapes.

- [ ] **Step 2: Write the workflow code**

Use `create_workflow_from_code` (n8n-mcp) with the following SDK code. This is the actual node graph — not a sketch:

```javascript
import { workflow, node, trigger, ifElse, newCredential, expr } from '@n8n/workflow-sdk';

const webhookTrigger = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Notion Automation Webhook',
    parameters: { httpMethod: 'POST', path: 'notion-redirect-sync', options: {} },
    position: [240, 300]
  },
  output: [{ body: { data: { id: 'page-id-abc', properties: { Slug: { title: [{ plain_text: 'Tasker Fix' }] }, URL: { url: 'https://example.com' } } } } }]
});

const sanitizeAndValidate = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Sanitize & Validate',
    parameters: {
      jsCode: `
const body = $input.first().json.body || $input.first().json;
const page = body.data || body;
const pageId = page.id || page.page_id;
const rawSlug = (page.properties?.Slug?.title?.[0]?.plain_text || page.slug || '').toString();
const rawUrl = (page.properties?.URL?.url || page.url || '').toString();

const slug = rawSlug.trim().toLowerCase().replace(/[\\s_]+/g, '-').replace(/[^a-z0-9-]/g, '');

const errors = [];
if (!slug) errors.push('invalid or duplicate slug');
if (!rawUrl || !/^https?:\\/\\//.test(rawUrl)) errors.push('missing or invalid URL');

return [{ json: { pageId, slug, url: rawUrl, valid: errors.length === 0, error: errors.join('; ') } }];
`.trim(),
      position: [540, 300]
    }
  },
  output: [{ pageId: 'page-id-abc', slug: 'tasker-fix', url: 'https://example.com', valid: true, error: '' }]
});

const checkDuplicate = node({
  type: 'n8n-nodes-base.notion',
  version: 2.2,
  config: {
    name: 'Check Existing Slug',
    parameters: {
      resource: 'databasePage',
      operation: 'getAll',
      databaseId: { __rl: true, mode: 'id', value: placeholder('Redirects database ID from Task 1') },
      returnAll: true,
      filterType: 'manual',
      matchType: 'allFilters',
      filters: {
        conditions: [
          { key: 'Slug|title', type: 'title', condition: 'equals', titleValue: expr('{{ $json.slug }}') },
          { key: 'Status|select', type: 'select', condition: 'equals', selectValue: 'Published' }
        ]
      }
    },
    credentials: { notionApi: newCredential('Notion') },
    position: [840, 200]
  },
  output: [{ id: 'some-other-page-id' }]
});

const evaluateValidity = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Evaluate Validity',
    parameters: {
      jsCode: `
const sanitized = $('Sanitize & Validate').item.json;
const dupes = $input.all().filter(i => i.json.id && i.json.id !== sanitized.pageId);

let valid = sanitized.valid;
let error = sanitized.error;
if (valid && dupes.length > 0) {
  valid = false;
  error = 'invalid or duplicate slug';
}
return [{ json: { ...sanitized, valid, error } }];
`.trim(),
      position: [1140, 300]
    }
  },
  output: [{ pageId: 'page-id-abc', slug: 'tasker-fix', url: 'https://example.com', valid: true, error: '' }]
});

const isValid = ifElse({
  version: 2.2,
  config: {
    name: 'Is Valid?',
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
        conditions: [{ leftValue: expr('{{ $json.valid }}'), operator: { type: 'boolean', operation: 'true' } }],
        combinator: 'and'
      }
    },
    position: [1440, 300]
  }
});

const writeToKv = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Write to Cloudflare KV',
    parameters: {
      method: 'PUT',
      url: expr('https://api.cloudflare.com/client/v4/accounts/f1310d4330378e55242e878cf33d0a29/storage/kv/namespaces/1359ef24efa64810b23651a001542be5/values/{{ $json.slug }}'),
      authentication: 'genericCredentialType',
      genericAuthType: 'httpBearerAuth',
      sendBody: true,
      contentType: 'raw',
      rawContentType: 'text/plain',
      body: expr('{{ $json.url }}'),
      options: {}
    },
    credentials: { httpBearerAuth: newCredential('Cloudflare KV Write') },
    onError: 'continueErrorOutput',
    position: [1740, 200]
  },
  output: [{ success: true }]
});

const markPublished = node({
  type: 'n8n-nodes-base.notion',
  version: 2.2,
  config: {
    name: 'Mark Published',
    parameters: {
      resource: 'databasePage',
      operation: 'update',
      pageId: { __rl: true, mode: 'id', value: expr("{{ $('Sanitize & Validate').item.json.pageId }}") },
      propertiesUi: {
        propertyValues: [
          { key: 'Slug|title', type: 'title', title: expr("{{ $('Sanitize & Validate').item.json.slug }}") },
          { key: 'Status|select', type: 'select', selectValue: 'Published' }
        ]
      }
    },
    credentials: { notionApi: newCredential('Notion') },
    position: [2040, 150]
  },
  output: [{ id: 'page-id-abc' }]
});

const markErrorFromInvalid = node({
  type: 'n8n-nodes-base.notion',
  version: 2.2,
  config: {
    name: 'Mark Error (Validation)',
    parameters: {
      resource: 'databasePage',
      operation: 'update',
      pageId: { __rl: true, mode: 'id', value: expr('{{ $json.pageId }}') },
      propertiesUi: {
        propertyValues: [
          { key: 'Status|select', type: 'select', selectValue: 'Error' },
          { key: 'Last Error|rich_text', type: 'rich_text', richText: false, textContent: expr('{{ $json.error }}') }
        ]
      }
    },
    credentials: { notionApi: newCredential('Notion') },
    position: [1740, 450]
  },
  output: [{ id: 'page-id-abc' }]
});

const markErrorFromKvFailure = node({
  type: 'n8n-nodes-base.notion',
  version: 2.2,
  config: {
    name: 'Mark Error (KV Write Failed)',
    parameters: {
      resource: 'databasePage',
      operation: 'update',
      pageId: { __rl: true, mode: 'id', value: expr("{{ $('Sanitize & Validate').item.json.pageId }}") },
      propertiesUi: {
        propertyValues: [
          { key: 'Status|select', type: 'select', selectValue: 'Error' },
          { key: 'Last Error|rich_text', type: 'rich_text', richText: false, textContent: expr('{{ $json.error?.message ?? "Cloudflare API request failed" }}') }
        ]
      }
    },
    credentials: { notionApi: newCredential('Notion') },
    position: [2040, 450]
  },
  output: [{ id: 'page-id-abc' }]
});

const notifyDiscordFailure = node({
  type: 'n8n-nodes-base.discord',
  version: 2,
  config: {
    name: 'Notify Discord Failure',
    parameters: {
      resource: 'message',
      guildId: { __rl: true, mode: 'id', value: '1517591908799746239' },
      channelId: { __rl: true, mode: 'id', value: '1519318399056871444' },
      content: expr('⚠️ Redirect sync failed for slug `{{ $(\\'Sanitize & Validate\\').item.json.slug }}`: {{ $json.error?.message ?? "Cloudflare API request failed" }}'),
      options: {}
    },
    position: [2340, 450]
  },
  output: [{ id: 'discord-message-id' }]
});

export default workflow('notion-redirect-sync', 'Notion Redirect Sync')
  .add(webhookTrigger)
  .to(sanitizeAndValidate)
  .to(checkDuplicate)
  .to(evaluateValidity)
  .to(isValid
    .onTrue(writeToKv.to(markPublished))
    .onFalse(markErrorFromInvalid));

writeToKv.onError(markErrorFromKvFailure.to(notifyDiscordFailure));
```

Note: `placeholder(...)` marks the one value that must be filled in with the real database ID from Task 1 before this compiles/runs — replace it, don't leave it as a placeholder in the live workflow.

- [ ] **Step 3: Validate each node**

Call `validate_node_config` on `Sanitize & Validate`, `Check Existing Slug`, `Write to Cloudflare KV`, `Mark Published`, `Mark Error (Validation)`, `Mark Error (KV Write Failed)`, and `Notify Discord Failure` individually. Fix any parameter/type errors it reports before moving on.

- [ ] **Step 4: Validate the full workflow**

Call `validate_workflow` on the created workflow. Fix any wiring or discriminator errors.

- [ ] **Step 5: Publish and activate**

Call `publish_workflow`. Copy the production webhook URL it reports — this is what Task 2, Step 4 needs.

- [ ] **Step 6: Verify (manual trigger)**

Use `test_workflow` (n8n-mcp) with a synthetic payload shaped like the SDK's `webhookTrigger.output` sample above, using a throwaway slug (e.g. `plan-test-1`). Confirm: `Write to Cloudflare KV` succeeds, `Mark Published` runs, and no Discord message fires. Then run it again with an empty `url` and confirm it routes to `Mark Error (Validation)` instead.

- [ ] **Step 7: Commit**

```bash
cd "/c/Users/admin/Documents/TechFusion/Automations"
git checkout preview
git pull origin preview
mkdir -p link-redirect/n8n
# paste the exported workflow JSON (n8n UI: Download) into link-redirect/n8n/notion-redirect-sync.json
git add link-redirect/n8n/notion-redirect-sync.json
git commit -m "Add Notion Redirect Sync n8n workflow export for reference"
git push origin preview
```

---

### Task 5: End-to-end test via a real Notion row

**Files:** none.

**Interfaces:**
- Consumes: everything from Tasks 1–4, and the live Database Automation from Task 2.

- [ ] **Step 1:** In the Notion Redirects DB, create a row: `Slug = Plan Test 2`, `URL = https://example.com/plan-test-2`, `Status = Draft`.
- [ ] **Step 2:** Flip `Status` to `Ready`.
- [ ] **Step 3: Verify** — within a few seconds: the row's `Slug` becomes `plan-test-2` (sanitized) and `Status` becomes `Published`.
- [ ] **Step 4: Verify the live redirect**

```bash
curl -s -o /dev/null -w "http_code=%{http_code} redirect_url=%{redirect_url}\n" https://notion.techfusionreport.com/plan-test-2
```
Expected: `http_code=302 redirect_url=https://example.com/plan-test-2`

- [ ] **Step 5: Test the failure path** — create a second test row with `URL` left empty, flip to `Ready`, confirm it lands on `Status = Error` with `Last Error = "missing or invalid URL"` and no Discord message (validation errors don't notify per spec). Then edit `Write to Cloudflare KV`'s credential to something invalid temporarily, retry with a valid row, confirm `Status = Error` **and** a Discord message appears in the ops-log channel, then restore the correct credential.
- [ ] **Step 6:** Delete both test rows and the `plan-test-2` KV entry (`DELETE /accounts/f1310d4330378e55242e878cf33d0a29/storage/kv/namespaces/1359ef24efa64810b23651a001542be5/values/plan-test-2` via the same Bearer credential, or the Cloudflare dashboard) to avoid leaving test data live.

---

### Task 6: Add `!link` to the Axiom Ops Bot workflow

**Files:** none local — modifies the existing n8n workflow `JNNqAf1f4NZ6Qs1D` directly.

**Interfaces:**
- Consumes: `Command Router` (existing switch node, keyed on `$json.command`), `Parse Command`'s output shape `{ command, args, raw, isCommand, authorName }`, the Notion Redirects database ID (Task 1), Cloudflare KV read access (same `Cloudflare KV Write` bearer credential — KV Edit scope covers reads too).
- Produces: a new switch case `link` → `Link Handler` node → existing `Respond to Discord` node, matching every other command's wiring.

- [ ] **Step 1: Fetch the current workflow**

Call `get_workflow_details` with `workflowId: "JNNqAf1f4NZ6Qs1D"`. Given its size, redirect output to a file and inspect with Python/jq rather than reading inline (same approach used during planning — see this session's tool-results directory for the reference copy already captured).

- [ ] **Step 2: Add the new switch case to `Command Router`**

Append to the existing `rules.values` array (do not replace the array — every existing case must remain):

```json
{
  "outputKey": "link",
  "conditions": {
    "options": { "caseSensitive": false, "leftValue": "", "typeValidation": "strict" },
    "conditions": [
      { "leftValue": "={{ $json.command }}", "operator": { "type": "string", "operation": "equals" }, "rightValue": "!link" }
    ],
    "combinator": "and"
  }
}
```

- [ ] **Step 3: Add the `Link Handler` code node**

```javascript
const args = ($input.first().json.args || '').trim();
const parts = args.split(/\s+/).filter(Boolean);

if (parts.length === 0) {
  return [{ json: { message: '❌ Usage: `!link <slug>` to look up, or `!link <slug> <url>` to create.' } }];
}

const rawSlug = parts[0];
const slug = rawSlug.trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '');

if (!slug) {
  return [{ json: { message: '❌ That slug has no valid characters left after cleanup — use letters, numbers, and hyphens.' } }];
}

const CF_ACCOUNT_ID = 'f1310d4330378e55242e878cf33d0a29';
const CF_NAMESPACE_ID = '1359ef24efa64810b23651a001542be5';
const kvUrl = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_NAMESPACE_ID}/values/${slug}`;

if (parts.length === 1) {
  // Lookup mode
  try {
    const res = await helpers.httpRequest({
      method: 'GET',
      url: kvUrl,
      headers: { Authorization: `Bearer ${$credentials.cloudflareKvWrite.token}` },
      returnFullResponse: true,
      ignoreHttpStatusErrors: true
    });
    if (res.statusCode === 404) {
      return [{ json: { message: `🔍 No redirect found for \`${slug}\`.` } }];
    }
    return [{ json: { message: `🔗 \`${slug}\` → ${res.body}` } }];
  } catch (e) {
    return [{ json: { message: `❌ Lookup failed: ${e.message}` } }];
  }
}

// Create mode: parts[0] is the slug, the rest is the URL
const url = parts.slice(1).join(' ');
if (!/^https?:\/\//.test(url)) {
  return [{ json: { message: '❌ URL must start with http:// or https://' } }];
}

try {
  await helpers.httpRequest({
    method: 'POST',
    url: 'https://api.notion.com/v1/pages',
    headers: {
      Authorization: `Bearer ${$credentials.notionApi.token}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      parent: { database_id: 'REPLACE_WITH_REDIRECTS_DATABASE_ID' },
      properties: {
        Slug: { title: [{ text: { content: slug } }] },
        URL: { url },
        Status: { select: { name: 'Ready' } }
      }
    })
  });
  return [{ json: { message: `✅ Submitted \`${slug}\` → ${url}. Will go live in a few seconds.` } }];
} catch (e) {
  return [{ json: { message: `❌ Could not create redirect: ${e.message}` } }];
}
```

Replace `REPLACE_WITH_REDIRECTS_DATABASE_ID` with the real ID from Task 1 before saving — this is a required substitution, not an optional TODO.

Note on credential access from a Code node: n8n Code nodes can only reference credentials that are explicitly attached to that node (`$credentials.<name>` only resolves for credentials configured on the node itself, matching how `Scan Handler` already uses `$env.ANTHROPIC_API_KEY` for its Claude call). Attach both `Cloudflare KV Write` (Bearer Auth) and the existing `Notion` API credential to the `Link Handler` node in n8n's node settings panel — this can't be done via a JSON patch alone; confirm it in the n8n editor after import.

- [ ] **Step 4: Wire it in**

Connect `Command Router`'s new `link` output → `Link Handler` → the existing `Respond to Discord` node (same target every other Handler already uses).

- [ ] **Step 5: Validate**

Call `validate_node_config` on `Link Handler`, then `validate_workflow` on the whole Axiom Ops Bot workflow.

- [ ] **Step 6: Publish**

Call `publish_workflow` for `JNNqAf1f4NZ6Qs1D`.

- [ ] **Step 7: Commit**

Axiom's workflow isn't tracked in git today (no existing export in the repo) — skip a git commit for this task unless you choose to add a `docs/superpowers/plans/../axiom-ops-bot.json` reference export; if you do, follow the same branch/commit pattern as Task 4 Step 7.

---

### Task 7: End-to-end test of `!link`

**Files:** none.

**Interfaces:**
- Consumes: Task 6's deployed `Link Handler`, Task 5's now-working sync pipeline.

- [ ] **Step 1:** In the Axiom Discord channel, send `!link plan-test-3 https://example.com/plan-test-3`.
- [ ] **Step 2: Verify** — Axiom replies "Submitted..." within a couple seconds; check the Notion Redirects DB and confirm a new `Published` row appeared with `Slug = plan-test-3`.
- [ ] **Step 3:** Send `!link plan-test-3`.
- [ ] **Step 4: Verify** — Axiom replies with the URL (`🔗 plan-test-3 → https://example.com/plan-test-3`).
- [ ] **Step 5:** Send `!link this-slug-does-not-exist`.
- [ ] **Step 6: Verify** — Axiom replies "No redirect found for `this-slug-does-not-exist`."
- [ ] **Step 7:** Clean up: delete the `plan-test-3` row in Notion and its KV entry, same as Task 5 Step 6.

---

## Self-Review Notes

- **Spec coverage:** Architecture (Task 4), schema+backfill+toggle (Task 1), Database Automation (Task 2), validation rules (Task 4 `Sanitize & Validate`), error handling incl. Discord notification (Task 4 error branches), credentials (Task 3), out-of-scope edits/deletes (not implemented anywhere in this plan — correct, matches spec), testing (Tasks 5 & 7), `!link` (Task 6), domain-scope decision (no code change needed — nothing in this plan touches `link-redirect.js` or its `wrangler.toml`, correctly reflecting the "keep subdomain" decision).
- **Placeholder scan:** two intentional, explicit substitutions remain (`placeholder(...)` in Task 4 Step 2, `REPLACE_WITH_REDIRECTS_DATABASE_ID` in Task 6 Step 3) — both are called out as required, not left vague.
- **Type consistency:** `Sanitize & Validate` produces `{ pageId, slug, url, valid, error }`; `Check Existing Slug` and `Evaluate Validity` both read/reference those exact names; `Mark Published`/`Mark Error (*)` reference `$('Sanitize & Validate').item.json.{pageId,slug,url,error}` consistently throughout.
- **Scope:** single cohesive feature (all four subsystems exist only to serve the one redirect-creation flow); not decomposed further.
