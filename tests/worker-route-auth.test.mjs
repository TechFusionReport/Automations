import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../src/index.js';
import DiscoveryAgent from '../src/agents/discovery.js';

const sharedSecret = crypto.randomUUID();
const secretHeader = { 'X-Worker-Secret': sharedSecret };
const env = {
  WORKER_SHARED_SECRET: sharedSecret,
  ACCESS_TEAM_DOMAIN: 'example',
  ACCESS_AUD: 'worker-test',
  CONTENT_KV: {
    get: async () => null,
    list: async () => ({ keys: [] }),
  },
};

function request(path, { method = 'GET', headers, body } = {}, bindings = env) {
  return worker.fetch(new Request(new URL(path, 'https://worker.example'), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }), bindings, {});
}

for (const [path, options] of [
  ['/status', {}],
  ['/analytics/summary', {}],
  ['/batch/publish', { method: 'POST', body: { pageIds: [] } }],
  ['/cache/clear', { method: 'POST', body: {} }],
]) {
  test(`${path} requires auth before dispatch and accepts the shared secret`, async () => {
    assert.equal((await request(path, options, { WORKER_SHARED_SECRET: sharedSecret })).status, 401);
    assert.equal((await request(path, { ...options, headers: secretHeader })).status, 200);
  });
}

test('pipeline triggers authenticate before running the agent', async t => {
  const run = t.mock.method(DiscoveryAgent.prototype, 'run', async () => Response.json({}));
  assert.equal((await request('/discover', { method: 'POST' })).status, 401);
  assert.equal(run.mock.callCount(), 0);
  assert.equal((await request('/discover', { method: 'POST', headers: secretHeader })).status, 200);
  assert.equal(run.mock.callCount(), 1);
});

test('wrong or unset shared secrets and malformed JWTs return 401', async () => {
  assert.equal((await request('/status', { headers: { 'X-Worker-Secret': crypto.randomUUID() } })).status, 401);
  assert.equal((await request('/status', { headers: secretHeader }, { ...env, WORKER_SHARED_SECRET: '' })).status, 401);
  assert.equal((await request('/status', { headers: { 'Cf-Access-Jwt-Assertion': 'malformed' } })).status, 401);
});

test('health remains public and ops retains its own Access gate', async () => {
  assert.equal((await request('/health', {}, {})).status, 200);
  assert.equal((await request('/ops/api/queue', { headers: secretHeader })).status, 403);
  assert.equal((await request('/ops/unknown')).status, 404);
  assert.equal((await request('/ops-other')).status, 401);
  assert.equal((await request('/health/other')).status, 401);
});

test('ops config rejects missing, malformed, and shared-secret-only credentials', async () => {
  for (const headers of [undefined, { 'Cf-Access-Jwt-Assertion': 'malformed' }, secretHeader]) {
    assert.equal((await request('/ops/api/config', { headers })).status, 403);
  }
});

test('preview assets require Access and production ops asset requests retain their responses', async t => {
  const fetch = t.mock.fn();
  for (const path of ['/ops', '/ops/', '/ops/ops.js']) {
    const denied = await request(path, {}, { ...env, ASSETS: { fetch } });
    const apiDenied = await request('/ops/api/config');
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get('Location'), null);
    assert.deepEqual(await denied.json(), await apiDenied.json());
    assert.equal(denied.headers.get('Cache-Control'), 'private, no-store');
  }
  const deniedHead = await request('/ops', { method: 'HEAD' }, { ...env, ASSETS: { fetch } });
  assert.equal(deniedHead.status, 403);
  assert.equal(deniedHead.headers.get('Location'), null);
  assert.equal(fetch.mock.callCount(), 0);
  const productionRoot = await request('/ops');
  assert.equal(productionRoot.status, 401);
  assert.deepEqual(await productionRoot.json(), { error: 'Unauthorized' });
  for (const path of ['/ops/', '/ops/ops.js']) {
    const response = await request(path);
    assert.equal(response.status, 404);
    assert.equal(await response.text(), 'Not Found');
  }
});

