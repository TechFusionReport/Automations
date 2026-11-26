import assert from 'node:assert/strict';
import test from 'node:test';
import { computeSeoScore } from '../src/utils/seo-score.js';

const complete = {
  seoTitle: 'battery health ' + 'x'.repeat(40),
  seoSlug: 'understanding-battery-health',
  seoMeta: 'Battery health ' + 'x'.repeat(135),
  focusKeyword: 'Battery Health',
  schemaType: 'Article',
  imageAlt: 'A battery',
  body: 'Battery health matters.\n\n## First\n\n' + 'detail '.repeat(600) + '\n\n<h2>Second</h2>',
  internalLinks: 'https://techfusionreport.com/first, /second',
};

test('the Worker rubric awards exactly 100 points for a complete article', () => {
  assert.deepEqual(computeSeoScore(complete), { score: 100, breakdown: {
    seoTitleLength: 15, seoMetaLength: 15, seoSlug: 10, keywordInTitle: 10, keywordInMeta: 10,
    keywordInOpening: 10, bodyLength: 10, h2Headings: 5, imageAlt: 5, internalLinks: 5, schemaType: 5,
  } });
  assert.equal(computeSeoScore({}).score, 0);
});

test('length partial credit is bounded and slug words must be whole and lowercase', () => {
  const { breakdown } = computeSeoScore({
    ...complete, seoTitle: 'x'.repeat(45), seoMeta: 'x'.repeat(176), seoSlug: 'battery-healthier',
  });
  assert.equal(breakdown.seoTitleLength, 12);
  assert.equal(breakdown.seoMetaLength, 12);
  assert.equal(breakdown.seoSlug, 0);
  assert.equal(computeSeoScore({ ...complete, seoSlug: 'Battery-health' }).breakdown.seoSlug, 0);
  assert.equal(computeSeoScore({ seoTitle: 'x'.repeat(44), seoMeta: 'x'.repeat(177) }).score, 0);
});

test('body checks ignore code and count only distinct internal destinations', () => {
  const { breakdown } = computeSeoScore({
    ...complete,
    body: 'first '.repeat(100) + '\nbattery health\n\n```md\n## Example\n<h2>Code</h2>\n```\n'
      + '[Same topic](/first#section) [External](https://outside.example/topic)',
    internalLinks: 'https://www.techfusionreport.com/first?source=example /first',
  });
  assert.equal(breakdown.keywordInOpening, 0);
  assert.equal(breakdown.h2Headings, 0);
  assert.equal(breakdown.bodyLength, 0);
  assert.equal(breakdown.internalLinks, 0);
  assert.equal(computeSeoScore({ ...complete, body: '[One](/first) <a href="/second">Two</a>', internalLinks: '' }).breakdown.internalLinks, 5);
});
