const TIME_LOG_DATABASE_ID = 'c093ef06-f33c-4ab5-b44e-f2b49bf7ac78';
const NOTION_API_BASE = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

const NOTION_TOKEN = 'NOTION_TOKEN_FROM_ENV';
// Set as NOTION_TOKEN environment variable in n8n

const VALID_SOURCES = new Set(['TFR', 'Personal']);
const VALID_TASK_DBS = new Set(['TFR_TASK_TRACKER', 'LIFE_TASK_TRACKER']);

function requireFetch(fetchImpl) {
  const resolvedFetch = fetchImpl || globalThis.fetch;
  if (typeof resolvedFetch !== 'function') {
    throw new Error('A fetch implementation is required.');
  }
  return resolvedFetch;
}

function getNotionToken(token) {
  const resolvedToken = token || process.env.NOTION_TOKEN || NOTION_TOKEN;
  if (!resolvedToken || resolvedToken === NOTION_TOKEN) {
    throw new Error('NOTION_TOKEN environment variable is required.');
  }
  return resolvedToken;
}

function notionHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Notion-Version': NOTION_VERSION,
  };
}

async function parseNotionResponse(response, action) {
  const body = await response.json().catch(async () => ({ message: await response.text() }));
  if (!response.ok) {
    throw new Error(`Notion ${action} failed: ${body.message || JSON.stringify(body)}`);
  }
  return body;
}

function validateStartPayload(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('Start payload is required.');
  if (!payload.task_id) throw new Error('task_id is required.');
  if (!payload.task_name) throw new Error('task_name is required.');
  if (!VALID_SOURCES.has(payload.source)) throw new Error('source must be TFR or Personal.');
  if (!VALID_TASK_DBS.has(payload.db)) throw new Error('db must be TFR_TASK_TRACKER or LIFE_TASK_TRACKER.');
}

function validateStopPayload(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('Stop payload is required.');
  if (!payload.time_log_id) throw new Error('time_log_id is required.');
}

function isoNow(now) {
  return (now instanceof Date ? now : new Date(now || Date.now())).toISOString();
}

function buildStartProperties(payload, startTime) {
  const properties = {
    Session: { title: [{ text: { content: payload.task_name } }] },
    Status: { status: { name: '▶️ In Progress' } },
    Source: { select: { name: payload.source } },
    'Start Time': { date: { start: startTime } },
  };

  if (payload.db === 'TFR_TASK_TRACKER') {
    properties['TFR Task'] = { relation: [{ id: payload.task_id }] };
  }

  if (payload.db === 'LIFE_TASK_TRACKER') {
    properties['Personal Task'] = { relation: [{ id: payload.task_id }] };
  }

  return properties;
}

function readStartTime(page) {
  const start = page?.properties?.['Start Time']?.date?.start;
  if (!start) throw new Error('Existing Time Log record is missing Start Time.');
  return start;
}

function durationHours(startTime, endTime) {
  const startMs = new Date(startTime).getTime();
  const endMs = new Date(endTime).getTime();

  if (!Number.isFinite(startMs)) throw new Error('Start Time is invalid.');
  if (!Number.isFinite(endMs)) throw new Error('End Time is invalid.');
  if (endMs < startMs) throw new Error('End Time cannot be before Start Time.');

  const minutes = (endMs - startMs) / 60000;
  return minutes / 60;
}

function buildStopProperties(startTime, endTime) {
  return {
    'End Time': { date: { start: endTime } },
    Status: { status: { name: '⏹️ Done' } },
    'Duration (hrs)': { number: durationHours(startTime, endTime) },
  };
}

async function startHandler(payload, options = {}) {
  validateStartPayload(payload);

  const fetchImpl = requireFetch(options.fetch);
  const token = getNotionToken(options.notionToken);
  const startTime = isoNow(options.now);

  const response = await fetchImpl(`${NOTION_API_BASE}/pages`, {
    method: 'POST',
    headers: notionHeaders(token),
    body: JSON.stringify({
      parent: { database_id: TIME_LOG_DATABASE_ID },
      properties: buildStartProperties(payload, startTime),
    }),
  });

  const page = await parseNotionResponse(response, 'create page');
  return { time_log_id: page.id };
}

async function stopHandler(payload, options = {}) {
  validateStopPayload(payload);

  const fetchImpl = requireFetch(options.fetch);
  const token = getNotionToken(options.notionToken);
  const endTime = isoNow(options.now);

  const existingResponse = await fetchImpl(`${NOTION_API_BASE}/pages/${payload.time_log_id}`, {
    method: 'GET',
    headers: notionHeaders(token),
  });
  const existingPage = await parseNotionResponse(existingResponse, 'fetch page');
  const startTime = readStartTime(existingPage);

  const updateResponse = await fetchImpl(`${NOTION_API_BASE}/pages/${payload.time_log_id}`, {
    method: 'PATCH',
    headers: notionHeaders(token),
    body: JSON.stringify({
      properties: buildStopProperties(startTime, endTime),
    }),
  });

  const page = await parseNotionResponse(updateResponse, 'update page');
  return {
    time_log_id: page.id,
    duration_hours: durationHours(startTime, endTime),
  };
}

async function handleWebhook(payload, options = {}) {
  const action = payload?.action || options.action;
  if (action === 'start') return startHandler(payload, options);
  if (action === 'stop') return stopHandler(payload, options);
  throw new Error('action must be start or stop.');
}

module.exports = {
  TIME_LOG_DATABASE_ID,
  NOTION_TOKEN,
  startHandler,
  stopHandler,
  handleWebhook,
  buildStartProperties,
  buildStopProperties,
  durationHours,
};
