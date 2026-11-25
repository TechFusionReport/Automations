import assert from 'node:assert/strict';
import test from 'node:test';
import { PublisherPoller } from '../src/agents/publisher-poller.js';
import { AI_ASSISTED_LABEL, PublishingAgent } from '../src/agents/publishing.js';
import { recordContentHash } from '../src/ops/receipts.js';
import { CATALOG_PROPERTIES as P, CATALOG_STATUS as S } from '../src/utils/content-catalog.js';
import { receiptKey, signReceipt } from '../src/utils/ops-receipts.js';
import worker from '../src/index.js';

const now = Date.UTC(2026, 0, 4);
const template = `<!doctype html><script type="application/ld+json">{}</script>
<article class="article-shell article-template-shell">
<figure class="article-hero-media"></figure><figure class="article-inline-art"></figure>
<aside class="tldr-box">{{TLDR}}</aside>
<section class="article-body article-content">{{BODY_HTML}}</section>
<section class="article-body article-content">{{BODY_CONTINUED_HTML}}</section><section>{{RELATED_ARTICLES}}</section></article>`;
const rich = content => ({ rich_text: [{ text: { content } }] });
const status = name => ({ status: { name } });
const head = 'a'.repeat(40);
const secondHead = 'b'.repeat(40);
const baseSha = 'c'.repeat(40);
const ok = (data = {}) => Response.json(data);
const error = code => new Response(null, { status: code });

