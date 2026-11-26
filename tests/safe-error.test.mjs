import assert from 'node:assert/strict';
import test from 'node:test';
import { describeError } from '../src/utils/safe-error.js';

test('error summaries redact credentials, network identifiers, headers, and stack details', () => {
  const sensitive = [
    'pretend-bearer-value',
    'ghp_fixture',
    'github_pat_fixture',
    'secret_fixture',
    'f'.repeat(40),
    'aB7+'.repeat(9) + '==',
    'hidden-user:password-marker',
    'query-marker',
    'relative-marker',
    'example-user@example.invalid',
    'internal-frame',
    ['2001', 'db8', '', '1'].join(':'),
  ];
  const err = new TypeError([
    `Could not publish using Bearer ${sensitive[0]}`,
    ...sensitive.slice(1, 6),
    `https://${sensitive[6]}@example.invalid/path?token=${sensitive[7]}`,
    `/draft?token=${sensitive[8]}`,
    sensitive[9],
    sensitive[11],
    `\n    at ${sensitive[10]} (module.js:3)`,
  ].join(' '));
  const summary = describeError(err);
  assert.match(summary, /^TypeError: Could not publish using \[redacted\]/);
  for (const value of sensitive) assert.equal(summary.includes(value), false);
  assert.doesNotMatch(summary, /[\r\n]/);
  assert.equal(describeError(new Error('Service unavailable\nRequest headers: anything sensitive')),
    'Error: Service unavailable [redacted]');
  assert.equal(describeError(new Error('Unexpected response\r\ntry later')), 'Error: Unexpected response try later');
});

test('error summaries redact before truncating to 300 characters', () => {
  const secret = 'github_pat_' + 'Q'.repeat(75);
  const summary = describeError(new Error(`Publishing failed. ${'detail '.repeat(37)}${secret} ${'more info '.repeat(40)}`));
  assert.equal(summary.length, 300);
  assert.match(summary, /\[redacted\]/);
  assert.doesNotMatch(summary, /github_pat_|QQQQ/);
});
