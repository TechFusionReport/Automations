import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeActionQueue } from '../src/ops/router.js';
import { jobIdFromPageId } from '../src/ops/notion.js';

test('creates a stable job id from a Notion page id', () => {
  assert.equal(
    jobIdFromPageId('1fbbd080-de92-8043-89aa-dc02853c15c7'),
    'tfr:1fbbd080de92804389aadc02853c15c7',
  );
});

test('prioritizes human-review failures ahead of normal review work', () => {
  const items = normalizeActionQueue([
    {
      id: 'pending', jobId: 'tfr:pending', title: 'Normal review', status: '🟡 Pending Review',
      notionUrl: 'https://www.notion.so/pending', attemptCount: 0, retryDisposition: null, lastError: '',
    },
    {
      id: 'failed', jobId: 'tfr:failed', title: 'Failed publish', status: '❌ Publish Failed',
      notionUrl: 'https://www.notion.so/failed', attemptCount: 3, retryDisposition: 'Human Review', lastError: 'GitHub rejected commit',
    },
  ]);

  assert.equal(items[0].id, 'failed');
  assert.equal(items[0].priority, 'critical');
  assert.equal(items[0].action, 'approve-publish');
  assert.equal(items[1].targetView, 'queue');
});

test('keeps automatic retries visible without offering a manual action', () => {
  const [item] = normalizeActionQueue([{
    id: 'retrying', jobId: 'tfr:retrying', title: 'Retrying transcript', status: '❌ Transcription Failed',
    notionUrl: 'https://www.notion.so/retrying', attemptCount: 1, retryDisposition: 'Automatic', lastError: 'extractor timeout',
  }]);

  assert.equal(item.priority, 'medium');
  assert.equal(item.action, null);
  assert.match(item.recommendedAction, /Automatic retry/);
});
