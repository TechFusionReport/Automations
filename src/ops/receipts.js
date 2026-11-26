import { CATALOG_PROPERTIES as P } from '../utils/content-catalog.js';
import {
  hasReceiptKey, hashPublishPayload, isReceiptGate, normalizePageId, receiptKey, verifyReceipt,
} from '../utils/ops-receipts.js';
import { notionClient } from './notion.js';

export async function readPublishPayload(client, page) {
  const props = page.properties || {};
  const richText = name => props[name]?.rich_text?.map(r => r.plain_text || r.text?.content || '').join('').trim() || '';
  // Publish from the same block-first snapshot that receipts authorize.
  const blocks = await client.listBlocks(page.id, 50);
  let content;
  for (const block of blocks.results || []) {
    const label = block.toggle?.rich_text?.[0]?.text?.content || '';
    if (block.type !== 'toggle' || !label.includes('BLOG DRAFT')) continue;
    const children = await client.listBlocks(block.id);
    const draft = (children.results || []).filter(b => b.type === 'paragraph')
      .map(b => b.paragraph?.rich_text?.map(r => r.text?.content || '').join('') || '')
      .join('\n\n').trim();
    if (draft.length > 200 && !draft.includes('populates here after enhancement')) {
      content = draft;
      break;
    }
  }

  const title = props[P.title]?.title?.[0]?.text?.content || 'Untitled';
  const thumbnail = props[P.thumbnail];
  return {
    title,
    content: content || richText(P.blogDraft) || null,
    seoTitle: richText(P.seoTitle) || title,
    seoSlug: richText(P.seoSlug) || null,
    seoMeta: richText(P.seoMeta) || null,
    focusKeyword: richText(P.focusKeyword) || null,
    schemaType: props[P.schemaType]?.select?.name || 'Article',
    jsonLd: richText(P.jsonLd) || null,
    image: thumbnail?.url || thumbnail?.files?.[0]?.external?.url || thumbnail?.files?.[0]?.file?.url || null,
    category: props[P.category]?.select?.name || 'General',
    subcategory: props[P.subcategory]?.select?.name || '',
    tags: props[P.tags]?.multi_select?.map(tag => tag.name) || [],
    featured: props[P.featured]?.checkbox || false,
    internalLinks: richText(P.internalLinks) || null,
    imageAltText: richText(P.imageAltText) || null,
  };
}

export async function recordContentHash(client, page, payload) {
  return hashPublishPayload(payload ?? await readPublishPayload(client, page));
}

export async function readSignedReceipt(env, pageId, gate) {
  const raw = await env.AGENT_STATE.get(receiptKey(pageId, gate));
  if (raw == null) return null;
  let receipt;
  try { receipt = JSON.parse(raw); } catch { return null; }
  return await verifyReceipt(env.OPS_RECEIPT_KEY, receipt, pageId, gate) ? receipt : null;
}

export async function verifyRecordReceipt(env, client, pageId, gate, { snapshot = false } = {}) {
  if (!hasReceiptKey(env.OPS_RECEIPT_KEY)) return { valid: false, reason: 'unavailable' };
  try {
    const receipt = await readSignedReceipt(env, pageId, gate);
    if (!receipt) return { valid: false, reason: 'no_valid_receipt' };
    if (gate === 2 && !await readSignedReceipt(env, pageId, 1)) {
      return { valid: false, reason: 'no_valid_gate_1' };
    }
    const page = await client.retrieve(pageId);
    if (!page || normalizePageId(page.id) !== normalizePageId(pageId)) {
      return { valid: false, reason: 'unavailable' };
    }
    const payload = await readPublishPayload(client, page);
    const hash = await recordContentHash(client, page, payload);
    return hash === receipt.contentHash
      ? { valid: true, reason: 'valid', ...(snapshot ? { page, payload, hash } : {}) }
      : { valid: false, reason: 'content_changed' };
  } catch {
    return { valid: false, reason: 'unavailable' };
  }
}

export async function handleReceiptVerification(request, env) {
  const respond = (result, status = 200) => Response.json(result, {
    status,
    headers: { 'Cache-Control': 'private, no-store' },
  });
  const body = await request.json().catch(() => null);
  const pageId = normalizePageId(body?.pageId);
  if (!pageId || !isReceiptGate(body?.gate)) return respond({ valid: false, reason: 'invalid_request' }, 400);
  if (!hasReceiptKey(env.OPS_RECEIPT_KEY)) return respond({ valid: false, reason: 'unavailable' });
  try {
    const secrets = JSON.parse(await env.CONTENT_KV.get('secrets') || '{}');
    const client = notionClient(secrets.notion_token || env.NOTION_TOKEN);
    return respond(await verifyRecordReceipt(env, client, pageId, body.gate));
  } catch {
    return respond({ valid: false, reason: 'unavailable' });
  }
}
