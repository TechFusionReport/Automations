import assert from 'node:assert/strict';
import test from 'node:test';
import { buildObservability, publicObservability } from '../src/ops/observability.js';

const response = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});

test('normalizes Prometheus targets and metrics without returning credentials', async () => {
  const seen = [];
  const fakeFetch = async (url, options) => {
    seen.push({ url: String(url), headers: options.headers });
    if (String(url).includes('/targets')) return response({
      status: 'success',
      data: { activeTargets: [
        { labels: { job: 'node', instance: 'host-a:9100' }, health: 'up', lastScrape: '2026-09-01T00:00:00Z', lastError: '' },
        { labels: { job: 'container', instance: 'host-b:8080' }, health: 'down', lastScrape: '2026-09-01T00:00:00Z', lastError: 'timeout' },
      ] },
    });
    return response({ status: 'success', data: { result: [{ metric: { job: 'node', instance: 'host-a:9100' }, value: [1, '42.5'] }] } });
  };
  const result = await buildObservability(
    { PROMETHEUS_BASE_URL: 'https://prometheus.example.com' },
    { prometheus_access_client_id: 'id-secret', prometheus_access_client_secret: 'secret-secret' },
    { fetch: fakeFetch, now: () => Date.parse('2026-09-01T00:01:00Z') },
  );
  assert.equal(result.status, 'degraded');
  assert.deepEqual(result.targets, {
    total: 2,
    healthy: 1,
    down: 1,
    items: [
      { job: 'node', instance: 'host-a:9100', health: 'up', lastScrape: '2026-09-01T00:00:00Z', lastError: null },
      { job: 'container', instance: 'host-b:8080', health: 'down', lastScrape: '2026-09-01T00:00:00Z', lastError: 'timeout' },
    ],
  });
  assert.equal(JSON.stringify(result).includes('secret-secret'), false);
  assert.equal(seen.every((call) => call.headers['CF-Access-Client-Id'] === 'id-secret'), true);
});

test('fails closed when Prometheus is not configured', async () => {
  const result = await buildObservability({}, {}, { now: () => 0 });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'Prometheus is not configured');
});

test('public contract strips target identities and marks stale data unavailable', () => {
  const oldNow = Date.now;
  Date.now = () => Date.parse('2026-09-01T00:10:00Z');
  try {
    const result = publicObservability({
      generatedAt: '2026-09-01T00:00:00Z',
      status: 'degraded',
      targets: { total: 2, healthy: 1, down: 1, items: [{ instance: 'private-host:9100' }] },
      alerts: { firing: 1, items: [{ name: 'secret alert' }] },
    });
    assert.deepEqual(result, {
      generatedAt: '2026-09-01T00:00:00Z',
      status: 'unavailable',
      stale: true,
      targets: { total: 2, healthy: 1, down: 1 },
      alerts: { firing: 1 },
    });
    assert.equal(JSON.stringify(result).includes('private-host'), false);
  } finally {
    Date.now = oldNow;
  }
});
