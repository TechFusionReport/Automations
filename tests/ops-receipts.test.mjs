import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../src/index.js';
import { handleOps } from '../src/ops/router.js';
import { recordContentHash, verifyRecordReceipt } from '../src/ops/receipts.js';
import { CATALOG_PROPERTIES as P } from '../src/utils/content-catalog.js';
import { hashPublishPayload, receiptKey, signReceipt, verifyReceipt } from '../src/utils/ops-receipts.js';

const pageId = crypto.randomUUID();
const approver = 'editor@example.invalid';
const issuedAt = Date.UTC(2026, 0, 2);
const draft = 'Unpublished draft text for the receipt test';
const target = { pageId, gate: 1, approver, contentHash: 'a'.repeat(64), issuedAt };
const rich = content => ({ rich_text: [{ text: { content } }] });

function fixture(t) {
  const entries = new Map();
  const env = {
    OPS_RECEIPT_KEY: crypto.randomUUID(),
    WORKER_SHARED_SECRET: crypto.randomUUID(),
    CONTENT_KV: { get: async () => null },
    AGENT_STATE: {
      get: async key => entries.get(key) ?? null,
      put: async (key, value) => entries.set(key, value),
      delete: async key => entries.delete(key),
    },
  };
  const page = {
    id: pageId,
    properties: {
      [P.title]: { title: [{ text: { content: 'Test title' } }] },
      [P.blogDraft]: rich(draft),
    },
  };
  const client = {
    retrieve: t.mock.fn(async () => structuredClone(page)),
    listBlocks: t.mock.fn(async () => ({ results: [] })),
    patch: t.mock.fn(async (_id, changes) => Object.assign(page.properties, changes)),
  };
  const deps = { client, now: () => issuedAt, verify: async () => ({ ok: true, email: approver }) };
  function action(name, fields = {}) {
    return handleOps(new Request(`https://worker.example/ops/api/actions/${name}`, {
      method: 'POST',
      body: JSON.stringify({ pageId, ...fields }),
    }), env, {}, deps);
  }
  return { env, page, client, action, entries };
}

test('HMAC round trip binds every receipt field and uses native fixed-length verification', async t => {
  const key = crypto.randomUUID();
  const check = t.mock.method(crypto.subtle, 'verify');
  const receipt = await signReceipt(key, target);
  assert.equal(await verifyReceipt(key, receipt, pageId, 1), true);
  assert.equal(check.mock.calls[0].arguments[0], 'HMAC');
  assert.equal(check.mock.calls[0].arguments[2].byteLength, 32);
  const edits = {
    version: 'v2', pageId: crypto.randomUUID().replaceAll('-', ''), gate: 2,
    approver: 'other@example.invalid', contentHash: 'b'.repeat(64), issuedAt: issuedAt + 1,
    signature: (receipt.signature.startsWith('0') ? '1' : '0') + receipt.signature.slice(1),
  };
  for (const [name, value] of Object.entries(edits)) {
    const changed = { ...receipt, [name]: value };
    assert.equal(await verifyReceipt(key, changed, changed.pageId, changed.gate), false, name);
  }
  assert.equal(await verifyReceipt(key, receipt, pageId, 2), false);
  assert.equal(await verifyReceipt('', receipt, pageId, 1), false);
  await assert.rejects(signReceipt('', target), /Cannot issue receipt/);
});

test('approval signs the snapshot and preserves the checkbox and receipt audit', async t => {
  const { env, page, client, action, entries } = fixture(t);
  assert.equal((await action('approve-publish')).status, 409);
  assert.equal(client.patch.mock.callCount(), 0);
  assert.equal((await action('approve-transcription')).status, 200);
  const gate1 = JSON.parse(entries.get(receiptKey(pageId, 1)));
  assert.equal(gate1.approver, approver);
  assert.equal(gate1.issuedAt, issuedAt);
  assert.equal(page.properties[P.approvedForTranscription].checkbox, true);
  assert.deepEqual(await verifyRecordReceipt(env, client, pageId, 1), { valid: true, reason: 'valid' });

  page.properties[P.blogDraft] = rich('The reviewed draft');
  page.properties[P.seoScore] = { number: 100 };
  assert.deepEqual(await verifyRecordReceipt(env, client, pageId, 1), { valid: false, reason: 'content_changed' });
  assert.equal((await action('approve-publish', { note: 'Reviewed' })).status, 200);
  const gate2 = JSON.parse(entries.get(receiptKey(pageId, 2)));
  assert.deepEqual(client.patch.mock.calls[1].arguments[1], { [P.seoScore]: { number: 0 } });
  assert.equal(page.properties[P.seoScore].number, 0);
  assert.equal(page.properties[P.publishToGithub].checkbox, true);
  assert.equal(page.properties[P.status], undefined);
  const audit = page.properties[P.reviewAuditLog].rich_text.map(chunk => chunk.text.content).join('');
  assert.ok(audit.includes(`approve-transcription (receipt ${gate1.signature.slice(0, 8)})`));
  assert.ok(audit.includes(`approve-publish (receipt ${gate2.signature.slice(0, 8)}) — Reviewed`));
  assert.deepEqual(await verifyRecordReceipt(env, client, pageId, 2), { valid: true, reason: 'valid' });

  page.properties[P.blogDraft] = rich('Direct edit after approval');
  assert.deepEqual(await verifyRecordReceipt(env, client, pageId, 2), { valid: false, reason: 'content_changed' });

  await env.AGENT_STATE.put(receiptKey(pageId, 1), JSON.stringify({ ...gate1, approver: 'other@example.invalid' }));
  assert.equal((await action('approve-publish')).status, 409);
});

