/**
 * export-runner.js
 * The Worker's request handler and the export itself. Everything external (fetch, R2, clock,
 * sleep) is injected so the whole flow runs under mocks in tests.
 */
import { DATASETS, buildDataset, normalizeTagConfig } from './export-mapping.js';
import { createNotionClient, fetchDatasetPages, ExportError } from './notion-query.js';

const MIN_GUARD_COUNT = 10;   // the guard only applies when the old file had more rows than this
const GUARD_RATIO = 0.5;      // refuse to overwrite if the new count is below 50% of the old

const CORS = { 'Access-Control-Allow-Origin': '*' };

function json(body, status, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS, ...extra },
  });
}

/** Constant-time string compare: hash both sides so length and content never short-circuit. */
export async function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/** True when the new export is suspiciously small compared to the file already in R2. */
export function belowGuard(oldCount, newCount) {
  return oldCount > MIN_GUARD_COUNT && newCount < oldCount * GUARD_RATIO;
}

async function existingCount(bucket, key) {
  const object = await bucket.get(key);
  if (!object) return 0;
  try {
    const old = JSON.parse(await object.text());
    if (Number.isInteger(old?.count)) return old.count;
    return Array.isArray(old?.items) ? old.items.length : 0;
  } catch {
    return 0; // unreadable old file: nothing worth protecting
  }
}

/** Exports one database. Never throws; failures come back as { status: 'error', error }. */
async function exportDataset(dataset, { env, client, tagConfig, now }) {
  const key = `${dataset.name}.json`;
  try {
    const dbId = env[dataset.envVar];
    if (!dbId) throw new ExportError(`missing_config:${dataset.envVar}`);

    const { pages, warnings } = await fetchDatasetPages(client, dbId, dataset);
    const { output, read, skipped } = buildDataset(dataset, pages, tagConfig, now());

    const oldCount = await existingCount(env.DATA_BUCKET, key);
    if (belowGuard(oldCount, output.count)) {
      return { status: 'kept_old', count: oldCount, read, skipped, warnings,
        error: `guard_new_count_${output.count}_below_50_percent_of_${oldCount}` };
    }
    // Written only after the whole database was fetched and mapped successfully.
    await env.DATA_BUCKET.put(key, JSON.stringify(output), { httpMetadata: { contentType: 'application/json' } });
    return { status: 'written', count: output.count, read, skipped, warnings };
  } catch (error) {
    // Only our own error classes carry text that is safe to report; anything else is generic.
    const message = error instanceof ExportError || error?.name === 'NotionError' ? error.message : 'unexpected_error';
    return { status: 'error', error: message };
  }
}

/** Runs the export for all four databases, sequentially (Notion rate limits). */
export async function runExport({ env, tagConfig, fetchImpl, sleep, minIntervalMs, now = () => new Date() }) {
  const results = {};
  if (!env.NOTION_TOKEN || !env.DATA_BUCKET) {
    const error = `missing_config:${!env.NOTION_TOKEN ? 'NOTION_TOKEN' : 'DATA_BUCKET'}`;
    for (const dataset of DATASETS) results[dataset.name] = { status: 'error', error };
    return { ok: false, results };
  }
  const client = createNotionClient({ token: env.NOTION_TOKEN, fetchImpl, sleep, minIntervalMs });
  for (const dataset of DATASETS) {
    results[dataset.name] = await exportDataset(dataset, { env, client, tagConfig, now });
  }
  return { ok: Object.values(results).every((r) => r.status === 'written'), results };
}

/** Builds the Worker fetch handler. `rawTagConfig` is config/public-tags.json. */
export function createHandler({ rawTagConfig, fetchImpl, sleep, minIntervalMs } = {}) {
  const tagConfig = normalizeTagConfig(rawTagConfig);
  const names = new Set(DATASETS.map((d) => d.name));

  return async function handle(request, env) {
    const { pathname } = new URL(request.url);
    const method = request.method;

    if (pathname === '/data/_export') {
      if (method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { Allow: 'POST' });
      if (!env.EXPORT_KEY || !(await safeEqual(request.headers.get('X-Export-Key'), env.EXPORT_KEY))) {
        return json({ error: 'unauthorized' }, 401);
      }
      const summary = await runExport({ env, tagConfig, fetchImpl: fetchImpl || fetch, sleep, minIntervalMs });
      // Counts and status only; never row contents.
      console.log(JSON.stringify({ event: 'db_export', ok: summary.ok,
        results: Object.fromEntries(Object.entries(summary.results).map(([k, v]) => [k, `${v.status}:${v.count ?? '-'}`])) }));
      return json({ ...summary, finishedAt: new Date().toISOString() }, 200);
    }

    const match = pathname.match(/^\/data\/([a-z0-9-]+)\.json$/);
    if (!match || !names.has(match[1])) return json({ error: 'not_found' }, 404);

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { ...CORS, 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS', 'Access-Control-Max-Age': '86400' } });
    }
    if (method !== 'GET' && method !== 'HEAD') return json({ error: 'method_not_allowed' }, 405, { Allow: 'GET, HEAD, OPTIONS' });

    const object = await env.DATA_BUCKET.get(`${match[1]}.json`);
    if (!object) return json({ error: 'not_found', detail: 'export has not run yet' }, 404);
    return new Response(method === 'HEAD' ? null : object.body, {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300', ...CORS },
    });
  };
}