function fixture(t, target = {}) {
  t.mock.timers.enable({ apis: ['Date'], now });
  const id = crypto.randomUUID();
  const repo = target.WEBSITE_REPO_OWNER ? `${target.WEBSITE_REPO_OWNER}/${target.WEBSITE_REPO_NAME}` : 'TechFusionReport/Website';
  const branch = target.WEBSITE_REPO_BRANCH || 'main';
  const receipts = new Map();
  const warnings = t.mock.method(console, 'warn', () => {});
  const log = t.mock.method(console, 'log', () => {});
  const logs = t.mock.method(console, 'error', () => {});
  const env = {
    ...target,
    OPS_RECEIPT_KEY: crypto.randomUUID(),
    WORKER_SHARED_SECRET: crypto.randomUUID(),
    AGENT_STATE: { get: async key => receipts.get(key) ?? null },
    CONTENT_KV: { get: async () => null, put: async () => {}, list: async () => ({ keys: [] }) },
  };
  const page = { id, properties: {
    [P.title]: { title: [{ text: { content: 'Sample article' } }] },
    [P.status]: status(S.draftReview),
    [P.publishToGithub]: { checkbox: true },
    [P.publishedToGithub]: { checkbox: false },
    [P.blogDraft]: rich('Human-reviewed text'),
    [P.seoTitle]: rich('Sample article'),
    [P.seoSlug]: rich('sample'),
    [P.seoMeta]: rich('Sample description'),
    [P.focusKeyword]: rich('sample'),
    [P.schemaType]: { select: { name: 'Article' } },
    [P.category]: { select: { name: 'Technology' } },
    [P.seoScore]: { number: 85 },
  } };
  const gh = { pr: null, ref: null, merge: true, writes: [], trees: [], commits: 0, posts: [], files: [] };
  const queries = [];
  const patches = [];
  const calls = [];
  let editAfterStaging;
  t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
    const url = new URL(input);
    const method = init.method || 'GET';
    const path = url.pathname;
    const body = init.body ? JSON.parse(init.body) : null;
    if (url.hostname === 'api.notion.com') {
      if (path.endsWith('/query')) {
        queries.push(body);
        const pending = body.filter.status?.equals === S.publishPrOpen;
        return ok({ results: pending === (page.properties[P.status].status.name === S.publishPrOpen) ? [page] : [] });
      }
      if (path.startsWith('/v1/blocks/')) return ok({ results: [] });
      assert.equal(path, `/v1/pages/${id}`);
      if (method === 'PATCH') {
        patches.push(body.properties);
        Object.assign(page.properties, body.properties);
      }
      return ok(page);
    }

    assert.equal(url.hostname, 'api.github.com');
    const prefix = `/repos/${repo}`;
    assert.ok(path.startsWith(prefix + '/'));
    const endpoint = path.slice(prefix.length);
    calls.push({ endpoint, method, query: url.searchParams, body });
    if (method !== 'GET') gh.writes.push({ endpoint, method, body });
    if (endpoint === '/pulls' && method === 'GET') {
      assert.equal(url.searchParams.get('base'), branch);
      return ok(gh.pr && url.searchParams.get('head').endsWith(':' + gh.pr.head.ref) ? [{ number: gh.pr.number }] : []);
    }
    if (endpoint === '/pulls' && method === 'POST') {
      assert.equal(gh.pr, null);
      assert.equal(body.base, branch);
      assert.match(body.body, new RegExp(`Website target: ${repo}@${branch}`));
      gh.pr = {
        number: 1, html_url: `https://github.com/${repo}/pull/1`, base: { ref: branch },
        head: { ref: body.head, sha: gh.ref }, merged: false, state: 'open', body: body.body,
      };
      return ok(gh.pr);
    }
    if (endpoint === '/pulls/1' && method === 'GET') return ok(gh.pr);
    if (endpoint === '/pulls/1/merge') {
      assert.equal(body.sha, gh.pr.head.sha);
      if (!gh.merge) return error(405);
      Object.assign(gh.pr, { merged: true, state: 'closed' });
      return ok({ merged: true });
    }
    if (endpoint === '/contents/blog-post-template.html') {
      assert.equal(url.searchParams.get('ref'), branch);
      return ok({ encoding: 'base64', content: Buffer.from(template).toString('base64') });
    }
    if (endpoint === '/contents/posts.json') {
      assert.equal(url.searchParams.get('ref'), baseSha);
      return ok({ content: Buffer.from(JSON.stringify(gh.posts)).toString('base64') });
    }
    if (endpoint === '/contents/_posts') {
      assert.equal(url.searchParams.get('ref'), baseSha);
      return ok(gh.files);
    }
    if (endpoint === `/git/ref/heads/${branch}`) return ok({ object: { sha: baseSha } });
    if (endpoint.startsWith('/git/ref/heads/publish/')) {
      return gh.ref && !endpoint.endsWith('-sample') ? ok({ object: { sha: gh.ref } }) : error(404);
    }
    if (endpoint === `/git/commits/${baseSha}`) return ok({ tree: { sha: 'base-tree' } });
    if (endpoint === '/git/trees') {
      assert.equal(body.base_tree, 'base-tree');
      gh.trees.push(body.tree);
      return ok({ sha: 'staged-tree' });
    }
    if (endpoint === '/git/commits') return ok({ sha: gh.commits++ ? secondHead : head });
    if (endpoint.startsWith('/git/refs')) {
      if (method === 'PATCH') assert.equal(body.force, false);
      gh.ref = body.sha;
      editAfterStaging?.();
      return ok();
    }
    assert.fail(`Unexpected GitHub request: ${method} ${endpoint}`);
  });

  async function approve(...gates) {
    const hash = await recordContentHash({ listBlocks: async () => ({ results: [] }) }, page);
    for (const gate of gates) {
      const receipt = await signReceipt(env.OPS_RECEIPT_KEY, {
        pageId: id, gate, approver: 'editor@example.invalid', contentHash: hash, issuedAt: now,
      });
      receipts.set(receiptKey(id, gate), JSON.stringify(receipt));
    }
  }
  function existingPR(merged) {
    gh.pr = {
      number: 1, html_url: `https://github.com/${repo}/pull/1`, base: { ref: branch },
      state: 'closed', merged, body: `Notion-Page-Id: ${id}\nPublished-Path: _posts/2026-01-04-sample.html`,
    };
    page.properties[P.status] = status(S.publishPrOpen);
    page.properties[P.publishPrUrl] = { url: gh.pr.html_url };
  }
  return { id, page, env, approve, gh, repo, branch, queries, patches, calls, existingPR, warnings, log, logs,
    onStaged: fn => { editAfterStaging = fn; }, run: () => new PublisherPoller(env).run() };
}

