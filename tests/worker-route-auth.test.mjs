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
  async function signedHeaders(audience) {
    const header = encode({ alg: 'RS256', kid: jwk.kid });
    const payload = encode({
      aud: [audience],
      exp: Math.floor(Date.now() / 1000) + 60,
      email: 'test@example.invalid',
    });
    const input = `${header}.${payload}`;
    const signature = await crypto.subtle.sign(algorithm, privateKey, Buffer.from(input));
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
