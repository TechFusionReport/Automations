import assert from 'node:assert/strict';
import test from 'node:test';
import { LlmClient, LlmRequestError, resolveLlmConfig } from '../src/utils/llm-client.mjs';

function headers(values = {}) {
  const normalized = Object.fromEntries(Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]));
  return { get: (name) => normalized[name.toLowerCase()] || null };
}

function response({ status = 200, body = {}, responseHeaders = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: headers(responseHeaders),
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  };
}

const omniSuccess = (content = '42') => response({
  body: { model: 'served-model', choices: [{ message: { content } }] },
  responseHeaders: {
    'x-omniroute-request-id': 'request-1',
    'x-omniroute-provider': 'provider-1',
    'x-omniroute-model': 'served-model',
  },
});

const geminiSuccess = (content = '50') => response({
  body: { candidates: [{ content: { parts: [{ text: content }] } }] },
});

function client(fetchImpl, overrides = {}, secretOverrides = {}) {
  return new LlmClient({
    OMNIROUTE_BASE_URL: 'https://omni.example',
    OMNIROUTE_CHAIN: 'TFR Free Chain',
    OMNIROUTE_TIMEOUT_MS: '25',
    ...overrides,
  }, { gemini_api_key: 'gemini-test-key', ...secretOverrides }, {
    fetchImpl,
    logger: { log() {} },
  });
}

test('resolves centralized defaults and passes the combo in model', async () => {
  const calls = [];
  const llm = client(async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return omniSuccess();
  });
  const result = await llm.completeText({ prompt: 'score', workflow: 'discovery.score', maxTokens: 8 });
  assert.equal(result.text, '42');
  assert.equal(calls[0].url, 'https://omni.example/v1/chat/completions');
  assert.equal(calls[0].body.model, 'TFR Free Chain');
  assert.equal(calls[0].body.stream, false);
  assert.equal(result.telemetry.downstreamProvider, 'provider-1');
  assert.equal(result.telemetry.downstreamModel, 'served-model');
  assert.equal(resolveLlmConfig({}, {}).chain, 'TFR Free Chain');
});

test('sends bearer authentication only when configured', async () => {
  let authorization;
  const llm = client(async (_url, options) => {
    authorization = options.headers.Authorization;
    return omniSuccess();
  }, {}, { omniroute_api_key: 'omni-test-key' });
  await llm.completeText({ prompt: 'test', workflow: 'test' });
  assert.equal(authorization, 'Bearer omni-test-key');
});

for (const status of [401, 403]) {
  test(`${status} fails closed without invoking Gemini fallback`, async () => {
    const calls = [];
    const events = [];
    const llm = new LlmClient({
      OMNIROUTE_BASE_URL: 'https://omni.example',
      OMNIROUTE_FALLBACK_ENABLED: 'true',
    }, { gemini_api_key: 'gemini-test-key' }, {
      fetchImpl: async (url) => {
        calls.push(url);
        return response({ status, body: { error: 'invalid credential' } });
      },
      logger: { log(value) { events.push(JSON.parse(value)); } },
    });

    await assert.rejects(
      llm.completeText({ prompt: 'test', workflow: 'test' }),
      error => error instanceof LlmRequestError && error.category === 'authentication' && error.status === status
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0], 'https://omni.example/v1/chat/completions');
    assert.equal(events.at(-1).fallbackActivated, false);
  });
}

for (const [name, status, category] of [
  ['authentication failure', 401, 'authentication'],
  ['rate limiting', 429, 'rate_limit'],
  ['chain/provider failure', 502, 'unavailable'],
]) {
  test(`${name} is normalized when fallback is disabled`, async () => {
    const llm = client(async () => response({ status, body: { error: name } }), { OMNIROUTE_FALLBACK_ENABLED: 'false' });
    await assert.rejects(
      llm.completeText({ prompt: 'test', workflow: 'test' }),
      error => error instanceof LlmRequestError && error.category === category && error.status === status
    );
  });
}

