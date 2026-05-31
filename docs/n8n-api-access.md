# n8n API Access Setup

This document describes how to make n8n available for controlled automation work without committing secrets.

## Scope

- n8n runs under the `justin` user on the homelab side.
- Do not store the n8n API key in this repository.
- Keep repo changes on `preview`; a human reviews and decides when to merge.

## Required Environment Variables

```bash
N8N_BASE_URL="https://YOUR_N8N_HOST"
N8N_API_KEY="YOUR_REAL_N8N_API_KEY"
```

`N8N_BASE_URL` is the externally reachable n8n base URL. Do not include `/api/v1`.

`N8N_API_KEY` is generated in the n8n UI and must be stored in the runtime environment, a password manager, or another approved secret store. Never paste it into source code, workflow JSON, Notion, or chat.

## Human Setup Steps

1. Log in to n8n as the admin user.
2. Open user settings.
3. Create an API key for automation work.
4. Store the key as `N8N_API_KEY` in the environment where the API client or future connector runs.
5. Store the n8n URL as `N8N_BASE_URL`.
6. Restart the process that needs those variables.

## Repo Helper

Use `src/utils/n8n-api-client.js` for API calls from Node-based scripts:

```js
const { createN8nApiClient } = require('./src/utils/n8n-api-client.js');

const n8n = createN8nApiClient();
const workflows = await n8n.listWorkflows();
```

The helper reads `N8N_BASE_URL` and `N8N_API_KEY` from environment variables by default.

## Supported Actions

- List workflows
- Fetch one workflow
- Create workflow
- Update workflow
- Delete workflow
- Activate workflow
- Deactivate workflow

## Safety Notes

- Prefer draft/inactive workflow updates first.
- Do not activate or overwrite production workflows without explicit human approval.
- Export workflow JSON into `n8n/workflows/` before major edits when possible.
- Keep credentials in n8n credential storage, not workflow JSON.