for (const [scenario, expected, setup] of [
  ['checkbox alone', 'no_valid_receipt', async () => {}],
  ['missing gate 1', 'no_valid_gate_1', async f => f.approve(2)],
  ['edited draft', 'content_changed', async f => {
    await f.approve(1, 2);
    f.page.properties[P.blogDraft] = rich('New draft');
  }],
]) {
  test(`${scenario} cannot publish`, async t => {
    const f = fixture(t);
    await setup(f);
    assert.equal((await f.run()).skipped, 1);
    assert.equal(f.gh.writes.length, 0);
    assert.equal(f.warnings.mock.calls.length, 1);
    assert.equal(f.warnings.mock.calls[0].arguments[0], `Publisher Poller: skipped — ${expected}`);
    const criteria = f.queries[1].filter.and;
    assert.deepEqual(criteria[0], { property: P.publishToGithub, checkbox: { equals: true } });
    assert.deepEqual(criteria[1], { property: P.publishedToGithub, checkbox: { equals: false } });
    assert.ok(!JSON.stringify(criteria[2]).includes(S.publishApproved));
  });
}

for (const binding of ['OPS_RECEIPT_KEY', 'AGENT_STATE']) {
  test(`missing ${binding} fails closed and logs once`, async t => {
    const f = fixture(t);
    delete f.env[binding];
    assert.equal((await f.run()).processed, 0);
    assert.equal(f.queries.length, 0);
    assert.equal(f.gh.writes.length, 0);
    assert.equal(f.warnings.mock.callCount(), 1);
  });
}

for (const target of [{}, {
  WEBSITE_REPO_OWNER: 'example-owner', WEBSITE_REPO_NAME: 'example-preview', WEBSITE_REPO_BRANCH: 'release/preview',
}]) {
  test(`valid receipt publishes using ${target.WEBSITE_REPO_NAME || 'the default Website target'}`, async t => {
    const f = fixture(t, target);
    await f.approve(1, 2);
    assert.equal((await f.run()).processed, 1);
    assert.equal(f.page.properties[P.publishedToGithub].checkbox, true);
    assert.equal(f.page.properties[P.status].status.name, S.publishedToGithub);
    assert.ok(f.page.properties[P.publishedUrl].url.startsWith(`https://github.com/${f.repo}/blob/${f.branch}/`));
    assert.ok(f.log.mock.calls.some(call => String(call.arguments[0]).includes(`${f.repo}@${f.branch}`)));
    assert.equal(f.gh.trees[0][0].content.split(AI_ASSISTED_LABEL).length - 1, 1);
    const writes = f.gh.writes.length;
    assert.equal((await f.run()).skipped, 1);
    assert.equal(f.gh.writes.length, writes);
  });
}

test('already-Published and SEO-blocked records cannot publish', async t => {
  const f = fixture(t);
  await f.approve(1, 2);
  f.page.properties[P.status] = status(S.publishedToGithub);
  assert.equal((await f.run()).skipped, 1);
  f.page.properties[P.status] = status(S.draftReview);
  f.page.properties[P.seoScore] = { number: 84 };
  assert.equal((await f.run()).blocked, 1);
  assert.equal(f.gh.writes.length, 0);
});

test('editing during staging prevents PR creation, and a new approval reuses the branch', async t => {
  const f = fixture(t);
  await f.approve(1, 2);
  f.onStaged(() => { f.page.properties[P.blogDraft] = rich('Changed during branch staging'); });
  assert.equal((await f.run()).skipped, 1);
  assert.equal(f.gh.pr, null);
  f.onStaged(null);
  await f.approve(2);
  assert.equal((await f.run()).processed, 1);
  assert.equal(f.gh.writes.filter(call => call.endpoint === '/git/refs').length, 1);
  assert.equal(f.gh.writes.filter(call => call.method === 'PATCH' && call.endpoint.startsWith('/git/refs')).length, 1);
  assert.ok(f.gh.trees[1][0].content.includes('Changed during branch staging'));
  assert.ok(!f.gh.trees[1][0].content.includes('Human-reviewed text'));
});