test('malformed response is normalized', async () => {
  const llm = client(async () => response({ body: { choices: [] } }), { OMNIROUTE_FALLBACK_ENABLED: 'false' });
  await assert.rejects(llm.completeText({ prompt: 'test', workflow: 'test' }), { category: 'malformed_response' });
});

test('timeout aborts the request and is normalized', async () => {
  const llm = client((_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  }), { OMNIROUTE_FALLBACK_ENABLED: 'false', OMNIROUTE_TIMEOUT_MS: '1' });
  await assert.rejects(llm.completeText({ prompt: 'test', workflow: 'test' }), { category: 'timeout' });
});

test('OmniRoute unavailability activates one direct fallback without application retries', async () => {
  const calls = [];
  const llm = client(async (url) => {
    calls.push(url);
    if (url.startsWith('https://omni.example')) throw new Error('network down');
    return geminiSuccess('fallback text');
  });
  const result = await llm.completeText({ prompt: 'test', workflow: 'test', legacyModel: 'gemini-2.0-flash' });
  assert.equal(result.text, 'fallback text');
  assert.equal(result.telemetry.route, 'direct_fallback');
  assert.equal(result.telemetry.fallbackActivated, true);
  assert.equal(result.telemetry.fallbackReason, 'network');
  assert.equal(calls.length, 2);
});

test('disabled migration control preserves direct Gemini behavior', async () => {
  const calls = [];
  const llm = client(async (url) => { calls.push(url); return geminiSuccess(); }, { OMNIROUTE_ENABLED: 'false' });
  const result = await llm.completeText({ prompt: 'test', workflow: 'test' });
  assert.equal(result.telemetry.route, 'direct_fallback');
  assert.equal(result.telemetry.fallbackActivated, false);
  assert.match(calls[0], /generativelanguage\.googleapis\.com/);
});

test('failed direct fallback is normalized after OmniRoute failure', async () => {
  const calls = [];
  const llm = client(async (url) => {
    calls.push(url);
    if (url.startsWith('https://omni.example')) return response({ status: 503 });
    return response({ status: 429 });
  });
  await assert.rejects(llm.completeText({ prompt: 'test', workflow: 'test' }), {
    category: 'rate_limit',
    status: 429,
  });
  assert.equal(calls.length, 2);
});

const accessEnv = {
  OMNIROUTE_ACCESS_CLIENT_ID: 'id-sentinel',
  OMNIROUTE_ACCESS_CLIENT_SECRET: 'secret-sentinel',
};
const accessMessage = 'OmniRoute blocked by Cloudflare Access (service token missing, wrong, or not in the policy)';
const redactSentinels = /id-sentinel|secret-sentinel/;

test('Access config prefers Worker bindings and treats empty strings as unset', () => {
  const kv = { omniroute_access_client_id: 'test-kv-id', omniroute_access_client_secret: 'test-kv-secret' };
  assert.equal(resolveLlmConfig(accessEnv, kv).accessClientId, accessEnv.OMNIROUTE_ACCESS_CLIENT_ID);
  assert.equal(resolveLlmConfig(accessEnv, kv).accessClientSecret, accessEnv.OMNIROUTE_ACCESS_CLIENT_SECRET);
  const fallback = resolveLlmConfig({ OMNIROUTE_ACCESS_CLIENT_ID: '', OMNIROUTE_ACCESS_CLIENT_SECRET: '' }, kv);
  assert.equal(fallback.accessClientId, kv.omniroute_access_client_id);
  assert.equal(fallback.accessClientSecret, kv.omniroute_access_client_secret);
});

