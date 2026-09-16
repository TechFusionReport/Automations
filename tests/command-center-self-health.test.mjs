import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCommandCenter } from '../src/ops/command-center.js';

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});

test('command center marks current Worker healthy without fetching its own public hostname', async () => {
  const urls = [];
  const fetchFn = async (url) => {
    urls.push(String(url));
    if (String(url).includes('api.notion.com')) return jsonResponse({ results: [], has_more: false });
    if (String(url).includes('api.github.com')) return jsonResponse({ total_count: 0, items: [] });
    if (String(url).includes('api.cloudflare.com')) return jsonResponse({ success: true, result: [] });
    if (String(url) === 'https://techfusionreport.com/') return new Response('', { status: 200 });
    if (String(url) === 'https://omniroute.techfusionreport.com/v1/models') return jsonResponse({ data: [] });
    throw new Error(`unexpected fetch: ${url}`);
  };

  const result = await buildCommandCenter({
    NOTION_TOKEN: 'test',
    GITHUB_PAT: 'test',
    CLOUDFLARE_API_TOKEN: 'test',
    CLOUDFLARE_ACCOUNT_ID: 'test',
  }, {}, { fetch: fetchFn, now: () => 0 });

  assert.equal(urls.includes('https://api.techfusionreport.com/health'), false);
  assert.deepEqual(result.services[0], {
    name: 'TechFusion API',
    url: 'https://api.techfusionreport.com/health',
    status: 'ok',
    httpStatus: 200,
    latencyMs: 0,
    source: 'current-worker',
  });
  assert.equal(result.attention.some((item) => item.title.includes('TechFusion API')), false);
});
