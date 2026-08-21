// /ops dashboard API router. Gates every request behind Cloudflare Access,
// then serves read views + gate actions over Content Catalog v2.
//
// Wired from src/index.js: requests to /ops/api/* are delegated here. Page IDs
// arrive in the POST body (the Worker's core Router is exact-match only).

import { verifyAccessRequest } from './access.js';
import {
  notionClient, queryBody, statusPatchBody, featuredPatchBody, richTextPatchBody,
  mapQueueItem, mapDraftItem, mapDraftDetail, mapBoardItem, mapErrorItem, mapArchiveItem,
  countsFromCache, COUNTED_STATUSES, IN_PIPELINE_STATUSES,
} from './notion.js';
import { CATALOG_PROPERTIES as P, CATALOG_STATUS as S } from '../utils/content-catalog.js';
import { EnhancementOrchestrator } from '../agents/enhancement.js';
import { buildCommandCenter } from './command-center.js';

const DEFAULT_DB = '1fbbd080-de92-8043-89aa-dc02853c15c7';
const SORT_CREATED_ASC = [{ timestamp: 'created_time', direction: 'ascending' }];
const SORT_PUBLISHED_DESC = [{ property: P.publishedDate, direction: 'descending' }];

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

async function getSecrets(env) {
  const raw = await env.CONTENT_KV.get('secrets');
  return raw ? JSON.parse(raw) : {};
}

// ── read views ───────────────────────────────────────────────────────────────
async function listQueue(client, dbId) {
  const data = await client.query(dbId, queryBody({ status: S.pendingReview, sorts: SORT_CREATED_ASC, pageSize: 50 }));
  const items = (data.results || []).map(mapQueueItem);
  return { items, count: items.length };
}

async function listDrafts(client, dbId, cursor, filters = {}) {
  const sortMap = {
    oldest: SORT_CREATED_ASC,
    newest: [{ timestamp: 'created_time', direction: 'descending' }],
    seoHigh: [{ property: P.seoScore, direction: 'descending' }],
    seoLow: [{ property: P.seoScore, direction: 'ascending' }],
  };
  const data = await client.query(dbId, queryBody({
    statuses: [S.draftGenerated, S.draftReview],
    sorts: sortMap[filters.sort] || SORT_CREATED_ASC,
    pageSize: 50,
    cursor,
    title: filters.title,
    category: filters.category,
    source: filters.source,
    featured: filters.featured,
  }));
  const items = (data.results || []).map(mapDraftItem);
  return {
    items,
    count: items.length,
    nextCursor: data.has_more ? data.next_cursor : null,
    hasMore: Boolean(data.has_more),
  };
}

async function listErrors(client, dbId, pageSize = 50) {
  const data = await client.query(dbId, queryBody({ statuses: [S.errors, S.rejected], pageSize }));
  const items = (data.results || []).map(mapErrorItem);
  return { items, count: items.length };
}

async function listArchive(client, dbId, cursor) {
  const data = await client.query(dbId, queryBody({ status: S.publishedToGithub, sorts: SORT_PUBLISHED_DESC, pageSize: 30, cursor }));
  return {
    items: (data.results || []).map(mapArchiveItem),
    nextCursor: data.has_more ? data.next_cursor : null,
    hasMore: Boolean(data.has_more),
  };
}

async function listBoard(env, dbId, client, ctx, now) {
  const { counts } = await countsFromCache(env, dbId, client, ctx, { now });
  const columns = [];
  for (const status of COUNTED_STATUSES) {
    const data = await client.query(dbId, queryBody({ status, pageSize: 8 }));
    columns.push({ status, count: counts[status] ?? (data.results || []).length, items: (data.results || []).map(mapBoardItem) });
  }
  return { columns };
}

// ── overview aggregation ─────────────────────────────────────────────────────
function agentStatus(hb, now) {
  if (!hb) return { status: 'idle', lastHeartbeat: null, throughput: 0 };
  const errored = Array.isArray(hb.errors) && hb.errors.length > 0;
  const ageMs = hb.timestamp ? now() - Date.parse(hb.timestamp) : Infinity;
  const fresh = ageMs < 45 * 60 * 1000;
  const status = errored ? 'degraded' : fresh ? 'running' : 'idle';
  return { status, lastHeartbeat: hb.timestamp || null, throughput: hb.processed || 0 };
}

async function oldestCreatedTime(client, dbId, statusFilter) {
  const data = await client.query(dbId, queryBody({ ...statusFilter, sorts: SORT_CREATED_ASC, pageSize: 1 }));
  return data.results?.[0]?.created_time || null;
}

async function readHeartbeat(env, key) {
  const raw = await env.CONTENT_KV.get(key);
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}

