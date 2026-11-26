// Visible approval evidence for the two /ops human gates.
//
// The HMAC receipt (ops:receipt:<id>:<gate>) stays the authority for whether a
// record is approved. This module only keeps a small, unsigned audit record per
// gate+page under its own AGENT_STATE key so /ops can show who approved what and
// when. Nothing here signs, verifies or changes receipts.

import { CATALOG_STATUS as S } from '../utils/content-catalog.js';
import { isReceiptGate, normalizePageId } from '../utils/ops-receipts.js';
import { describeError } from '../utils/safe-error.js';
import { mapErrorItem } from './notion.js';
import { readSignedReceipt } from './receipts.js';

export const EVIDENCE_PREFIX = 'approval-evidence:';
export const RECENT_WINDOW_DAYS = 14;
export const RECENT_LIMIT = 50;
const DAY_MS = 24 * 60 * 60 * 1000;
// Guards against an unbounded KV walk: 20 pages × 1000 keys.
const MAX_LIST_PAGES = 20;
// Parallel Notion title lookups per batch, to stay near Notion's rate limit.
const TITLE_CONCURRENCY = 5;

// A record in the gate's failure status is waiting for a human to re-authorize
// it through the same approve endpoint, so a still-valid receipt must not block it.
const REAUTHORIZE_STATUS = Object.freeze({ 1: S.transcriptionFailed, 2: S.publishFailed });

export function evidenceKey(gate, pageId) {
  const id = normalizePageId(pageId);
  if (!id || !isReceiptGate(gate)) throw new Error('Invalid evidence target');
  return `${EVIDENCE_PREFIX}${gate}:${id}`;
}

// approver is the email claim from the verified Access JWT; "unknown" when absent.
export function buildEvidence({ gate, pageId, approver, approvedAt }) {
  return {
    gate,
    pageId: normalizePageId(pageId),
    approvedAt: new Date(approvedAt).toISOString(),
    approver: typeof approver === 'string' && approver.trim() ? approver.trim() : 'unknown',
  };
}

// Receipts issued before this feature have no evidence record; derive one so the
// idempotent response still says who approved and when.
export function evidenceFromReceipt(receipt) {
  return { ...buildEvidence({
    gate: receipt.gate, pageId: receipt.pageId, approver: receipt.approver, approvedAt: receipt.issuedAt,
  }), source: 'receipt' };
}

export function isReauthorization(gate, status) {
  return status === REAUTHORIZE_STATUS[gate];
}

// Never throws: the audit write must not fail an approval that already succeeded.
export async function writeEvidence(env, evidence, { warn = console.warn } = {}) {
  try {
    await env.AGENT_STATE.put(evidenceKey(evidence.gate, evidence.pageId), JSON.stringify(evidence), {
      // Metadata lets the recent list filter and sort without a get per key.
      metadata: { approvedAt: evidence.approvedAt, approver: evidence.approver },
    });
    return true;
  } catch (error) {
    warn(`approval evidence write failed: ${describeError(error)}`);
    return false;
  }
}

export async function readEvidence(env, gate, pageId) {
  try {
    const raw = await env.AGENT_STATE.get(evidenceKey(gate, pageId));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function listEvidenceEntries(env, gate) {
  const prefix = `${EVIDENCE_PREFIX}${gate}:`;
  const entries = [];
  let cursor;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const result = await env.AGENT_STATE.list({ prefix, ...(cursor ? { cursor } : {}) });
    for (const key of result.keys || []) {
      let meta = key.metadata;
      // Fall back to the value if metadata is missing (e.g. a hand-written key).
      if (!meta?.approvedAt) meta = await readEvidence(env, gate, key.name.slice(prefix.length));
      const approvedMs = Date.parse(meta?.approvedAt);
      if (!Number.isFinite(approvedMs)) continue;
      entries.push({
        pageId: key.name.slice(prefix.length),
        approvedAt: new Date(approvedMs).toISOString(),
        approvedMs,
        approver: meta.approver || 'unknown',
      });
    }
    if (result.list_complete || !result.cursor) break;
    cursor = result.cursor;
  }
  return entries;
}

// Items approved at one gate in the last 14 days, newest first, capped at 50.
// Pages Notion can't return are skipped and counted rather than failing the list.
export async function listRecentApprovals(env, client, gate, {
  now = Date.now, windowDays = RECENT_WINDOW_DAYS, limit = RECENT_LIMIT,
} = {}) {
  const since = now() - windowDays * DAY_MS;
  const candidates = (await listEvidenceEntries(env, gate))
    .filter(entry => entry.approvedMs >= since)
    .sort((a, b) => b.approvedMs - a.approvedMs)
    .slice(0, limit);

  const items = [];
  let skipped = 0;
  for (let i = 0; i < candidates.length; i += TITLE_CONCURRENCY) {
    const batch = candidates.slice(i, i + TITLE_CONCURRENCY);
    const results = await Promise.allSettled(batch.map(async entry => {
      const page = await client.retrieve(entry.pageId);
      if (normalizePageId(page?.id) !== entry.pageId) throw new Error('page mismatch');
      const receiptActive = Boolean(await readSignedReceipt(env, entry.pageId, gate).catch(() => null));
      return { entry, page, receiptActive };
    }));
    for (const result of results) {
      if (result.status !== 'fulfilled') { skipped++; continue; }
      const { entry, page, receiptActive } = result.value;
      const view = mapErrorItem(page);
      items.push({
        pageId: entry.pageId,
        gate,
        title: view.title || 'Untitled',
        notionUrl: view.notionUrl,
        approvedAt: entry.approvedAt,
        approver: entry.approver,
        // False once save-draft, return-revision or reject revoked the receipt.
        receiptActive,
      });
    }
  }
  return { gate, windowDays, limit, items, skipped };
}
