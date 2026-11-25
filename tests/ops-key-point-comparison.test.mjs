import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPointComparison } from '../src/ops/key-point-comparison.js';
import { LlmClient } from '../src/utils/llm-client.mjs';

test('comparison preserves the review prompt, input limits, and model settings', async t => {
  const completeText = t.mock.method(LlmClient.prototype, 'completeText', async () => ({
    text: 'COVERAGE ESTIMATE\n- 80%',
  }));
  const env = {
    CONTENT_KV: {
      get: async name => {
        assert.equal(name, 'secrets');
        return null;
      },
    },
  };
  const transcript = 'a'.repeat(120000);
  const result = await generateKeyPointComparison(env, `  ${transcript}tail  `, '  the draft  ');
  assert.equal(result, 'COVERAGE ESTIMATE\n- 80%');
  assert.equal(completeText.mock.callCount(), 1);
  const [{ prompt, ...settings }] = completeText.mock.calls[0].arguments;
  assert.deepEqual(settings, {
    workflow: 'enhancement.generate',
    temperature: 0.1,
    maxTokens: 4096,
    legacyModel: 'gemini-2.5-flash',
  });
  assert.match(prompt, /COVERED KEY POINTS[\s\S]+OMITTED FROM DRAFT[\s\S]+POSSIBLY UNSUPPORTED IN DRAFT[\s\S]+CHANGED DETAILS[\s\S]+COVERAGE ESTIMATE/);
  assert.ok(prompt.endsWith(`ORIGINAL TRANSCRIPT:\n${transcript}\n\nBLOG DRAFT:\nthe draft`));
});

test('comparison rejects blank input before accessing bindings', async () => {
  await assert.rejects(generateKeyPointComparison({}, ' ', 'draft'), /Transcript and blog draft are required/);
  await assert.rejects(generateKeyPointComparison({}, 'transcript', ' '), /Transcript and blog draft are required/);
});