async function buildOverview(env, dbId, client, ctx, now) {
  // Core figure: per-status counts. If this fails, handleOps surfaces the 502
  // (the dashboard genuinely can't render without it).
  const { counts, cachedAt } = await countsFromCache(env, dbId, client, ctx, { now });
  const sum = (list) => list.reduce((n, s) => n + (counts[s] || 0), 0);

  // Non-core enrichments degrade gracefully: a failure (e.g. a wrong assumption
  // about a property type) records a warning instead of blanking the whole page.
  const warnings = [];
  const safe = async (label, fallback, fn) => {
    try { return await fn(); }
    catch (e) { warnings.push(`${label}: ${e.message}`); return fallback; }
  };

  const gate1Backlog = counts[S.pendingReview] || 0;
  const gate2Backlog = (counts[S.draftGenerated] || 0) + (counts[S.draftReview] || 0);
  const ageMs = (iso) => (iso ? now() - Date.parse(iso) : null);

  const gate1Oldest = gate1Backlog
    ? await safe('gate1 age', null, () => oldestCreatedTime(client, dbId, { status: S.pendingReview }))
    : null;
  const gate2Oldest = gate2Backlog
    ? await safe('gate2 age', null, () => oldestCreatedTime(client, dbId, { statuses: [S.draftGenerated, S.draftReview] }))
    : null;

  const [discovery, enhancement, publishing] = await Promise.all([
    readHeartbeat(env, 'last_discovery'),
    readHeartbeat(env, 'last_enhance_poll'),
    readHeartbeat(env, 'last_publish_poll'),
  ]);
  const agents = [
    { name: 'Discovery', ...agentStatus(discovery, now) },
    { name: 'Enhancement', ...agentStatus(enhancement, now) },
    { name: 'Publishing', ...agentStatus(publishing, now) },
  ];

  const recentData = await safe('recent published', { results: [] }, () =>
    client.query(dbId, queryBody({ status: S.publishedToGithub, sorts: SORT_PUBLISHED_DESC, pageSize: 5 })));
  const recentPublished = (recentData.results || []).map(mapArchiveItem);
  const publishedThisMonth = countThisMonth(recentData.results || [], now);

  const errorsView = await safe('errors', { items: [] }, () => listErrors(client, dbId, 5));

  const publishedTotal = counts[S.publishedToGithub] || 0;
  // ⭐ Featured is assumed a checkbox; if it isn't, this degrades to null + warning.
  const featuredCount = await safe('featured count', null, () => countFeatured(client, dbId));

  const health = {
    api: 'ok',
    notion: warnings.length ? 'degraded' : 'ok',
    agents: agents.some((a) => a.status === 'degraded') ? 'degraded' : 'ok',
  };

  return {
    generatedAt: new Date(now()).toISOString(),
    countsCachedAt: cachedAt || null,
    counts,
    warnings,
    kpis: {
      inPipeline: sum(IN_PIPELINE_STATUSES),
      gate1Backlog,
      gate1OldestAgeMs: ageMs(gate1Oldest),
      gate2Backlog,
      gate2OldestAgeMs: ageMs(gate2Oldest),
      errorCount: counts[S.errors] || 0,
      rejectionCount: counts[S.rejected] || 0,
      publishedTotal,
      publishedThisMonth,
      featuredCount,
      featuredRate: (publishedTotal && featuredCount != null)
        ? Number((featuredCount / publishedTotal).toFixed(4))
        : null,
      // Deferred to v2 — need a per-transition event log (out of scope).
      avgWaitGate1: null,
      avgWaitGate2: null,
      automationSuccessRate: null,
      timeToPublishMs: null,
    },
    agents,
    recentPublished,
    errors: errorsView.items,
    health,
  };
}

// Count published pages whose Published Date falls in the current month.
// Input is sorted desc, so we can stop at the first older item.
function countThisMonth(results, now) {
  const d = new Date(now());
  const firstOfMonth = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  let count = 0;
  for (const page of results) {
    const start = page.properties?.[P.publishedDate]?.date?.start;
    if (!start) continue;
    if (Date.parse(start) >= firstOfMonth) count++;
  }
  return count;
}