for (const merged of [true, false]) {
  test(`reconciles a ${merged ? 'merged' : 'closed unmerged'} PR without any GitHub writes`, async t => {
    const f = fixture(t);
    f.existingPR(merged);
    const results = await f.run();
    assert.equal(results.processed, Number(merged));
    assert.equal(results.errors, Number(!merged));
    assert.equal(f.page.properties[P.publishedToGithub].checkbox, merged);
    assert.equal(f.page.properties[P.status].status.name, merged ? S.publishedToGithub : S.publishFailed);
    if (!merged) {
      assert.equal(f.page.properties[P.lastError].rich_text[0].text.content, 'Publish PR closed without merging.');
    }
    const patches = f.patches.length;
    await f.run();
    assert.equal(f.patches.length, patches);
    assert.equal(f.gh.writes.length, 0);
  });
}

test('open PR gets one authenticated merge retry per run and is never duplicated', async t => {
  const f = fixture(t);
  await f.approve(1, 2);
  f.gh.merge = false;
  assert.equal((await f.run()).awaitingMerge, 1);
  assert.equal((await f.run()).awaitingMerge, 1);
  assert.equal(f.gh.writes.filter(call => call.endpoint === '/pulls/1/merge').length, 2);
  f.page.properties[P.blogDraft] = rich('Changed while PR is open');
  assert.equal((await f.run()).awaitingMerge, 1);
  assert.equal(f.gh.writes.filter(call => call.endpoint === '/pulls/1/merge').length, 2);
  f.page.properties[P.blogDraft] = rich('Human-reviewed text');
  f.gh.merge = true;
  assert.equal((await f.run()).processed, 1);
  assert.equal(f.gh.writes.filter(call => call.endpoint === '/pulls').length, 1);
  assert.equal(f.gh.writes.filter(call => call.endpoint === '/git/refs').length, 1);
});

test('legacy direct publish route cannot bypass receipt enforcement with supplied content', async t => {
  const f = fixture(t);
  const response = await worker.fetch(new Request('https://worker.example/publish', {
    method: 'POST',
    headers: { 'X-Worker-Secret': f.env.WORKER_SHARED_SECRET },
    body: JSON.stringify({ notionPageId: f.id, content: 'unauthorized override' }),
  }), f.env, {});
  assert.deepEqual(await response.json(), { skipped: true, reason: 'no_valid_receipt' });
  assert.equal(f.gh.writes.length, 0);
});

test('rerendering the article body preserves exactly one leading AI disclosure', () => {
  const agent = new PublishingAgent({});
  const metadata = { date: '2026-01-04', title: 'Sample', slug: 'sample', category: 'Technology' };
  const render = input => agent.convertToHTML(input, metadata, template);
  const first = render('The article body');
  const body = first.match(/<section class="article-body article-content">([\s\S]*?)<\/section>/)[1];
  const second = render(body);
  assert.equal(second.split(AI_ASSISTED_LABEL).length - 1, 1);
  assert.match(second, /<section class="article-body article-content"><p class="ai-assisted-disclosure">AI-assisted:/);
});


test('TFR Read summary escapes punctuation and literal script text exactly once', () => {
  const agent = new PublishingAgent({});
  const metadata = { date: '2026-01-04', title: 'Sample', slug: 'sample', category: 'Technology' };
  const text = "TFR's tips & tricks, \"quoted\" with <script>alert('example')</script> and &lt;literal&gt;.";
  const html = agent.convertToHTML(text, metadata, template);
  const summary = html.match(/<aside class="tldr-box">([^]*?)<\/aside>/)[1];
  assert.equal(summary, 'TFR&#039;s tips &amp; tricks, &quot;quoted&quot; with &lt;script&gt;alert(&#039;example&#039;)&lt;/script&gt; and &amp;lt;literal&amp;gt;.');
  assert.ok(!summary.includes('<script>'));

  const trustedHtml = "<p>TFR&#39;s tips &amp; tricks with &quot;quotes&quot;</p><script>not summary text</script>";
  const trusted = agent.convertToHTML(trustedHtml, metadata, template);
  assert.equal(trusted.match(/<aside class="tldr-box">([^]*?)<\/aside>/)[1],
    'TFR&#039;s tips &amp; tricks with &quot;quotes&quot;');
});

