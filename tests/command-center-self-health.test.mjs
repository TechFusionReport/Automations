import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCommandCenter } from '../src/ops/command-center.js';

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});

test('OmniRoute probe authenticates without exposing its credential', async () => {
  for (const unauthorized of [false, true]) {
    let checked = false;
    const result = await buildCommandCenter({}, { omniroute_api_key: 'test-private-key' }, {
      fetch: async (url, options) => {
        if (String(url).includes('omniroute.techfusionreport.com')) {
          checked = true;
          assert.equal(options.headers.Authorization, 'Bearer test-private-key');
          assert.equal(options.redirect, 'error');
          return jsonResponse({}, unauthorized ? 401 : 200);
        }
        assert.equal(options.headers?.Authorization, undefined);
        return jsonResponse({});
      },
    });
    assert.equal(checked, true);
    assert.equal(result.services.find(s => s.name === 'OmniRoute').status, unauthorized ? 'degraded' : 'ok');
    assert.equal(JSON.stringify(result).includes('test-private-key'), false);
  }
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

test('OmniRoute probe sends Access headers and reports an Access denial without credentials', async () => {
  const result = await buildCommandCenter({ OMNIROUTE_ACCESS_CLIENT_ID: 'id-sentinel' }, {
    omniroute_access_client_id: 'unused-test-id',
    omniroute_access_client_secret: 'secret-sentinel',
    omniroute_api_key: 'bearer-sentinel',
  }, {
    fetch: async (url, { headers, redirect }) => {
      if (url.endsWith('/v1/models')) {
        assert.deepEqual(headers, {
          Authorization: 'Bearer bearer-sentinel',
          'CF-Access-Client-Id': 'id-sentinel',
          'CF-Access-Client-Secret': 'secret-sentinel',
        });
        assert.equal(redirect, 'error');
        return new Response('secret-sentinel', { status: 403, headers: { 'cf-access-aud': 'id-sentinel' } });
      }
      assert.deepEqual(headers, {});
      return jsonResponse({});
    },
  });
  const probe = result.services.find(service => service.name === 'OmniRoute');
  assert.equal(probe.status, 'degraded');
  assert.equal(probe.reason, 'blocked by Cloudflare Access');
  assert.equal(probe.httpStatus, 403);
  assert.doesNotMatch(JSON.stringify(result), /(?:id|secret|bearer)-sentinel/);
});

test('authenticated probe diagnoses a redirect without following it', async () => {
  const modes = [];
  const result = await buildCommandCenter({ OMNIROUTE_ACCESS_CLIENT_ID: 'id-sentinel',
    OMNIROUTE_ACCESS_CLIENT_SECRET: 'secret-sentinel' }, {}, {
    fetch: async (url, { redirect }) => {
      if (!url.endsWith('/v1/models')) return jsonResponse({});
      modes.push(redirect);
      if (redirect === 'error') throw new TypeError('redirect with id-sentinel');
      return new Response(null, { status: 302, headers: { Location: 'https://login.example/' } });
    },
  });
  assert.deepEqual(modes, ['error', 'manual']);
  const probe = result.services.find(service => service.name === 'OmniRoute');
  assert.equal(probe.status, 'degraded');
  assert.equal(probe.reason, 'blocked by Cloudflare Access');
  assert.equal(probe.httpStatus, 302);
  assert.doesNotMatch(JSON.stringify(result), /(?:id|secret)-sentinel|login\.example/);
});
