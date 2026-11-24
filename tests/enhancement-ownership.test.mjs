import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');

test('Cloudflare Worker has no enhancement writer imports or constructors', () => {
  assert.doesNotMatch(source, /EnhancementPoller/);
  assert.doesNotMatch(source, /EnhancementAgent/);
  assert.doesNotMatch(source, /new\s+Enhancement/);
});

test('the queue has no drafting cases and scheduled polling is publish-only', () => {
  assert.doesNotMatch(source, /case '(enhance|research|structure|factcheck|finalize)'/);
  assert.match(source, /n8n owns enhancement; Worker only polls publishing/);
  assert.doesNotMatch(source, /Enhanced:\s*\$\{/);
  assert.match(source, /new PublisherPoller\(env\)\.run\(\)/);
});
