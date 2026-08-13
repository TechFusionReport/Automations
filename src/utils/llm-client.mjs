const DEFAULT_BASE_URL = 'https://omniroute.techfusionreport.com';
const DEFAULT_CHAIN = 'TFR Free Chain';
const DEFAULT_TIMEOUT_MS = 30000;

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

function safeErrorBody(value) {
  return String(value || '').replace(/\s+/g, ' ').slice(0, 300);
}

export function resolveLlmConfig(env = {}, secrets = {}) {
  return {
    enabled: enabled(env.OMNIROUTE_ENABLED ?? secrets.omniroute_enabled, true),
    fallbackEnabled: enabled(env.OMNIROUTE_FALLBACK_ENABLED ?? secrets.omniroute_fallback_enabled, true),
    baseUrl: trimSlash(env.OMNIROUTE_BASE_URL ?? secrets.omniroute_base_url),
    chain: String(env.OMNIROUTE_CHAIN ?? secrets.omniroute_chain ?? DEFAULT_CHAIN),
    timeoutMs: positiveInteger(env.OMNIROUTE_TIMEOUT_MS ?? secrets.omniroute_timeout_ms, DEFAULT_TIMEOUT_MS),
    apiKey: secrets.omniroute_api_key || env.OMNIROUTE_API_KEY || '',
  };
}

export class LlmClient {
  constructor(env, secrets = {}, { fetchImpl = fetch, logger = console } = {}) {
    this.env = env || {};
    this.secrets = secrets || {};
    this.fetch = fetchImpl;
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
      if (!this.config.fallbackEnabled) throw error;
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

  async callOmniRoute({ prompt, workflow, temperature, maxTokens }) {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    const headers = { 'Content-Type': 'application/json' };
    if (this.config.apiKey) headers.Authorization = `Bearer ${this.config.apiKey}`;

    try {
      const response = await this.fetch(`${this.config.baseUrl}/v1/chat/completions`, {
        method: 'POST',
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
        const category = classifyStatus(response.status);
        const detail = safeErrorBody(await response.text().catch(() => ''));
        throw new LlmRequestError(`OmniRoute ${category} error (${response.status})${detail ? `: ${detail}` : ''}`, {
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

      const telemetry = {
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
      };
      this.log(telemetry);
      return { text, telemetry };
    } catch (error) {
      const normalized = error?.name === 'AbortError'
        ? new LlmRequestError(`OmniRoute timed out after ${this.config.timeoutMs}ms`, { category: 'timeout', retryable: true })
        : error instanceof LlmRequestError
          ? error
          : new LlmRequestError(`OmniRoute network error: ${error?.message || 'unknown error'}`, { category: 'network', retryable: true });
      this.log({
        workflow,
        route: 'omniroute',
        requestedModel: this.config.chain,
        durationMs: Date.now() - started,
        success: false,
        errorCategory: normalized.category,
        httpStatus: normalized.status || null,
        retryCount: 0,
        fallbackActivated: this.config.fallbackEnabled,
      });
      throw normalized;
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
        const detail = safeErrorBody(await response.text().catch(() => ''));
        throw new LlmRequestError(`Gemini fallback error (${response.status})${detail ? `: ${detail}` : ''}`, {
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
      const telemetry = {
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
      };
      this.log(telemetry);
      return { text, telemetry };
    } catch (error) {
      const normalized = error?.name === 'AbortError'
        ? new LlmRequestError(`Gemini fallback timed out after ${this.config.timeoutMs}ms`, { category: 'timeout', retryable: true })
        : error instanceof LlmRequestError
          ? error
          : new LlmRequestError(`Gemini fallback network error: ${error?.message || 'unknown error'}`, { category: 'network', retryable: true });
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
      throw normalized;
    } finally {
      clearTimeout(timer);
    }
  }

  log(event) {
    this.logger.log(JSON.stringify({ event: 'llm_request', ...event }));
  }
}

export function createLlmClient(env, secrets, options) {
  return new LlmClient(env, secrets, options);
}
