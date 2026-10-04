import assert from 'node:assert/strict';
import test from 'node:test';
import { countPublishedThisMonth } from '../src/ops/router.js';

test('monthly total includes all pages rather than the five recent articles', async () => {
  const calls = [];
  const client = { async query(dbId, body) {
    calls.push({ dbId, body });
    return calls.length === 1
      ? { results: Array(100).fill({}), has_more: true, next_cursor: 'page-two' }
      : { results: Array(7).fill({}), has_more: false };
  } };
  assert.equal(await countPublishedThisMonth(client, 'catalog', () => Date.parse('2026-12-20T12:00:00Z')), 107);
  assert.equal(calls[1].body.start_cursor, 'page-two');
  assert.deepEqual(calls[0].body.filter.and.slice(1).map(f => f.date), [
    { on_or_after: '2026-12-01T00:00:00.000Z' },
    { before: '2027-01-01T00:00:00.000Z' },
  ]);
  assert.equal(calls[0].dbId, 'catalog');
});

test('empty month returns zero and query failures remain visible', async () => {
  assert.equal(await countPublishedThisMonth({ query: async () => ({ results: [], has_more: false }) }, 'catalog'), 0);
  await assert.rejects(countPublishedThisMonth({ query: async () => { throw new Error('Notion unavailable'); } }, 'catalog'), /Notion unavailable/);
});

test('incomplete pagination cannot silently report a partial total', async () => {
  await assert.rejects(countPublishedThisMonth({ query: async () => ({ results: [{}], has_more: true }) }, 'catalog'), /cursor missing/);
});
