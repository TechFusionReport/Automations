const assert = require('node:assert/strict');
const test = require('node:test');

const {
  TIME_LOG_DATABASE_ID,
  startHandler,
  stopHandler,
} = require('../src/utils/time-log-webhook.js');

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

test('startHandler creates a TFR Time Log record and returns its id', async () => {
  const calls = [];
  const fetchMock = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return jsonResponse({ id: 'time-log-page-id' });
  };

  const result = await startHandler({
    task_id: 'task-page-id',
    task_name: 'Write pipeline notes',
    source: 'TFR',
    db: 'TFR_TASK_TRACKER',
  }, {
    fetch: fetchMock,
    notionToken: 'test-notion-token',
    now: '2026-05-14T12:00:00.000Z',
  });

  assert.deepEqual(result, { time_log_id: 'time-log-page-id' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.notion.com/v1/pages');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-notion-token');

  assert.deepEqual(calls[0].body.parent, { database_id: TIME_LOG_DATABASE_ID });
  assert.deepEqual(calls[0].body.properties.Session, {
    title: [{ text: { content: 'Write pipeline notes' } }],
  });
  assert.deepEqual(calls[0].body.properties.Status, {
    status: { name: '▶️ In Progress' },
  });
  assert.deepEqual(calls[0].body.properties.Source, {
    select: { name: 'TFR' },
  });
  assert.deepEqual(calls[0].body.properties['Start Time'], {
    date: { start: '2026-05-14T12:00:00.000Z' },
  });
  assert.deepEqual(calls[0].body.properties['TFR Task'], {
    relation: [{ id: 'task-page-id' }],
  });
  assert.equal(calls[0].body.properties['Personal Task'], undefined);
});

test('startHandler creates a Personal Time Log relation when requested', async () => {
  const calls = [];
  const fetchMock = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return jsonResponse({ id: 'personal-time-log-page-id' });
  };

  const result = await startHandler({
    task_id: 'personal-task-page-id',
    task_name: 'Plan week',
    source: 'Personal',
    db: 'LIFE_TASK_TRACKER',
  }, {
    fetch: fetchMock,
    notionToken: 'test-notion-token',
    now: '2026-05-14T13:00:00.000Z',
  });

  assert.deepEqual(result, { time_log_id: 'personal-time-log-page-id' });
  assert.deepEqual(calls[0].body.properties['Personal Task'], {
    relation: [{ id: 'personal-task-page-id' }],
  });
  assert.equal(calls[0].body.properties['TFR Task'], undefined);
});

test('stopHandler fetches an existing Time Log, updates end state, and returns duration', async () => {
  const calls = [];
  const fetchMock = async (url, options) => {
    calls.push({ url, options, body: options.body ? JSON.parse(options.body) : null });

    if (options.method === 'GET') {
      return jsonResponse({
        id: 'time-log-page-id',
        properties: {
          'Start Time': { date: { start: '2026-05-14T12:00:00.000Z' } },
        },
      });
    }

    return jsonResponse({ id: 'time-log-page-id' });
  };

  const result = await stopHandler({
    time_log_id: 'time-log-page-id',
  }, {
    fetch: fetchMock,
    notionToken: 'test-notion-token',
    now: '2026-05-14T13:30:00.000Z',
  });

  assert.deepEqual(result, {
    time_log_id: 'time-log-page-id',
    duration_hours: 1.5,
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://api.notion.com/v1/pages/time-log-page-id');
  assert.equal(calls[0].options.method, 'GET');

  assert.equal(calls[1].url, 'https://api.notion.com/v1/pages/time-log-page-id');
  assert.equal(calls[1].options.method, 'PATCH');
  assert.deepEqual(calls[1].body.properties['End Time'], {
    date: { start: '2026-05-14T13:30:00.000Z' },
  });
  assert.deepEqual(calls[1].body.properties.Status, {
    status: { name: '⏹️ Done' },
  });
  assert.deepEqual(calls[1].body.properties['Duration (hrs)'], {
    number: 1.5,
  });
});
