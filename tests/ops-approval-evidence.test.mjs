import assert from 'node:assert/strict';
import test from 'node:test';
import { handleOps } from '../src/ops/router.js';
import { verifyRecordReceipt } from '../src/ops/receipts.js';
import { buildEvidence, evidenceKey, listRecentApprovals } from '../src/ops/approval-evidence.js';
import { CATALOG_PROPERTIES as P, CATALOG_STATUS as S } from '../src/utils/content-catalog.js';
import { normalizePageId, receiptKey } from '../src/utils/ops-receipts.js';

const approver = 'editor@example.invalid';
const issuedAt = Date.UTC(2026, 10, 20, 15, 30);
const DAY = 24 * 60 * 60 * 1000;
const rich = content => ({ rich_text: [{ text: { content } }] });

// In-memory AGENT_STATE with the KV list/metadata surface the evidence list uses.
function kvStore() {
  const entries = new Map();
  const metadata = new Map();
  return {
    entries,
    metadata,
    binding: {
      get: async key => entries.get(key) ?? null,
      put: async (key, value, options = {}) => {
        entries.set(key, value);
        if (options.metadata) metadata.set(key, options.metadata);
      },
      delete: async key => { entries.delete(key); metadata.delete(key); },
      list: async ({ prefix = '' } = {}) => ({
        keys: [...entries.keys()].filter(name => name.startsWith(prefix))
          .map(name => ({ name, metadata: metadata.get(name) })),
        list_complete: true,
      }),
    },
  };
}

function fixture(t, { email = approver } = {}) {
  const pageId = crypto.randomUUID();
  const kv = kvStore();
  let clock = issuedAt;
  const env = {
    OPS_RECEIPT_KEY: crypto.randomUUID(),
    CONTENT_KV: { get: async () => null },
    AGENT_STATE: kv.binding,
  };
  const page = {
    id: pageId,
    properties: {
      [P.title]: { title: [{ text: { content: 'Evidence title' } }] },
      [P.blogDraft]: rich('Draft text for the evidence test'),
    },
  };
  const client = {
    retrieve: t.mock.fn(async () => structuredClone(page)),
    listBlocks: t.mock.fn(async () => ({ results: [] })),
    patch: t.mock.fn(async (_id, changes) => Object.assign(page.properties, changes)),
  };
  const warn = t.mock.fn();
  const deps = { client, warn, now: () => clock, verify: async () => ({ ok: true, email }) };
  async function action(name, fields = {}) {
    const response = await handleOps(new Request(`https://worker.example/ops/api/actions/${name}`, {
      method: 'POST',
      body: JSON.stringify({ pageId, ...fields }),
    }), env, {}, deps);
    return { status: response.status, body: await response.json() };
  }
  return { env, kv, page, pageId, client, warn, action, deps, tick: ms => { clock += ms; } };
}

test('approve writes an evidence record separate from the receipt', async t => {
  const { kv, pageId, action } = fixture(t);
  const { status, body } = await action('approve-transcription');
  assert.equal(status, 200);
  assert.equal(body.alreadyApproved, false);
  const expected = {
    gate: 1, pageId: normalizePageId(pageId), approvedAt: new Date(issuedAt).toISOString(), approver,
  };
  assert.deepEqual(body.evidence, expected);
  assert.deepEqual(JSON.parse(kv.entries.get(`approval-evidence:1:${normalizePageId(pageId)}`)), expected);
  assert.deepEqual(kv.metadata.get(evidenceKey(1, pageId)), { approvedAt: expected.approvedAt, approver });
  // The receipt is still written in its own key with its own shape.
  const receipt = JSON.parse(kv.entries.get(receiptKey(pageId, 1)));
  assert.equal(receipt.approver, approver);
  assert.equal(typeof receipt.signature, 'string');
});

