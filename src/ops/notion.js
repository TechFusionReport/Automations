// Notion helpers for the /ops dashboard — Content Catalog v2 only.
// Pure builders + mappers keep the request/response shapes testable; the thin
// client wraps fetch. All property/status strings come from content-catalog.js.

import { CATALOG_PROPERTIES as P, CATALOG_STATUS as S } from '../utils/content-catalog.js';

const NOTION_VERSION = '2022-06-28';
const DRAFT_PREVIEW_LEN = 240;

// ── property accessors ───────────────────────────────────────────────────────
const prop = (page, name) => page.properties?.[name];
const titleText = (page, name) =>
  (prop(page, name)?.title || []).map((t) => t.plain_text ?? t.text?.content ?? '').join('').trim();
const plainText = (page, name) =>
  (prop(page, name)?.rich_text || []).map((t) => t.plain_text ?? t.text?.content ?? '').join('').trim();
const getSelect = (page, name) => prop(page, name)?.select?.name ?? null;
const getMulti = (page, name) => (prop(page, name)?.multi_select || []).map((v) => v.name);
const getUrl = (page, name) => prop(page, name)?.url ?? null;
const getNumber = (page, name) => (typeof prop(page, name)?.number === 'number' ? prop(page, name).number : null);
const getCheckbox = (page, name) => prop(page, name)?.checkbox === true;
const getDate = (page, name) => prop(page, name)?.date?.start ?? null;
const getStatusName = (page, name) => prop(page, name)?.status?.name ?? null;

const notionUrl = (id) => `https://www.notion.so/${String(id).replace(/-/g, '')}`;

function truncate(str, len = DRAFT_PREVIEW_LEN) {
  if (!str) return '';
  return str.length > len ? `${str.slice(0, len)}…` : str;
}

// ── request-body builders ────────────────────────────────────────────────────
export function queryBody({ status, statuses, sorts, pageSize, cursor } = {}) {
  const body = {};
  if (Array.isArray(statuses) && statuses.length) {
    body.filter = { or: statuses.map((name) => ({ property: P.status, status: { equals: name } })) };
  } else if (status) {
    body.filter = { property: P.status, status: { equals: status } };
  }
  if (sorts) body.sorts = sorts;
  if (pageSize) body.page_size = pageSize;
  if (cursor) body.start_cursor = cursor;
  return body;
}

export function statusPatchBody(name) {
  return { [P.status]: { status: { name } } };
}

export function featuredPatchBody(value) {
  return { [P.featured]: { checkbox: value === true } };
}

// ── view mappers ─────────────────────────────────────────────────────────────
export function mapQueueItem(page) {
  return {
    id: page.id,
    notionUrl: notionUrl(page.id),
    title: titleText(page, P.title),
    source: getMulti(page, P.source),
    category: getSelect(page, P.category),
    subcategory: getSelect(page, P.subcategory),
    tags: getMulti(page, P.tags),
    videoUrl: getUrl(page, P.videoUrl),
    createdTime: page.created_time ?? null,
  };
}

export function mapDraftItem(page) {
  const draft = plainText(page, P.blogDraft);
  return {
    id: page.id,
    notionUrl: notionUrl(page.id),
    title: titleText(page, P.title),
    seoTitle: plainText(page, P.seoTitle),
    seoScore: getNumber(page, P.seoScore),
    focusKeyword: plainText(page, P.focusKeyword),
    featured: getCheckbox(page, P.featured),
    videoUrl: getUrl(page, P.videoUrl),
    draftPreview: truncate(draft),
    wordCount: draft ? draft.split(/\s+/).filter(Boolean).length : 0,
    createdTime: page.created_time ?? null,
  };
}

export function mapDraftDetail(page) {
  const transcript = plainText(page, P.transcript);
  const blogDraft = plainText(page, P.blogDraft);
  return {
    ...mapDraftItem(page),
    transcript,
    blogDraft,
    keyPointComparison: plainText(page, P.keyPointComparison),
    transcriptWordCount: transcript ? transcript.split(/\s+/).filter(Boolean).length : 0,
    wordCount: blogDraft ? blogDraft.split(/\s+/).filter(Boolean).length : 0,
  };
}

