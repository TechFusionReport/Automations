const encoder = new TextEncoder();
const VERSION = 'v1';
const DIGEST = /^[0-9a-f]{64}$/;

export function normalizePageId(id) {
  if (typeof id !== 'string' || !/^(?:[0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i.test(id)) return null;
  return id.replaceAll('-', '').toLowerCase();
}

export function isReceiptGate(gate) {
  return gate === 1 || gate === 2;
}

export function receiptKey(pageId, gate) {
  const id = normalizePageId(pageId);
  if (!id || !isReceiptGate(gate)) throw new Error('Invalid receipt target');
  return `ops:receipt:${id}:${gate}`;
}

function hex(bytes) {
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function hashPublishPayload(payload) {
  // Fixed field order, preserving strings, nulls and the publish order of tags.
  const canonical = [
    payload.title, payload.content, payload.seoTitle, payload.seoSlug, payload.seoMeta,
    payload.focusKeyword, payload.schemaType, payload.jsonLd, payload.image,
    payload.category, payload.subcategory, payload.tags, payload.featured,
    payload.internalLinks, payload.imageAltText,
  ];
  return hex(await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify(canonical))));
}

export function hasReceiptKey(secret) {
  return typeof secret === 'string' && secret.length > 0;
}

async function importKey(secret, usage) {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}

function signedBytes({ version, pageId, gate, approver, contentHash, issuedAt }) {
  return encoder.encode(JSON.stringify([version, pageId, gate, approver, contentHash, issuedAt]));
}

function validClaims({ version, pageId, gate, approver, contentHash, issuedAt }) {
  return version === VERSION && !!pageId && pageId === normalizePageId(pageId)
    && isReceiptGate(gate) && typeof approver === 'string' && /^[^\s@]+@[^\s@]+$/.test(approver)
    && typeof contentHash === 'string' && DIGEST.test(contentHash)
    && Number.isSafeInteger(issuedAt) && issuedAt >= 0;
}

export async function signReceipt(secret, { pageId, gate, approver, contentHash, issuedAt }) {
  const claims = { version: VERSION, pageId: normalizePageId(pageId), gate, approver, contentHash, issuedAt };
  if (!hasReceiptKey(secret) || !validClaims(claims)) throw new Error('Cannot issue receipt');
  const signature = await crypto.subtle.sign('HMAC', await importKey(secret, 'sign'), signedBytes(claims));
  return { ...claims, signature: hex(signature) };
}

export async function verifyReceipt(secret, receipt, pageId, gate) {
  if (!hasReceiptKey(secret) || !receipt || !validClaims(receipt)
    || receipt.pageId !== normalizePageId(pageId) || receipt.gate !== gate
    || typeof receipt.signature !== 'string' || !DIGEST.test(receipt.signature)) return false;

  const signature = Uint8Array.from(receipt.signature.match(/../g), byte => parseInt(byte, 16));
  // Native HMAC verification compares equal-length MACs without a JS string comparison.
  return crypto.subtle.verify('HMAC', await importKey(secret, 'verify'), signature, signedBytes(receipt));
}
