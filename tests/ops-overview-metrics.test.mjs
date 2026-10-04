import assert from 'node:assert/strict';
import test from 'node:test';
import { handleOps } from '../src/ops/router.js';
import { CATALOG_STATUS as S, CATALOG_PROPERTIES as P } from '../src/utils/content-catalog.js';

test('overview counts operational exceptions separately from rejection and features only publications', async () => {
  const counts = { [S.publishedToGithub]: 1, [S.errors]: 2, [S.transcriptionFailed]: 3,
    [S.publishFailed]: 4, [S.needsReReview]: 5, [S.rejected]: 44 };
  let featuredQuery;
  const response = await handleOps(new Request('https://example.com/ops/api/overview'), {
    CONTENT_KV: { get: async key => key === 'ops_counts_cache' ? JSON.stringify({ counts, cachedAt: 1000 }) : null },
  }, {}, {
    verify: async () => ({ ok: true }), now: () => 1000,
    client: { query: async (db, body) => {
      if (body.filter?.and?.some(f => f.property === P.featured)) {
        featuredQuery = body;
        return { results: [{}], has_more: false };
      }
      return { results: [], has_more: false };
    } },
  });
  const overview = await response.json();
  assert.equal(response.status, 200);
  assert.equal(overview.kpis.errorCount, 14);
  assert.equal(overview.kpis.rejectionCount, 44);
  assert.equal(overview.kpis.featuredRate, 1);
  assert.ok(featuredQuery.filter.and.some(f => f.status?.equals === S.publishedToGithub));
});
