import fs from 'node:fs';
import path from 'node:path';
import { PublishingAgent } from '../../src/agents/publishing.js';

const root = process.argv[2];
if (!root) throw new Error('Usage: node fixtures.mjs <website-root>');
const template = fs.readFileSync(path.join(root, 'blog-post-template.html'), 'utf8');
const publisher = new PublishingAgent({});
const fixtures = [
  { filename: '2026-10-27-integration-ai-guide.html', title: 'AI & "Automation" <Guide>',
    slug: 'integration-ai-guide', category: 'Technology', subcategory: 'AI Tools',
    image: 'https://example.org/fixture-hero.png', listing: 'ai.html', categoryListing: 'technology.html',
    sitemapUrl: 'https://www.techfusionreport.com/_posts/2026-10-27-integration-ai-guide.html',
    related: '2026-10-26-integration-entertainment-guide.html' },
  { filename: '2026-10-26-integration-entertainment-guide.html', title: 'Entertainment Integration Guide',
    slug: 'integration-entertainment-guide', category: 'Entertainment', subcategory: '',
    image: '', listing: 'entertainment.html', categoryListing: 'entertainment.html',
    sitemapUrl: 'https://www.techfusionreport.com/_posts/2026-10-26-integration-entertainment-guide.html',
    related: '2026-10-27-integration-ai-guide.html' }
];
for (const fixture of fixtures) {
  const other = fixtures.find(item => item.filename === fixture.related);
  const metadata = { title: fixture.title, slug: fixture.slug, category: fixture.category,
    subcategory: fixture.subcategory, image: fixture.image,
    description: 'Fixture article to validate the Website publishing contract.',
    date: fixture.filename.slice(0, 10), tags: ['Integration', 'Test'],
    relatedArticles: [{ title: other.title, url: '/_posts/' + other.filename }] };
  const html = publisher.convertToHTML(
    fixture.subcategory
      ? '<h2>Integration heading</h2><p>Safe <strong>HTML</strong> content <img src="https://example.org/inline.png" onerror="alert(1)"><a href="javascript:alert(1)">bad link</a><iframe src="https://example.org"></iframe><svg onload="alert(1)"><circle /></svg></p>'
      : '## Integration heading\\n\\nA paragraph with **bold** and <script>alert(1)</script> text.',
    metadata, template);
  const target = path.join(root, '_posts', fixture.filename);
  if (fs.existsSync(target)) throw new Error('Fixture would overwrite an existing article: ' + target);
  fs.writeFileSync(target, html);
}
fs.writeFileSync(path.join(root, '.publisher-fixture-expectations.json'), JSON.stringify(fixtures, null, 2));
const base = { title: 'Invalid', slug: 'invalid', date: '2026-10-27', category: 'Technology', description: 'Invalid fixture', tags: [] };
for (const [name, test] of [
  ['missing-category', () => publisher.convertToHTML('Text', { ...base, category: '' }, template)],
  ['unresolved-placeholder', () => publisher.convertToHTML('Text', base, template + '\n{{UNRESOLVED_CONTRACT_FIELD}}')]
]) {
  const expectedMessage = name === 'missing-category' ? 'Invalid Website category' : 'Unknown Website template placeholder';
  let rejected = false;
  try { test(); } catch (error) {
    if (!String(error.message).includes(expectedMessage)) throw new Error(name + ': unexpected rejection: ' + error.message);
    rejected = true;
  }
  if (!rejected) throw new Error('Negative fixture unexpectedly passed: ' + name);
}
console.log('Publisher negative fixtures rejected as expected');
