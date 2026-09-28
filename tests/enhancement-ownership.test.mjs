import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');

test('Cloudflare Worker has no enhancement writer imports or constructors', () => {
  assert.doesNotMatch(source, /EnhancementPoller/);
  assert.doesNotMatch(source, /EnhancementAgent/);
  assert.doesNotMatch(source, /new\s+Enhancement/);
});

test('legacy Worker enhancement endpoints fail closed and identify n8n ownership', () => {
  for (const route of ['/enhance', '/admin/enhance-poll', '/admin/enhance-single', '/batch/enhance']) {
    assert.match(source, new RegExp(`router\\.post\\('${route.replaceAll('/', '\\/')}'`));
  }
  assert.equal((source.match(/Worker enhancement retired/g) || []).length, 4);
  assert.match(source, /workflowId:\s*'YF1dipB0E8BSF5Ae'/);
  assert.match(source, /owner:\s*'n8n'/);
});

test('queue enhancement messages are ignored and scheduled polling is publish-only', () => {
  assert.match(source, /Ignoring retired Worker enhancement message/);
  assert.match(source, /n8n owns enhancement; Worker only polls publishing/);
  assert.doesNotMatch(source, /Enhanced:\s*\$\{/);
  assert.match(source, /new PublisherPoller\(env\)\.run\(\)/);
});