test('hash reflects the same block draft precedence and publisher defaults', async t => {
  const { client, page } = fixture(t);
  const blockDraft = 'A'.repeat(210);
  client.listBlocks.mock.mockImplementation(async id => id === pageId
    ? { results: [{ type: 'toggle', id: 'draft-block', toggle: rich('TFR BLOG DRAFT') }] }
    : { results: [{ type: 'paragraph', paragraph: rich(blockDraft) }] });
  const expected = {
    title: 'Test title', content: blockDraft, seoTitle: 'Test title', seoSlug: null,
    seoMeta: null, focusKeyword: null, schemaType: 'Article', jsonLd: null,
    image: null, category: 'General', subcategory: '', tags: [], featured: false,
    internalLinks: null, imageAltText: null,
  };
  assert.equal(await recordContentHash(client, page), await hashPublishPayload(expected));
  const originalHash = await hashPublishPayload(expected);
  for (const name of Object.keys(expected)) {
    const changed = Array.isArray(expected[name]) ? ['Different tag'] : 'changed';
    assert.notEqual(await hashPublishPayload({ ...expected, [name]: changed }), originalHash, name);
  }
});

for (const name of ['save-draft', 'return-revision', 'reject', 'bulk revision', 'bulk reject']) {
  test(`${name} revokes the applicable receipts even if the draft is unchanged`, async t => {
    const { env, client, action, entries } = fixture(t);
    assert.equal((await action('approve-transcription')).status, 200);
    assert.equal((await action('approve-publish')).status, 200);
    const fields = name.startsWith('bulk') ? { pageIds: [pageId], action: name.slice(5) } : { blogDraft: draft };
    assert.equal((await action(name.split(' ')[0], fields)).status, 200);
    assert.equal(entries.has(receiptKey(pageId, 1)), !name.endsWith('reject'));
    assert.equal(entries.has(receiptKey(pageId, 2)), false);
    assert.equal((await verifyRecordReceipt(env, client, pageId, 2)).valid, false);
  });
}

test('checkbox-only records and missing keys fail closed', async t => {
  const { env, page, client, action, entries } = fixture(t);
  page.properties[P.approvedForTranscription] = { checkbox: true };
  page.properties[P.publishToGithub] = { checkbox: true };
  for (const gate of [1, 2]) {
    assert.deepEqual(await verifyRecordReceipt(env, client, pageId, gate), { valid: false, reason: 'no_valid_receipt' });
  }
  assert.equal(client.retrieve.mock.callCount(), 0);
  assert.equal((await action('approve-transcription')).status, 200);
  delete env.OPS_RECEIPT_KEY;
  assert.equal((await action('approve-transcription')).status, 503);
  assert.equal((await action('approve-publish')).status, 503);
  // Only the first approval's receipt exists (its approval-evidence key is separate).
  assert.equal([...entries.keys()].filter(key => key.startsWith('ops:receipt:')).length, 1);
  assert.deepEqual(await verifyRecordReceipt(env, client, pageId, 1), { valid: false, reason: 'unavailable' });
});

test('verification route uses Worker auth and redacts private data on success and error', async t => {
  const { env, page, action, client, entries } = fixture(t);
  const logs = ['log', 'info', 'warn', 'error', 'debug'].map(method => t.mock.method(console, method, () => {}));
  assert.equal((await action('approve-transcription')).status, 200);
  const approval = await action('approve-publish');
  const stored = entries.get(receiptKey(pageId, 2));
  const secretText = [env.OPS_RECEIPT_KEY, JSON.parse(stored).signature, stored, draft];
  const approvalText = await approval.text();
  assert.equal(approval.status, 200);
  const fetch = t.mock.method(globalThis, 'fetch', async input => new URL(input).pathname.startsWith('/v1/blocks/')
    ? Response.json({ results: [] })
    : Response.json(page));
  const post = headers => worker.fetch(new Request('https://worker.example/receipts/verify', {
    method: 'POST',
    headers,
    body: JSON.stringify({ pageId, gate: 2 }),
  }), env, {});
  assert.equal((await post()).status, 401);
  assert.equal(fetch.mock.callCount(), 0);
  const auth = { 'X-Worker-Secret': env.WORKER_SHARED_SECRET };
  const success = await post(auth);
  assert.equal(success.headers.get('Cache-Control'), 'private, no-store');
  const responseText = await success.text();
  assert.deepEqual(JSON.parse(responseText), { valid: true, reason: 'valid' });
  const internalError = new Error(secretText.join(' '));
  fetch.mock.mockImplementation(async () => { throw internalError; });
  const failureText = await (await post(auth)).text();
  assert.deepEqual(JSON.parse(failureText), { valid: false, reason: 'unavailable' });
  client.patch.mock.mockImplementation(async () => { throw internalError; });
  // Approvals are idempotent, so clear gate 2 to reach the failing patch again.
  entries.delete(receiptKey(pageId, 2));
  const approvalFailure = await action('approve-publish');
  assert.equal(approvalFailure.status, 502);
  const outputs = [approvalText, responseText, failureText, await approvalFailure.text(),
    ...logs.flatMap(mock => mock.mock.calls.flatMap(call => call.arguments.map(String)))];
  for (const output of outputs) {
    for (const value of secretText) assert.equal(output.includes(value), false);
  }
});

test('a failed approval patch does not store a receipt', async t => {
  const { entries, action, client } = fixture(t);
  client.patch.mock.mockImplementation(async () => { throw new Error('cannot save audit'); });
  assert.equal((await action('approve-transcription')).status, 502);
  assert.equal(entries.size, 0);
});
