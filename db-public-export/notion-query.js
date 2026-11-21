/**
 * notion-query.js
 * Read-only Notion client for the public export.
 *
 * API choice (per Notion's 2025-09-03 upgrade guide): from that version the query endpoint lives
 * under /v1/data_sources/{id}/query, and GET /v1/databases/{id} returns the database's
 * data_sources. The configured DB_* variable may be either a database id or a data source id;
 * we resolve it. Only GET and the query POST are ever used. Nothing is written to Notion.
 */
import { propertyNames } from './export-mapping.js';

export const NOTION_VERSION = '2025-09-03';
const NOTION_BASE = 'https://api.notion.com';
const MAX_PAGES = 200; // 20,000 rows per database; a runaway cursor must not loop forever

/** Safe to show in reports: carries only an HTTP status and Notion's error code, never ids or text. */
export class NotionError extends Error {
  constructor(status, code) {
    super(`notion_${status}_${code}`);
    this.name = 'NotionError';
    this.status = status;
    this.code = code;
  }
}

/** Errors whose message is safe to put in the export summary. */
export class ExportError extends Error {}

/**
 * Builds a client. `sleep` and `minIntervalMs` are injectable so tests run instantly.
 * Retries 429 (honouring Retry-After) and 5xx / network errors with exponential backoff.
 * Requests are spaced by minIntervalMs to stay under Notion's ~3 requests/second average.
 */
export function createNotionClient({ token, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), minIntervalMs = 350, maxRetries = 4 }) {
  let first = true;
  const backoff = (attempt) => Math.min(500 * 2 ** attempt, 8000);

  async function request(method, path, body) {
    for (let attempt = 0; ; attempt++) {
      if (!first) await sleep(minIntervalMs);
      first = false;
      let res;
      try {
        res = await fetchImpl(`${NOTION_BASE}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            'Notion-Version': NOTION_VERSION,
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
        });
      } catch {
        if (attempt >= maxRetries) throw new NotionError(0, 'network_error');
        await sleep(backoff(attempt));
        continue;
      }
      if (res.ok) return res.json();
      if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
        const retryAfter = Number(res.headers?.get?.('retry-after'));
        await sleep(retryAfter > 0 ? Math.min(retryAfter, 30) * 1000 : backoff(attempt));
        continue;
      }
      let code = 'unknown';
      try { code = (await res.json()).code || code; } catch { /* keep unknown */ }
      throw new NotionError(res.status, code);
    }
  }
  return { request };
}

/** Turns a configured database id (or data source id) into a single data source id. */
export async function resolveDataSourceId(client, configuredId) {
  const id = encodeURIComponent(configuredId);
  try {
    const db = await client.request('GET', `/v1/databases/${id}`);
    const sources = db.data_sources || [];
    if (sources.length === 1) return sources[0].id;
    if (sources.length === 0) throw new ExportError('database_has_no_data_source');
    throw new ExportError('database_has_multiple_data_sources_set_the_variable_to_a_data_source_id');
  } catch (error) {
    // Not a database id: it may already be a data source id.
    if (error instanceof NotionError && (error.status === 400 || error.status === 404)) {
      await client.request('GET', `/v1/data_sources/${id}`); // throws NotionError if it is not one either
      return configuredId;
    }
    throw error;
  }
}

/**
 * Fetches every row of one dataset, requesting only the allowlisted properties.
 * Returns { pages, warnings }. Throws if the name or url property is missing from the schema.
 */
export async function fetchDatasetPages(client, configuredId, dataset) {
  const dataSourceId = await resolveDataSourceId(client, configuredId);
  const schema = (await client.request('GET', `/v1/data_sources/${encodeURIComponent(dataSourceId)}`)).properties || {};

  const warnings = [];
  const ids = [];
  for (const name of propertyNames(dataset)) {
    const prop = schema[name];
    if (!prop) {
      const required = name === dataset.fields.name || name === dataset.fields.url;
      if (required) throw new ExportError(`schema_missing_property:${name}`);
      warnings.push(`missing_property:${name}`);
      continue;
    }
    ids.push(prop.id);
  }

  // filter_properties takes property ids, so Notion only returns the allowlisted columns.
  const query = ids.map((id) => `filter_properties=${encodeURIComponent(id)}`).join('&');
  const path = `/v1/data_sources/${encodeURIComponent(dataSourceId)}/query?${query}`;

  const pages = [];
  let cursor;
  for (let n = 0; n < MAX_PAGES; n++) {
    const result = await client.request('POST', path, { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
    pages.push(...(result.results || []));
    if (!result.has_more || !result.next_cursor) return { pages, warnings };
    cursor = result.next_cursor;
  }
  throw new ExportError('too_many_pages');
}