test('second approve returns the existing evidence without re-signing or re-ticking', async t => {
  const { env, kv, pageId, client, action, tick } = fixture(t);
  const first = await action('approve-transcription');
  const receipt = kv.entries.get(receiptKey(pageId, 1));
  const sign = t.mock.method(crypto.subtle, 'sign');
  tick(60_000);
  const second = await action('approve-transcription');
  assert.equal(second.status, 200);
  assert.equal(second.body.alreadyApproved, true);
  assert.deepEqual(second.body.evidence, first.body.evidence);
  assert.equal(sign.mock.callCount(), 0);
  assert.equal(client.patch.mock.callCount(), 1);
  assert.equal(kv.entries.get(receiptKey(pageId, 1)), receipt);
  assert.deepEqual(await verifyRecordReceipt(env, client, pageId, 1), { valid: true, reason: 'valid' });

  // Gate 2 behaves the same once gate 1 is in place.
  assert.equal((await action('approve-publish')).body.alreadyApproved, false);
  const again = await action('approve-publish');
  assert.equal(again.body.alreadyApproved, true);
  assert.equal(client.patch.mock.callCount(), 2);
});

test('a failed record can be re-authorized even though its receipt is still valid', async t => {
  const { page, client, action, tick } = fixture(t);
  await action('approve-transcription');
  page.properties[P.status] = { status: { name: S.transcriptionFailed } };
  tick(DAY);
  const retry = await action('approve-transcription');
  assert.equal(retry.body.alreadyApproved, false);
  assert.equal(retry.body.evidence.approvedAt, new Date(issuedAt + DAY).toISOString());
  assert.equal(client.patch.mock.callCount(), 2);
});

test('legacy receipts without evidence still answer idempotently from the receipt', async t => {
  const { kv, pageId, action } = fixture(t);
  await action('approve-transcription');
  kv.entries.delete(evidenceKey(1, pageId));
  const second = await action('approve-transcription');
  assert.equal(second.body.alreadyApproved, true);
  assert.equal(second.body.evidence.approver, approver);
  assert.equal(second.body.evidence.source, 'receipt');
});

test('approver comes from the Access JWT email and falls back to "unknown"', async t => {
  const { body } = await fixture(t, { email: 'reviewer@example.invalid' }).action('approve-transcription');
  assert.equal(body.evidence.approver, 'reviewer@example.invalid');
  for (const missing of [undefined, null, '', '   ']) {
    assert.equal(buildEvidence({ gate: 1, pageId: crypto.randomUUID(), approver: missing, approvedAt: issuedAt }).approver, 'unknown');
  }
  // Receipts still require an approver email, so a token without one cannot approve.
  const { status } = await fixture(t, { email: null }).action('approve-transcription');
  assert.equal(status, 403);
});

test('evidence write failure logs a sanitized warning and still approves', async t => {
  const { env, kv, pageId, client, warn, action } = fixture(t);
  const put = kv.binding.put;
  env.AGENT_STATE = {
    ...kv.binding,
    put: async (key, ...rest) => {
      if (key.startsWith('approval-evidence:')) {
        throw new Error('KV put failed for https://kv.example/values?token=abc123 by editor@example.invalid');
      }
      return put(key, ...rest);
    },
  };
  const { status, body } = await action('approve-transcription');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.ok(kv.entries.has(receiptKey(pageId, 1)));
  assert.equal(client.patch.mock.callCount(), 1);
  assert.equal(warn.mock.callCount(), 1);
  const message = warn.mock.calls[0].arguments[0];
  assert.match(message, /^approval evidence write failed: Error: KV put failed/);
  assert.doesNotMatch(message, /kv\.example|abc123|editor@/);
});