test('OmniRoute sends Access and bearer headers while a 503 fallback sends neither', async () => {
  const calls = [];
  const llm = client(async (url, options) => {
    calls.push(options);
    return url.startsWith('https://omni.example') ? new Response('unavailable', { status: 503 }) : geminiSuccess();
  }, { ...accessEnv, OMNIROUTE_API_KEY: 'test-omni-bearer' });
  const result = await llm.completeText({ prompt: 'test', workflow: 'test' });
  assert.equal(result.telemetry.fallbackReason, 'unavailable');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].redirect, 'manual');
  assert.deepEqual(calls[0].headers, {
    'Content-Type': 'application/json',
    Authorization: 'Bearer test-omni-bearer',
    'CF-Access-Client-Id': accessEnv.OMNIROUTE_ACCESS_CLIENT_ID,
    'CF-Access-Client-Secret': accessEnv.OMNIROUTE_ACCESS_CLIENT_SECRET,
  });
  assert.deepEqual(calls[1].headers, { 'Content-Type': 'application/json' });
});

test('partial Access config sends neither header and logs the missing name once per client', async () => {
  for (const available of Object.keys(accessEnv)) {
    const events = [];
    const llm = client(async (_url, { headers }) => {
      assert.deepEqual(headers, { 'Content-Type': 'application/json' });
      return omniSuccess();
    }, { [available]: accessEnv[available] });
    llm.logger = { log: value => events.push(JSON.parse(value)) };
    for (let i = 0; i < 2; i++) await llm.completeText({ prompt: 'test', workflow: 'test' });
    assert.deepEqual(events.filter(event => event.event === 'llm_config_warning'), [{
      event: 'llm_config_warning',
      missingVariable: Object.keys(accessEnv).find(name => name !== available),
    }]);
    assert.doesNotMatch(JSON.stringify(events), redactSentinels);
  }
});

test('unset Access credentials add neither headers nor warnings', async () => {
  const events = [];
  const llm = client(async (_url, { headers }) => {
    assert.deepEqual(headers, { 'Content-Type': 'application/json' });
    return omniSuccess();
  });
  llm.logger = { log: value => events.push(JSON.parse(value)) };
  await llm.completeText({ prompt: 'test', workflow: 'test' });
  assert.deepEqual(events.map(event => event.event), ['llm_request']);
});

for (const [label, status, body, headers] of [
  ['redirect', 302, '', { Location: 'https://login.example/' }],
  ['Access header', 403, 'Denied secret-sentinel', { 'cf-access-aud': 'id-sentinel' }],
  ['HTML denial', 403, '<!doctype html><html>Denied secret-sentinel</html>', { 'content-type': 'text/plain' }],
]) {
  test(`OmniRoute ${label} fails closed with the Access message`, async () => {
    let calls = 0;
    const events = [];
    const llm = client(async () => {
      calls++;
      return new Response(body, { status, headers });
    }, accessEnv);
    llm.logger = { log: value => events.push(JSON.parse(value)) };
    await assert.rejects(llm.completeText({ prompt: 'test', workflow: 'test' }),
      { category: 'authentication', status, message: accessMessage });
    assert.equal(calls, 1);
    assert.equal(events[0].fallbackActivated, false);
    assert.doesNotMatch(JSON.stringify(events), redactSentinels);
  });
}

test('upstream errors and response attribution cannot expose configured credentials', async () => {
  const events = [];
  const llm = client(async () => new Response('secret-sentinel', { status: 503 }), {
    ...accessEnv, OMNIROUTE_FALLBACK_ENABLED: 'false',
  });
  llm.logger = { log: value => events.push(JSON.parse(value)) };
  const run = () => llm.completeText({ prompt: 'test', workflow: 'test' });
  await assert.rejects(run(), error => error.category === 'unavailable' && !redactSentinels.test(error.stack));
  llm.fetch = async () => { throw new Error('id-sentinel secret-sentinel'); };
  await assert.rejects(run(), error => error.category === 'network' && !redactSentinels.test(error.stack));
  llm.fetch = async () => response({
    body: { choices: [{ message: { content: 'test' } }] },
    responseHeaders: { 'x-request-id': 'echo-id-sentinel', 'x-omniroute-provider': 'secret-sentinel' },
  });
  const { telemetry } = await run();
  assert.equal(telemetry.requestId, null);
  assert.equal(telemetry.downstreamProvider, null);
  assert.doesNotMatch(JSON.stringify({ events, telemetry }), redactSentinels);
});