test('TFR Read truncates decoded summary text and keeps the ellipsis', () => {
  const agent = new PublishingAgent({});
  const metadata = { date: '2026-01-04', title: 'Sample', slug: 'sample', category: 'Technology' };
  const html = agent.convertToHTML(`TFR's ${'x'.repeat(250)}`, metadata, template);
  assert.equal(html.match(/<aside class="tldr-box">([^]*?)<\/aside>/)[1], `TFR&#039;s ${'x'.repeat(191)}...`);
});

test('related cards need both a target index entry and an article file at the resolved base', async t => {
  const f = fixture(t, {
    WEBSITE_REPO_OWNER: 'example-owner', WEBSITE_REPO_NAME: 'example-preview', WEBSITE_REPO_BRANCH: 'release/preview',
  });
  const related = ['stale-cache-only', 'missing-file', 'available'];
  const article = slug => ({
    slug, title: `Cached ${slug}`, date: '2025-12-01', category: 'Technology',
    canonicalUrl: `https://production.example/_posts/2025-12-01-${slug}.html`,
  });
  const path = slug => `_posts/2025-12-01-${slug}.html`;
  f.env.CONTENT_KV.list = async () => ({ keys: related.map(name => ({ name })) });
  f.env.CONTENT_KV.get = async key => related.includes(key) ? JSON.stringify(article(key)) : null;
  f.gh.posts = [
    { title: 'Missing file', url: `/${path('missing-file')}` },
    { title: 'Current index title', url: `/${path('available')}` },
  ];
  f.gh.files = [
    { type: 'file', path: path('available') },
    { type: 'file', path: path('stale-cache-only') },
  ];
  await f.approve(1, 2);
  assert.equal((await f.run()).processed, 1);
  const html = f.gh.trees[0][0].content;
  assert.match(html, /<a class="post-card" href="\.\.\/_posts\/2025-12-01-available\.html"><h3>Current index title<\/h3><\/a>/);
  assert.doesNotMatch(html, /stale-cache-only|missing-file|production\.example/);
  assert.equal(f.calls.filter(call => call.endpoint === '/contents/posts.json').length, 1);
  assert.equal(f.calls.filter(call => call.endpoint === '/contents/_posts').length, 1);
});

const affiliateDraft = 'The github repository covers hosting and notes.';

async function renderAffiliateDraft(t, draft, flag) {
  const f = fixture(t, flag === undefined ? {} : { AFFILIATE_LINKS_ENABLED: flag });
  f.page.properties[P.blogDraft] = rich(draft);
  await f.approve(1, 2);
  assert.equal((await f.run()).processed, 1);
  return f.gh.trees[0][0].content;
}

for (const flag of [undefined, 'false', '1', 'TRUE', '']) {
  test(`affiliate keyword links stay off when the flag is ${flag === undefined ? 'unset' : JSON.stringify(flag)}`, async t => {
    const html = await renderAffiliateDraft(t, affiliateDraft, flag);
    assert.ok(html.includes(`<p>${affiliateDraft}</p>`));
    assert.doesNotMatch(html, /\?ref=techfusion|<a[^>]*>(?:github|repository|hosting|notes)<\/a>/);
  });
}

test('exact true retains the existing affiliate keyword links', async t => {
  const html = await renderAffiliateDraft(t, affiliateDraft, 'true');
  for (const [keyword, url] of [
    ['github', 'https://github.com'],
    ['repository', 'https://github.com'],
    ['hosting', 'https://vercel.com'],
    ['notes', 'https://notion.so'],
  ]) {
    assert.ok(html.includes(`<a href="${url}?ref=techfusion" rel="noopener noreferrer">${keyword}</a>`));
  }
});

test('disabled affiliate placeholders become plain text and hand-written links stay intact', async t => {
  const html = await renderAffiliateDraft(t,
    'Use [AFFILIATE: Notion] or [affiliate:  vercel ]. See [the repository](https://example.invalid/docs?source=editor).');
  assert.ok(html.includes('<p>Use Notion or vercel. See <a href="https://example.invalid/docs?source=editor" rel="noopener noreferrer">the repository</a>.</p>'));
  assert.doesNotMatch(html, /affiliate:|\?ref=techfusion/i);
});
