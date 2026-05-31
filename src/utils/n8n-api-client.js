const N8N_BASE_URL = 'N8N_BASE_URL_FROM_ENV';
// Set as N8N_BASE_URL environment variable where this helper runs.
const N8N_API_KEY = 'N8N_API_KEY_FROM_ENV';
// Set as N8N_API_KEY environment variable. Never commit the real key.

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, '');
}

function resolveConfig(options = {}) {
  const baseUrl = options.baseUrl || process.env.N8N_BASE_URL || N8N_BASE_URL;
  const apiKey = options.apiKey || process.env.N8N_API_KEY || N8N_API_KEY;

  if (!baseUrl || baseUrl === N8N_BASE_URL) {
    throw new Error('N8N_BASE_URL environment variable is required.');
  }

  if (!apiKey || apiKey === N8N_API_KEY) {
    throw new Error('N8N_API_KEY environment variable is required.');
  }

  return { baseUrl: trimTrailingSlash(baseUrl), apiKey };
}

function resolveFetch(fetchImpl) {
  const resolvedFetch = fetchImpl || globalThis.fetch;
  if (typeof resolvedFetch !== 'function') {
    throw new Error('A fetch implementation is required.');
  }
  return resolvedFetch;
}

async function parseResponse(response, action) {
  const body = await response.json().catch(async () => ({ message: await response.text() }));
  if (!response.ok) {
    throw new Error(`n8n ${action} failed: ${body.message || JSON.stringify(body)}`);
  }
  return body;
}

function createN8nApiClient(options = {}) {
  const fetchImpl = resolveFetch(options.fetch);
  const { baseUrl, apiKey } = resolveConfig(options);

  async function request(path, requestOptions = {}) {
    const response = await fetchImpl(`${baseUrl}/api/v1${path}`, {
      ...requestOptions,
      headers: {
        'X-N8N-API-KEY': apiKey,
        'Content-Type': 'application/json',
        ...(requestOptions.headers || {}),
      },
    });

    return parseResponse(response, `${requestOptions.method || 'GET'} ${path}`);
  }

  return {
    listWorkflows(query = {}) {
      const params = new URLSearchParams(query);
      const suffix = params.toString() ? `?${params.toString()}` : '';
      return request(`/workflows${suffix}`);
    },

    getWorkflow(workflowId) {
      if (!workflowId) throw new Error('workflowId is required.');
      return request(`/workflows/${workflowId}`);
    },

    createWorkflow(workflow) {
      if (!workflow || typeof workflow !== 'object') throw new Error('workflow is required.');
      return request('/workflows', {
        method: 'POST',
        body: JSON.stringify(workflow),
      });
    },

    updateWorkflow(workflowId, workflow) {
      if (!workflowId) throw new Error('workflowId is required.');
      if (!workflow || typeof workflow !== 'object') throw new Error('workflow is required.');
      return request(`/workflows/${workflowId}`, {
        method: 'PUT',
        body: JSON.stringify(workflow),
      });
    },

    deleteWorkflow(workflowId) {
      if (!workflowId) throw new Error('workflowId is required.');
      return request(`/workflows/${workflowId}`, { method: 'DELETE' });
    },

    activateWorkflow(workflowId) {
      if (!workflowId) throw new Error('workflowId is required.');
      return request(`/workflows/${workflowId}/activate`, { method: 'POST' });
    },

    deactivateWorkflow(workflowId) {
      if (!workflowId) throw new Error('workflowId is required.');
      return request(`/workflows/${workflowId}/deactivate`, { method: 'POST' });
    },
  };
}

module.exports = {
  N8N_BASE_URL,
  N8N_API_KEY,
  createN8nApiClient,
};
