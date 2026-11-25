const DEFAULT_BASE_URL = 'https://omniroute.techfusionreport.com';
const DEFAULT_CHAIN = 'TFR Free Chain';
const DEFAULT_TIMEOUT_MS = 30000;
const ACCESS_BLOCK_MESSAGE = 'OmniRoute blocked by Cloudflare Access (service token missing, wrong, or not in the policy)';

export class LlmRequestError extends Error {
  constructor(message, { category = 'unknown', status = 0, retryable = false } = {}) {
    super(message);
    this.name = 'LlmRequestError';
    this.category = category;
    this.status = status;
    this.retryable = retryable;
  }
}

function enabled(value, defaultValue = true) {
  if (value == null || value === '') return defaultValue;
  return value === true || String(value).toLowerCase() === 'true' || String(value) === '1';
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function trimSlash(value) {
  return String(value || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function headerValue(headers, name) {
  return headers?.get?.(name) || null;
}

function classifyStatus(status) {
  if (status === 401 || status === 403) return 'authentication';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'unavailable';
  if (status >= 400) return 'request';
  return 'unknown';
}

export function omniRouteHeaders({ apiKey, accessClientId, accessClientSecret }) {
  return {
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    ...(accessClientId && accessClientSecret ? {
      'CF-Access-Client-Id': accessClientId,
      'CF-Access-Client-Secret': accessClientSecret,
    } : {}),
  };
}

export async function isOmniRouteAccessBlock(response) {
  if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) return true;
  if (response.status !== 401 && response.status !== 403) return false;
  if (response.headers?.has?.('cf-access-aud') || response.headers?.has?.('cf-access-domain')
    || /^(?:text\/html|application\/xhtml\+xml)\b/i.test(headerValue(response.headers, 'content-type') || '')) return true;
  const body = await response.text().catch(() => '');
  return /^\s*(?:<!doctype\s+html\b|<(?:html|head|body|title|meta|form|div|h[1-6]|p)(?:\s|>))/i.test(body);
}

export function resolveLlmConfig(env = {}, secrets = {}) {
  return {
    enabled: enabled(env.OMNIROUTE_ENABLED ?? secrets.omniroute_enabled, true),
    fallbackEnabled: enabled(env.OMNIROUTE_FALLBACK_ENABLED ?? secrets.omniroute_fallback_enabled, true),
    baseUrl: trimSlash(env.OMNIROUTE_BASE_URL ?? secrets.omniroute_base_url),
    chain: String(env.OMNIROUTE_CHAIN ?? secrets.omniroute_chain ?? DEFAULT_CHAIN),
    timeoutMs: positiveInteger(env.OMNIROUTE_TIMEOUT_MS ?? secrets.omniroute_timeout_ms, DEFAULT_TIMEOUT_MS),
    apiKey: secrets.omniroute_api_key || env.OMNIROUTE_API_KEY || '',
    accessClientId: env.OMNIROUTE_ACCESS_CLIENT_ID || secrets.omniroute_access_client_id || '',
    accessClientSecret: env.OMNIROUTE_ACCESS_CLIENT_SECRET || secrets.omniroute_access_client_secret || '',
  };
}

export class LlmClient {
  constructor(env, secrets = {}, { fetchImpl = fetch, logger = console } = {}) {
    this.env = env || {};
    this.secrets = secrets || {};
    this.fetch = (...args) => fetchImpl(...args);
    this.logger = logger;
    this.config = resolveLlmConfig(this.env, this.secrets);
  }

  async completeText({ prompt, workflow, temperature = 0.7, maxTokens = 4096, legacyModel = 'gemini-2.5-flash' }) {
    if (!this.config.enabled) {
      return this.callGeminiFallback({ prompt, workflow, temperature, maxTokens, legacyModel, reason: 'disabled' });
    }

    try {
      return await this.callOmniRoute({ prompt, workflow, temperature, maxTokens });
    } catch (error) {
      if (!this.shouldFallback(error)) throw error;
      return this.callGeminiFallback({
        prompt,
        workflow,
        temperature,
        maxTokens,
        legacyModel,
        reason: error.category || 'unknown',
        omniRouteError: error,
      });
    }
  }

  shouldFallback(error) {
    return this.config.fallbackEnabled && error?.category !== 'authentication';
  }

  async callOmniRoute({ prompt, workflow, temperature, maxTokens }) {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    const headers = { 'Content-Type': 'application/json', ...omniRouteHeaders(this.config) };

    const { accessClientId, accessClientSecret } = this.config;
    if (!this.warnedPartialAccess && Boolean(accessClientId) !== Boolean(accessClientSecret)) {
      this.warnedPartialAccess = true;
      this.log({
        event: 'llm_config_warning',
        missingVariable: accessClientId ? 'OMNIROUTE_ACCESS_CLIENT_SECRET' : 'OMNIROUTE_ACCESS_CLIENT_ID',
      });
    }

    try {
      const response = await this.fetch(`${this.config.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        redirect: 'manual',
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          model: this.config.chain,
          messages: [{ role: 'user', content: String(prompt || '') }],
          temperature,
          max_tokens: maxTokens,
          stream: false,
        }),
      });

      if (!response.ok) {
        const blocked = await isOmniRouteAccessBlock(response);
        const category = blocked ? 'authentication' : classifyStatus(response.status);
        throw new LlmRequestError(blocked ? ACCESS_BLOCK_MESSAGE : `OmniRoute ${category} error (${response.status})`, {
          category,
          status: response.status,
          retryable: response.status === 429 || response.status >= 500,
        });
      }

      const data = await response.json().catch(() => null);
      const text = data?.choices?.[0]?.message?.content;
      if (typeof text !== 'string' || !text.trim()) {
        throw new LlmRequestError('OmniRoute returned a malformed chat completion', { category: 'malformed_response' });
      }

      const telemetry = this.redactTelemetry({
        workflow,
        route: 'omniroute',
        requestedModel: this.config.chain,
        durationMs: Date.now() - started,
        success: true,
        retryCount: 0,
        fallbackActivated: false,
        requestId: headerValue(response.headers, 'x-omniroute-request-id') || headerValue(response.headers, 'x-request-id'),
        downstreamProvider: headerValue(response.headers, 'x-omniroute-provider'),
        downstreamModel: headerValue(response.headers, 'x-omniroute-model'),
      });
      this.log(telemetry);
      return { text, telemetry };
    } catch (error) {
      const normalized = error?.name === 'AbortError'
        ? new LlmRequestError(`OmniRoute timed out after ${this.config.timeoutMs}ms`, { category: 'timeout', retryable: true })
        : error instanceof LlmRequestError
          ? error
          : new LlmRequestError('OmniRoute network error', { category: 'network', retryable: true });
      this.log({
        workflow,
        route: 'omniroute',
        requestedModel: this.config.chain,
        durationMs: Date.now() - started,
        success: false,
        errorCategory: normalized.category,
        httpStatus: normalized.status || null,
        retryCount: 0,
        fallbackActivated: this.shouldFallback(normalized),
      });
      throw new LlmRequestError(this.redactValue(normalized.message) ?? 'LLM request failed', normalized);
    } finally {
      clearTimeout(timer);
    }
  }

  async callGeminiFallback({ prompt, workflow, temperature, maxTokens, legacyModel, reason, omniRouteError }) {
    const key = this.secrets.gemini_api_key || this.env.GEMINI_API_KEY;
    if (!key) {
      if (omniRouteError) throw omniRouteError;
      throw new LlmRequestError('gemini_api_key missing from secrets', { category: 'fallback_configuration' });
    }

    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await this.fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(legacyModel)}:generateContent?key=${encodeURIComponent(key)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            contents: [{ parts: [{ text: String(prompt || '') }] }],
            generationConfig: { temperature, maxOutputTokens: maxTokens },
          }),
        }
      );
      if (!response.ok) {
        throw new LlmRequestError(`Gemini fallback error (${response.status})`, {
          category: classifyStatus(response.status),
          status: response.status,
          retryable: response.status === 429 || response.status >= 500,
        });
      }
      const data = await response.json().catch(() => null);
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (typeof text !== 'string' || !text.trim()) {
        throw new LlmRequestError('Gemini fallback returned a malformed response', { category: 'malformed_response' });
      }
      const telemetry = this.redactTelemetry({
        workflow,
        route: 'direct_fallback',
        requestedModel: legacyModel,
        durationMs: Date.now() - started,
        success: true,
        retryCount: 0,
        fallbackActivated: reason !== 'disabled',
        fallbackReason: reason,
        downstreamProvider: 'google',
        downstreamModel: legacyModel,
      });
      this.log(telemetry);
      return { text, telemetry };
    } catch (error) {
      const normalized = error?.name === 'AbortError'
        ? new LlmRequestError(`Gemini fallback timed out after ${this.config.timeoutMs}ms`, { category: 'timeout', retryable: true })
        : error instanceof LlmRequestError
          ? error
          : new LlmRequestError('Gemini fallback network error', { category: 'network', retryable: true });
      this.log({
        workflow,
        route: 'direct_fallback',
        requestedModel: legacyModel,
        durationMs: Date.now() - started,
        success: false,
        errorCategory: normalized.category,
        httpStatus: normalized.status || null,
        retryCount: 0,
        fallbackActivated: reason !== 'disabled',
        fallbackReason: reason,
      });
      throw new LlmRequestError(this.redactValue(normalized.message) ?? 'LLM request failed', normalized);
    } finally {
      clearTimeout(timer);
    }
  }

  redactValue(value) {
    const credentials = [this.config.accessClientId, this.config.accessClientSecret, this.config.apiKey,
      this.secrets.gemini_api_key || this.env.GEMINI_API_KEY].filter(Boolean);
    return typeof value === 'string' && credentials.some(credential => value.includes(credential)) ? null : value;
  }

  redactTelemetry(event) {
    return Object.fromEntries(Object.entries(event).map(([name, value]) => [name, this.redactValue(value)]));
  }

  log(event) {
    this.logger.log(JSON.stringify(this.redactTelemetry({ event: 'llm_request', ...event })));
  }
}

export function createLlmClient(env, secrets, options) {
  return new LlmClient(env, secrets, options);
}
