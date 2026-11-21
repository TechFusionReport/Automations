/**
 * db-public-export.js
 * Worker entry. Serves /data/{name}.json from R2 and runs the Notion -> R2 export on
 * POST /data/_export (called by n8n; this Worker has no cron). See README.md in this folder.
 *
 * Bindings: DATA_BUCKET (R2). Secrets: NOTION_TOKEN (read-only integration), EXPORT_KEY.
 * Vars: DB_SMARTPHONE_APPS, DB_GTK_WEBSITES, DB_AI_TOOLS, DB_OPEN_SOURCE_ALTERNATIVES.
 */
import publicTags from './public-tags.json' with { type: 'json' };
import { createHandler } from './export-runner.js';

const handle = createHandler({ rawTagConfig: publicTags });

export default {
  fetch: (request, env) => handle(request, env),
};