// Count records flagged ⭐ Featured (checkbox). Featured items are few → cheap.
async function countFeatured(client, dbId) {
  let count = 0;
  let cursor;
  do {
    const body = { filter: { property: P.featured, checkbox: { equals: true } }, page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const data = await client.query(dbId, body);
    count += (data.results || []).length;
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return count;
}

async function auditedProperties(client, pageId, actor, action, changes = {}, note = '') {
  const detail = mapDraftDetail(await client.retrieve(pageId));
  const entry = `[${new Date().toISOString()}] ${actor || 'unknown'} — ${action}${note ? ` — ${note}` : ''}`;
  const audit = [detail.reviewAuditLog, entry].filter(Boolean).join('\n').slice(-15000);
  return { detail, properties: { ...changes, ...richTextPatchBody(P.reviewAuditLog, audit) } };
}

// ── gate actions ─────────────────────────────────────────────────────────────
const ACTION_STATUS = {
  '/actions/approve-transcription': S.transcriptionApproved,
  '/actions/reject': S.rejected,
  '/actions/approve-publish': S.publishApproved,
};

// ── entry ────────────────────────────────────────────────────────────────────
export async function handleOps(request, env, ctx = {}, deps = {}) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/ops/api/')) return null;

  const verify = deps.verify || verifyAccessRequest;
  const now = deps.now || Date.now;
  const sub = url.pathname.slice('/ops/api'.length); // e.g. '/overview'

  const auth = await verify(request, env);
  if (!auth.ok) return json({ error: auth.error }, auth.status || 403);

  const secrets = await getSecrets(env);
  const token = secrets.notion_token || env.NOTION_TOKEN;
  const dbId = secrets.notion_database_id || DEFAULT_DB;
  const client = deps.client || notionClient(token, {});

  try {
    if (request.method === 'GET') {
      if (sub.startsWith('/drafts/')) {
        const pageId = sub.slice('/drafts/'.length);
        if (!/^[0-9a-f-]{32,36}$/i.test(pageId)) return json({ error: 'invalid pageId' }, 400);
        return json(mapDraftDetail(await client.retrieve(pageId)));
      }
      switch (sub) {
        case '/overview': return json(await buildOverview(env, dbId, client, ctx, now));
        case '/command-center': return json(await (deps.commandCenter || buildCommandCenter)(env, secrets, { now }));
        case '/queue': return json(await listQueue(client, dbId));
        case '/drafts': return json(await listDrafts(client, dbId, url.searchParams.get('cursor'), {
          title: url.searchParams.get('q') || '',
          category: url.searchParams.get('category') || '',
          source: url.searchParams.get('source') || '',
          featured: url.searchParams.has('featured') ? url.searchParams.get('featured') === 'true' : undefined,
          sort: url.searchParams.get('sort') || 'oldest',
        }));
        case '/board': return json(await listBoard(env, dbId, client, ctx, now));
        case '/errors': return json(await listErrors(client, dbId));
        case '/archive': return json(await listArchive(client, dbId, url.searchParams.get('cursor')));
        default: return json({ error: 'not found' }, 404);
      }
    }

    if (request.method === 'POST' && sub.startsWith('/actions/')) {
      const body = await request.json().catch(() => ({}));
      const pageId = body.pageId;
      const actor = auth.email || auth.sub || 'access-user';
      const validId = (id) => /^[0-9a-f-]{32,36}$/i.test(String(id || ''));

      if (sub === '/actions/bulk') {
        const ids = Array.isArray(body.pageIds) ? [...new Set(body.pageIds)].filter(validId).slice(0, 25) : [];
        const allowed = { feature: true, unfeature: false, reject: S.rejected, revision: S.draftReview };
        if (!ids.length) return json({ error: '1–25 valid pageIds required' }, 400);
        if (!(body.action in allowed)) return json({ error: 'Bulk publishing is not allowed' }, 400);
        for (const id of ids) {
          const change = ['feature', 'unfeature'].includes(body.action)
            ? featuredPatchBody(allowed[body.action])
            : statusPatchBody(allowed[body.action]);
          const audited = await auditedProperties(client, id, actor, `bulk:${body.action}`, change, body.note);
          await client.patch(id, audited.properties);
        }
        return json({ ok: true, updated: ids.length, message: `${ids.length} records updated` });
      }

      if (!validId(pageId)) return json({ error: 'valid pageId required' }, 400);

      if (sub === '/actions/generate-comparison') {
        const { detail } = await auditedProperties(client, pageId, actor, 'generate comparison');
        const comparison = await new EnhancementOrchestrator(env).generateKeyPointComparison(detail.transcript, detail.blogDraft);
        const changes = {
          ...richTextPatchBody(P.keyPointComparison, comparison),
          [P.comparisonGeneratedAt]: { date: { start: new Date().toISOString() } },
        };
        const audited = await auditedProperties(client, pageId, actor, 'comparison generated', changes);
        await client.patch(pageId, audited.properties);
        return json({ ok: true, comparison, generatedAt: new Date().toISOString(), message: 'Comparison generated' });
      }

      if (sub === '/actions/save-draft') {
        const changes = {
          ...richTextPatchBody(P.blogDraft, body.blogDraft),
          ...richTextPatchBody(P.reviewerNotes, body.reviewerNotes),
        };
        const audited = await auditedProperties(client, pageId, actor, 'draft saved', changes, body.note);
        await client.patch(pageId, audited.properties);
        return json({ ok: true, message: 'Draft and review notes saved' });
      }

      let changes;
      let action = sub.slice('/actions/'.length);
      if (sub === '/actions/toggle-featured') changes = featuredPatchBody(body.value === true);
      else {
        const nextStatus = ACTION_STATUS[sub] || (sub === '/actions/return-revision' ? S.draftReview : null);
        if (!nextStatus) return json({ error: 'not found' }, 404);
        changes = statusPatchBody(nextStatus);
      }
      if (body.reviewerNotes != null) changes = { ...changes, ...richTextPatchBody(P.reviewerNotes, body.reviewerNotes) };
      const audited = await auditedProperties(client, pageId, actor, action, changes, body.note);
      await client.patch(pageId, audited.properties);
      return json({ ok: true, pageId, message: 'Review decision saved' });
    }

    return json({ error: 'not found' }, 404);
  } catch (e) {
    // Surface Notion/other failures inline — never swallow (Agents.md rule).
    return json({ error: e.message }, 502);
  }
}