export function mapBoardItem(page) {
  return {
    id: page.id,
    notionUrl: notionUrl(page.id),
    title: titleText(page, P.title),
    category: getSelect(page, P.category),
    status: getStatusName(page, P.status),
    featured: getCheckbox(page, P.featured),
    publishedToGithub: getCheckbox(page, P.publishedToGithub),
  };
}

export function mapErrorItem(page) {
  return {
    id: page.id,
    notionUrl: notionUrl(page.id),
    title: titleText(page, P.title),
    lastError: plainText(page, P.lastError),
    status: getStatusName(page, P.status),
    source: getMulti(page, P.source),
  };
}

export function mapArchiveItem(page) {
  return {
    id: page.id,
    notionUrl: notionUrl(page.id),
    title: titleText(page, P.title),
    publishedUrl: getUrl(page, P.publishedUrl),
    canonicalUrl: getUrl(page, P.canonicalUrl),
    category: getSelect(page, P.category),
    seoScore: getNumber(page, P.seoScore),
    publishedDate: getDate(page, P.publishedDate),
  };
}

// ── thin fetch client ────────────────────────────────────────────────────────
export function notionClient(token, { fetchImpl = fetch } = {}) {
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Notion-Version': NOTION_VERSION,
  };
  async function readOrThrow(res, label) {
    if (res.ok) return res.json();
    let msg;
    try { msg = (await res.json())?.message; } catch { msg = null; }
    throw new Error(`Notion ${label} failed (${res.status}): ${msg || 'unknown error'}`);
  }
  return {
    async query(dbId, body) {
      const res = await fetchImpl(`https://api.notion.com/v1/databases/${dbId}/query`, {
        method: 'POST', headers, body: JSON.stringify(body || {}),
      });
      return readOrThrow(res, 'query');
    },
    async retrieve(pageId) {
      const res = await fetchImpl(`https://api.notion.com/v1/pages/${pageId}`, { headers });
      return readOrThrow(res, 'retrieve');
    },
    async patch(pageId, properties) {
      const res = await fetchImpl(`https://api.notion.com/v1/pages/${pageId}`, {
        method: 'PATCH', headers, body: JSON.stringify({ properties }),
      });
      return readOrThrow(res, 'patch');
    },
  };
}

// ── counts ───────────────────────────────────────────────────────────────────
const COUNTS_KV_KEY = 'ops_counts_cache';

// Every status that gets its own board column / KPI bucket.
export const COUNTED_STATUSES = [
  S.notStarted, S.pendingReview, S.transcriptionApproved, S.inProgress,
  S.draftGenerated, S.draftReview, S.draftApproval, S.publishApproved,
  S.publishedToGithub, S.errors, S.rejected,
];

// Non-terminal statuses that make up the "in pipeline" figure.
export const IN_PIPELINE_STATUSES = [
  S.pendingReview, S.transcriptionApproved, S.inProgress,
  S.draftGenerated, S.draftReview, S.draftApproval, S.publishApproved,
];

// Count a single status by paginating filtered queries (page_size 100).
export async function countStatus(client, dbId, statusName) {
  let count = 0;
  let cursor;
  do {
    const data = await client.query(dbId, queryBody({ status: statusName, pageSize: 100, cursor }));
    count += (data.results || []).length;
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return count;
}

// Read per-status counts from KV cache; recompute on miss/stale.
// The large Published bucket is expensive to paginate, so a stale cache is
// served immediately and refreshed in the background via ctx.waitUntil.
export async function countsFromCache(env, dbId, client, ctx, { now = Date.now, ttlMs = 120_000 } = {}) {
  let cached = null;
  try {
    const raw = await env.CONTENT_KV.get(COUNTS_KV_KEY);
    if (raw) cached = JSON.parse(raw);
  } catch { cached = null; }

  const fresh = cached && now() - cached.cachedAt < ttlMs;
  if (fresh) return cached;

  const compute = async () => {
    const counts = {};
    for (const status of COUNTED_STATUSES) {
      counts[status] = await countStatus(client, dbId, status);
    }
    const payload = { counts, cachedAt: now() };
    await env.CONTENT_KV.put(COUNTS_KV_KEY, JSON.stringify(payload), { expirationTtl: 1800 });
    return payload;
  };

  // Stale-but-present: serve stale now, refresh in the background.
  if (cached && ctx?.waitUntil) {
    ctx.waitUntil(compute().catch(() => {}));
    return cached;
  }
  // Cold: must compute synchronously.
  return compute();
}
