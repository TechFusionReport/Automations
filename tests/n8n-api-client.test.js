const assert = require('node:assert/strict');
const test = require('node:test');

const { createN8nApiClient } = require('../src/utils/n8n-api-client.js');

function jsonResponse(body, ok = true) {
  return {
    ok,
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}

test('listWorkflows calls n8n API with API key header', async () => {
  const calls = [];
  const client = createN8nApiClient({
    baseUrl: 'https://n8n.example.com/',
    apiKey: 'test-api-key',
    fetch: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({ data: [] });
    },
  });

  const result = await client.listWorkflows({ active: 'true' });

  assert.deepEqual(result, { data: [] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://n8n.example.com/api/v1/workflows?active=true');
  assert.equal(calls[0].options.headers['X-N8N-API-KEY'], 'test-api-key');
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
});

test('updateWorkflow sends PUT body to workflow endpoint', async () => {
  const calls = [];
  const workflow = { name: 'Time Log', nodes: [], connections: {} };
  const client = createN8nApiClient({
    baseUrl: 'https://n8n.example.com',
    apiKey: 'test-api-key',
    fetch: async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) });
      return jsonResponse({ id: 'workflow-id', ...workflow });
    },
  });

  const result = await client.updateWorkflow('workflow-id', workflow);

  assert.equal(result.id, 'workflow-id');
  assert.equal(calls[0].url, 'https://n8n.example.com/api/v1/workflows/workflow-id');
  assert.equal(calls[0].options.method, 'PUT');
  assert.deepEqual(calls[0].body, workflow);
});

test('client requires environment-backed credentials', () => {
  assert.throws(() => createN8nApiClient({ fetch: async () => jsonResponse({}) }), {
    message: /N8N_BASE_URL environment variable is required/,
  });
});