test('signed Access JWTs work for both Worker routes and ops', async t => {
  const algorithm = 'RSASSA-PKCS1-v1_5';
  const { privateKey, publicKey } = await crypto.subtle.generateKey({
    name: algorithm,
    modulusLength: 2048,
    publicExponent: Uint8Array.of(1, 0, 1),
    hash: 'SHA-256',
  }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', publicKey);
  jwk.kid = 'test';
  const bindings = {
    ...env,
    CONTENT_KV: {
      ...env.CONTENT_KV,
      get: async name => name === 'ops_access_jwks' ? JSON.stringify({ keys: [jwk] }) : null,
    },
  };
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  async function signedHeaders(audience, claims = { email: 'test@example.invalid' }, corruptSignature = false) {
    const header = encode({ alg: 'RS256', kid: jwk.kid });
    const payload = encode({
      aud: [audience],
      exp: Math.floor(Date.now() / 1000) + 60,
      ...claims,
    });
    const input = `${header}.${payload}`;
    const signature = new Uint8Array(await crypto.subtle.sign(algorithm, privateKey, Buffer.from(input)));
    if (corruptSignature) signature[0] ^= 1;
    return { 'Cf-Access-Jwt-Assertion': `${input}.${Buffer.from(signature).toString('base64url')}` };
  }

  const headers = await signedHeaders(env.ACCESS_AUD);
  assert.equal((await request('/status', { headers }, bindings)).status, 200);
  assert.equal((await request('/status', { headers: await signedHeaders('other') }, bindings)).status, 401);
  const configBindings = {
    ...bindings,
    OPS_ENV_LABEL: 'PREVIEW',
    OPS_SITE_URL: 'https://preview.example/',
    CONTENT_KV: {
      get: async name => {
        assert.equal(name, 'ops_access_jwks');
        return JSON.stringify({ keys: [jwk] });
      },
    },
  };
  const config = await request('/ops/api/config', { headers }, configBindings);
  assert.equal(config.status, 200);
  assert.equal(config.headers.get('Cache-Control'), 'private, no-store');
  assert.deepEqual(await config.json(), { environment: 'PREVIEW', siteUrl: 'https://preview.example/' });

  const insecure = await request('/ops/api/config', { headers }, {
    ...configBindings, OPS_ENV_LABEL: 'LIVE', OPS_SITE_URL: 'http://preview.example/',
  });
  assert.deepEqual(await insecure.json(), { environment: 'LIVE', siteUrl: null });

  const unset = await request('/ops/api/config', { headers }, bindings);
  assert.deepEqual(await unset.json(), { environment: 'UNKNOWN', siteUrl: null });
  const wrongAudience = await request('/ops/api/config', { headers: await signedHeaders('other') }, configBindings);
  assert.equal(wrongAudience.status, 403);

  const assetCalls = [];
  const ASSETS = {
    async fetch(request) {
      const path = new URL(request.url).pathname;
      assetCalls.push({ path, method: request.method, access: request.headers.has('Cf-Access-Jwt-Assertion') });
      if (path === '/index.html') return new Response(null, { status: 307, headers: { Location: '/' } });
      if (path === '/') return new Response('<!doctype html>', { headers: { 'Content-Type': 'text/html' } });
      if (path === '/ops.js') return new Response('export {};', { headers: { 'Content-Type': 'text/javascript' } });
      if (path === '/techfusion-os.css') return new Response('body {}', { headers: { 'Content-Type': 'text/css' } });
      return new Response('Unknown asset', { status: 404 });
    },
  };
  const preview = { ...configBindings, ASSETS };
  for (const method of ['GET', 'HEAD']) {
    const redirect = await request('/ops', { method, headers }, preview);
    assert.equal(redirect.status, 308);
    assert.equal(redirect.headers.get('Location'), '/ops/');
    assert.equal(redirect.headers.get('Cache-Control'), 'private, no-store');
    assert.equal(await redirect.text(), '');
  }
  assert.deepEqual(assetCalls, []);
  for (const [path, expected, type] of [
    ['/ops/', '<!doctype html>', 'text/html'],
    ['/ops/ops.js', 'export {};', 'text/javascript'],
    ['/ops/techfusion-os.css', 'body {}', 'text/css'],
  ]) {
    const response = await request(path, { headers }, preview);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Content-Type'), type);
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
    assert.equal(await response.text(), expected);
  }
  assert.deepEqual(assetCalls.map(({ path }) => path), [
    '/index.html', '/', '/ops.js', '/techfusion-os.css',
  ]);
  assert.ok(assetCalls.every(call => !call.access));

  const head = await request('/ops/ops.js', { method: 'HEAD', headers }, preview);
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal(assetCalls.at(-1).method, 'HEAD');
  const missing = await request('/ops/missing.js', { headers }, preview);
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('Cache-Control'), 'private, no-store');
  const before = assetCalls.length;
  const post = await request('/ops/ops.js', { method: 'POST', headers }, preview);
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('Allow'), 'GET, HEAD');
  for (const path of ['/ops/..file', '/ops/%2e%2e%2fsecret', '/ops/%252e%252e%252fsecret', '/ops/folder%5cfile']) {
    const response = await request(path, { headers }, preview);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'invalid asset path' });
  }
  class RawPathRequest extends Request {
    get url() { return 'https://worker.example/ops/../health'; }
  }
  const rawTraversal = await worker.fetch(new RawPathRequest('https://worker.example/health', { headers }), preview, {});
  assert.equal(rawTraversal.status, 400);
  const apiWithAssets = await request('/ops/api/config', { headers }, preview);
  assert.deepEqual(await apiWithAssets.json(), { environment: 'PREVIEW', siteUrl: 'https://preview.example/' });
  assert.equal((await request('/ops/api/config', {}, preview)).status, 403);
  assert.equal(assetCalls.length, before);

  await t.test('receipt verification alone accepts the configured service identity', async () => {
    const clientId = 'test-service-identity';
    const serviceAudience = 'receipt-app-test';
    const receiptBindings = {
      ...bindings,
      ACCESS_AUD: `${env.ACCESS_AUD}, ${serviceAudience}`,
      RECEIPT_VERIFIER_CLIENT_ID: clientId,
      OPS_RECEIPT_KEY: undefined,
    };
    const body = { pageId: crypto.randomUUID(), gate: 1 };
    const postReceipt = (headers, configured = receiptBindings) =>
      request('/receipts/verify', { method: 'POST', body, headers }, configured);

    const serviceHeaders = await signedHeaders(serviceAudience, { common_name: `${clientId}.access` });
    for (const [claim, configured] of [
      [`${clientId}.access`, clientId],
      [clientId, clientId],
      [clientId, `${clientId}.access`],
    ]) {
      const response = await postReceipt(await signedHeaders(serviceAudience, { common_name: claim }), {
        ...receiptBindings, RECEIPT_VERIFIER_CLIENT_ID: configured,
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { valid: false, reason: 'unavailable' });
    }

    for (const rejected of [
      await signedHeaders(serviceAudience, { common_name: 'other-service-identity' }),
      await signedHeaders(serviceAudience, { common_name: clientId, exp: Math.floor(Date.now() / 1000) - 60 }),
      await signedHeaders('wrong-receipt-audience', { common_name: clientId }),
      await signedHeaders(serviceAudience, { common_name: clientId }, true),
      await signedHeaders(serviceAudience, {}),
    ]) {
      const response = await postReceipt(rejected);
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { error: 'Unauthorized' });
    }
    for (const unset of [undefined, '', '   ']) {
      assert.equal((await postReceipt(serviceHeaders, { ...receiptBindings, RECEIPT_VERIFIER_CLIENT_ID: unset })).status, 401);
    }

    assert.equal((await request('/receipts/verify', { headers: serviceHeaders }, receiptBindings)).status, 401);
    for (const path of ['/discover', '/publish', '/cache/clear', '/admin/publish-poll', '/receipts/verify/']) {
      assert.equal((await request(path, { method: 'POST', headers: serviceHeaders }, receiptBindings)).status, 401);
    }
    const ops = await request('/ops/api/config', { headers: serviceHeaders }, receiptBindings);
    assert.equal(ops.status, 403);
    assert.deepEqual(await ops.json(), { error: 'no email in token' });
    assert.equal((await postReceipt(headers)).status, 200);
    assert.equal((await postReceipt(secretHeader)).status, 200);
  });

  t.mock.method(globalThis, 'fetch', async () => Response.json({ results: [] }));
  assert.equal((await request('/ops/api/queue', { headers }, bindings)).status, 200);
});

test('retired routes are absent for authenticated callers', async () => {
  for (const path of [
    '/enhance',
    '/admin/enhance-poll',
    '/admin/enhance-single',
    '/batch/enhance',
    '/admin/diag/notion-token',
  ]) {
    assert.equal((await request(path, { method: 'POST' })).status, 401, path);
    assert.equal((await request(path, { method: 'POST', headers: secretHeader })).status, 404, path);
  }
});