test('recently approved is newest first, windowed, capped and skips unreadable pages', async t => {
  const kv = kvStore();
  const env = { OPS_RECEIPT_KEY: crypto.randomUUID(), AGENT_STATE: kv.binding };
  const now = issuedAt;
  const ids = Array.from({ length: 6 }, () => crypto.randomUUID());
  // ids[0] is newest; ids[5] falls outside the 14-day window.
  const ages = [1, 2, 3, 4, 5, 15];
  for (const [i, id] of ids.entries()) {
    await kv.binding.put(evidenceKey(1, id), '{}', {
      metadata: { approvedAt: new Date(now - ages[i] * DAY).toISOString(), approver },
    });
  }
  await kv.binding.put(evidenceKey(2, crypto.randomUUID()), '{}', {
    metadata: { approvedAt: new Date(now).toISOString(), approver },
  });
  const unreadable = ids[1];
  const client = {
    retrieve: t.mock.fn(async id => {
      if (id === normalizePageId(unreadable)) throw new Error('Notion retrieve failed (404)');
      return { id, properties: { [P.title]: { title: [{ text: { content: `Title ${id.slice(0, 4)}` } }] } } };
    }),
  };

  const result = await listRecentApprovals(env, client, 1, { now: () => now, limit: 4 });
  assert.equal(result.gate, 1);
  assert.equal(result.skipped, 1);
  // Cap applies before lookups: ids[0..3] are candidates, ids[1] is unreadable.
  assert.deepEqual(result.items.map(item => item.pageId), [ids[0], ids[2], ids[3]].map(normalizePageId));
  assert.ok(result.items.every(item => item.gate === 1 && item.approver === approver && item.receiptActive === false));
  assert.equal(client.retrieve.mock.callCount(), 4);

  const capped = await listRecentApprovals(env, client, 1, { now: () => now });
  assert.equal(capped.limit, 50);
  assert.equal(capped.items.length, 4);
});

test('recent approvals endpoint reports both gates and active receipts', async t => {
  const { env, deps, pageId, action } = fixture(t);
  await action('approve-transcription');
  const response = await handleOps(new Request('https://worker.example/ops/api/approvals/recent'), env, {}, deps);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.windowDays, 14);
  assert.deepEqual(body.gates.map(gate => gate.gate), [1, 2]);
  assert.deepEqual(body.gates[0].items.map(item => [item.pageId, item.title, item.receiptActive]),
    [[normalizePageId(pageId), 'Evidence title', true]]);
  assert.equal(body.gates[1].items.length, 0);

  // Revoking the receipt keeps the audit entry but marks it inactive.
  await action('reject');
  const after = await (await handleOps(new Request('https://worker.example/ops/api/approvals/recent'), env, {}, deps)).json();
  assert.equal(after.gates[0].items[0].receiptActive, false);
});

test('ops UI indexes only active approvals and lets this tab’s approvals win', async () => {
  const { compactPageId, indexApprovals } = await import('../ops/ops.js');
  const id = crypto.randomUUID();
  const recent = { gates: [
    { gate: 1, items: [
      { pageId: compactPageId(id), approver, approvedAt: new Date(issuedAt).toISOString(), receiptActive: true },
      { pageId: 'f'.repeat(32), approver, approvedAt: new Date(issuedAt).toISOString(), receiptActive: false },
    ] },
    { gate: 2, items: [] },
  ] };
  const index = indexApprovals(recent);
  assert.equal(compactPageId(id.toUpperCase()), id.replaceAll('-', ''));
  assert.equal(index[1].get(compactPageId(id)).approver, approver);
  assert.equal(index[1].has('f'.repeat(32)), false);
  const local = { 2: new Map([[compactPageId(id), { approver: 'tab@example.invalid' }]]) };
  assert.equal(indexApprovals(recent, local)[2].get(compactPageId(id)).approver, 'tab@example.invalid');
  assert.equal(indexApprovals({ error: 'down', gates: [] })[1].size, 0);
});

test('ops UI formats approval evidence with local time and approver', async () => {
  const { approvalText } = await import('../ops/ops.js');
  const evidence = { approvedAt: new Date(issuedAt).toISOString(), approver };
  assert.equal(approvalText(evidence, date => date.toISOString()), `Approved ${evidence.approvedAt} by ${approver}`);
  assert.equal(approvalText({ approvedAt: 'nope' }), 'Approved at an unknown time by unknown');
});
