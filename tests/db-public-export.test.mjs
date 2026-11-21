// No network, no token: fetch, R2 and the clock are mocked, and every Notion row is fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DATASETS, ALLOWED_ITEM_KEYS, buildDataset, mapRow, sanitizeUrl, slugify, normalizeTagConfig, assertAllowedKeys,
} from '../db-public-export/export-mapping.js';
import { createNotionClient, fetchDatasetPages } from '../db-public-export/notion-query.js';
import { createHandler, runExport, safeEqual, belowGuard } from '../db-public-export/export-runner.js';
import worker from '../db-public-export/db-public-export.js';

const NO_TAGS = normalizeTagConfig({ allow: [], aliases: {} });
const NOW = new Date('2026-11-21T12:00:00.000Z');
const dataset = (name) => DATASETS.find((d) => d.name === name);

// ---- fake Notion property / page builders ----
const rich = (s) => [{ plain_text: s }];
const P = {
  title: (s) => ({ type: 'title', title: rich(s) }),
  text: (s) => ({ type: 'rich_text', rich_text: rich(s) }),
  url: (s) => ({ type: 'url', url: s }),
  select: (s) => ({ type: 'select', select: s ? { name: s } : null }),
  multi: (a) => ({ type: 'multi_select', multi_select: a.map((name) => ({ name })) }),
  check: (b) => ({ type: 'checkbox', checkbox: b }),
  num: (n) => ({ type: 'number', number: n }),
};
const page = (properties) => ({ object: 'page', id: 'page-id-must-not-leak', url: 'https://notion.example/page-url-must-not-leak', properties });
// Properties the export must never read or publish.
const FORBIDDEN = {
  'Gallery Description': P.text('SENTINEL-GALLERY'), 'Editor Notes': P.text('SENTINEL-EDITOR'),
  Brief: P.text('SENTINEL-BRIEF'), 'OSAT Link': P.url('https://osat.example/SENTINEL-OSAT'),
  'AI Summary': P.text('SENTINEL-AI'), Notes: P.text('SENTINEL-NOTES'), Status: P.select('SENTINEL-STATUS'),
};
const app = (over = {}) => page({
  Name: P.title('Good App'), Description: P.text('Does a thing'), Platform: P.multi(['Android', 'iOS']),
  'Paid/Free': P.select('Free'), Price: P.text('$0'), Rating: P.num(4.5), Tags: P.multi(['Finances', 'Notes']),
  URL: P.url('https://good.example/app'), Verdict: P.select('Keep'), Discontinued: P.check(false), ...FORBIDDEN, ...over,
});

// ---- field mapping per database ----
test('smartphone apps: allowlisted fields map to the public shape', () => {
  const { output } = buildDataset(dataset('smartphone-apps'), [app()], NO_TAGS, NOW);
  assert.deepEqual(output, {
    updated: '2026-11-21T12:00:00.000Z', count: 1,
    items: [{ id: 'good-app', name: 'Good App', url: 'https://good.example/app', description: 'Does a thing',
      platform: 'Android, iOS', price: 'Free', pricing: '$0', rating: 4.5, tags: [] }],
  });
  assert.ok(!JSON.stringify(output).includes('SENTINEL'), 'no forbidden property may reach the output');
  assert.ok(!JSON.stringify(output).includes('must-not-leak'), 'no Notion page id or url may reach the output');
});

test('gtk websites map', () => {
  const row = page({ Website: P.title('Gnome Site'), URL: P.url('https://gnome.example'), Category: P.select('Desktop'),
    Description: P.text('desc'), Tags: P.multi(['x']), ...FORBIDDEN });
  const { output } = buildDataset(dataset('gtk-websites'), [row], NO_TAGS, NOW);
  assert.deepEqual(output.items, [{ id: 'gnome-site', name: 'Gnome Site', url: 'https://gnome.example/', description: 'desc', category: 'Desktop', tags: [] }]);
  assert.ok(!JSON.stringify(output).includes('SENTINEL'));
});

test('ai tools map, reading the misspelled "Descripton" property', () => {
  const row = page({ 'AI Tool': P.title('Bot'), Descripton: P.text('typo prop'), Description: P.text('WRONG'),
    URL: P.url('https://bot.example'), Price: P.select('Paid'), Pricing: P.text('$10/mo'), Tags: P.multi([]), ...FORBIDDEN });
  const { output } = buildDataset(dataset('ai-tools'), [row], NO_TAGS, NOW);
  assert.deepEqual(output.items, [{ id: 'bot', name: 'Bot', url: 'https://bot.example/', description: 'typo prop', price: 'Paid', pricing: '$10/mo', tags: [] }]);
});

test('open source alternatives map and never export Brief or OSAT Link', () => {
  const row = page({ Name: P.title('Libre'), AlternativeTo: P.text('Proprietary'), 'Home Website': P.url('http://libre.example'),
    Tags: P.multi(['oss']), ...FORBIDDEN });
  const { output } = buildDataset(dataset('open-source-alternatives'), [row], NO_TAGS, NOW);
  assert.deepEqual(output.items, [{ id: 'libre', name: 'Libre', url: 'https://libre.example/', alternativeTo: 'Proprietary', tags: [] }]);
  assert.ok(!JSON.stringify(output).includes('SENTINEL'));
});

test('absent optional fields are omitted, not null or empty', () => {
  const row = page({ Website: P.title('Bare'), URL: P.url('https://bare.example'), Category: P.select(null), Description: P.text('  ') });
  const [item] = buildDataset(dataset('gtk-websites'), [row], NO_TAGS, NOW).output.items;
  assert.deepEqual(Object.keys(item), ['id', 'name', 'url', 'tags']);
});

// ---- filtering ----
test('smartphone apps: only Verdict=Keep and not Discontinued are exported', () => {
  const pages = [
    app({ Name: P.title('Kept') }),
    app({ Name: P.title('Rejected'), Verdict: P.select('Reject') }),
    app({ Name: P.title('No verdict'), Verdict: P.select(null) }),
    app({ Name: P.title('Gone'), Discontinued: P.check(true) }),
  ];
  const { output, skipped, read } = buildDataset(dataset('smartphone-apps'), pages, NO_TAGS, NOW);
  assert.deepEqual(output.items.map((i) => i.name), ['Kept']);
  assert.deepEqual(skipped, { verdict_not_keep: 2, discontinued: 1 });
  assert.equal(read, 4);
});

test('rows without a name or a usable url are skipped with a reason', () => {
  const pages = [
    page({ Website: P.title(''), URL: P.url('https://a.example') }),
    page({ Website: P.title('No url'), URL: P.url(null) }),
    page({ Website: P.title('Bad url'), URL: P.url('javascript:alert(1)') }),
    page({ Website: P.title('Fine'), URL: P.url('https://fine.example') }),
  ];
  const { output, skipped } = buildDataset(dataset('gtk-websites'), pages, NO_TAGS, NOW);
  assert.equal(output.count, 1);
  assert.deepEqual(skipped, { missing_name: 1, missing_or_invalid_url: 2 });
});

// ---- URL sanitizing ----
test('sanitizeUrl: https only, http upgraded, junk dropped', () => {
  assert.equal(sanitizeUrl('https://ok.example/a?b=1'), 'https://ok.example/a?b=1');
  assert.equal(sanitizeUrl('http://up.example/x'), 'https://up.example/x');
  assert.equal(sanitizeUrl('  https://trim.example  '), 'https://trim.example/');
  for (const bad of ['javascript:alert(1)', 'data:text/html;base64,x', 'ftp://f.example', '//evil.example', '/relative', 'no-scheme.example',
    '', '   ', null, undefined, 42, 'https://user:pw@creds.example', 'https://localhost/x', 'https://']) {
    assert.equal(sanitizeUrl(bad), undefined, `should drop ${String(bad)}`);
  }
});

// ---- slugs ----
test('slugify normalizes names', () => {
  assert.equal(slugify('Café  & Co.!'), 'cafe-co');
  assert.equal(slugify('日本語'), 'item');
  assert.equal(slugify('A'.repeat(200)).length, 80);
});

test('slug collisions get numeric suffixes, independent of row order', () => {
  const rows = () => [
    page({ Website: P.title('Same Name'), URL: P.url('https://b.example') }),
    page({ Website: P.title('Same name'), URL: P.url('https://a.example') }),
    page({ Website: P.title('Same-Name!'), URL: P.url('https://c.example') }),
  ];
  const a = buildDataset(dataset('gtk-websites'), rows(), NO_TAGS, NOW).output.items;
  const b = buildDataset(dataset('gtk-websites'), rows().reverse(), NO_TAGS, NOW).output.items;
  assert.deepEqual(a.map((i) => i.id), ['same-name', 'same-name-2', 'same-name-3']);
  assert.deepEqual(a, b);
});

// ---- tag allowlist ----
test('an empty allowlist publishes no tags (the shipped config)', async () => {
  const shipped = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../config/public-tags.json', import.meta.url), 'utf8'));
  assert.deepEqual(shipped, { allow: [], aliases: {} });
  const { output, tagCounts } = buildDataset(dataset('smartphone-apps'), [app()], normalizeTagConfig(shipped), NOW);
  assert.deepEqual(output.items[0].tags, []);
  assert.equal(tagCounts.get('Finances'), 1, 'raw tags are still counted for the dry run');
});

test('allowlist and aliases publish only approved tags', () => {
  const cfg = normalizeTagConfig({ allow: ['Notes', 'Budgeting'], aliases: { Finances: 'Budgeting', finances: 'Budgeting' } });
  const [item] = buildDataset(dataset('smartphone-apps'), [app({ Tags: P.multi(['notes', 'Finances', 'Some Person', 'Budgeting']) })], cfg, NOW).output.items;
  assert.deepEqual(item.tags, ['Notes', 'Budgeting']);
});

test('a malformed tag config publishes nothing', () => {
  for (const bad of [undefined, null, 'x', [], { allow: 'Notes' }, { allow: [1, null] }]) {
    const [item] = buildDataset(dataset('smartphone-apps'), [app()], normalizeTagConfig(bad), NOW).output.items;
    assert.deepEqual(item.tags, []);
  }
});

// ---- output key allowlist ----
test('exported item keys never leave the allowlist', () => {
  const everything = [
    ...buildDataset(dataset('smartphone-apps'), [app()], NO_TAGS, NOW).output.items,
    ...buildDataset(dataset('gtk-websites'), [page({ Website: P.title('G'), URL: P.url('https://g.example'), Category: P.select('c'), Description: P.text('d'), ...FORBIDDEN })], NO_TAGS, NOW).output.items,
    ...buildDataset(dataset('ai-tools'), [page({ 'AI Tool': P.title('A'), URL: P.url('https://a.example'), ...FORBIDDEN })], NO_TAGS, NOW).output.items,
    ...buildDataset(dataset('open-source-alternatives'), [page({ Name: P.title('O'), 'Home Website': P.url('https://o.example'), ...FORBIDDEN })], NO_TAGS, NOW).output.items,
  ];
  for (const item of everything) for (const key of Object.keys(item)) assert.ok(ALLOWED_ITEM_KEYS.includes(key), `unexpected key ${key}`);
  assert.throws(() => assertAllowedKeys({ id: 'x', name: 'x', url: 'https://x.example', notionId: 'leak' }), /unexpected_export_key:notionId/);
});

// ---- fake Notion + R2 for the Notion client and runner ----
function fakeBucket(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store, puts: [],
    async get(key) { return store.has(key) ? { body: store.get(key), text: async () => store.get(key) } : null; },
    async put(key, value, opts) { this.puts.push({ key, opts }); store.set(key, value); },
  };
}
const ENV_VARS = { DB_SMARTPHONE_APPS: 'db-sp', DB_GTK_WEBSITES: 'db-gtk', DB_AI_TOOLS: 'db-ai', DB_OPEN_SOURCE_ALTERNATIVES: 'db-oss' };
const ROWS = {
  'ds-db-sp': () => [app()],
  'ds-db-gtk': () => [page({ Website: P.title('G'), URL: P.url('https://g.example') })],
  'ds-db-ai': () => [page({ 'AI Tool': P.title('A'), URL: P.url('https://a.example') })],
  'ds-db-oss': () => [page({ Name: P.title('O'), 'Home Website': P.url('https://o.example') })],
};
/** Routes Notion API calls. `overrides` lets a test change behaviour per path pattern. */
function fakeNotion({ rows = ROWS, overrides = [], calls = [] } = {}) {
  const fn = async (url, init = {}) => {
    const u = new URL(url);
    const path = u.pathname;
    calls.push({ method: init.method, path, search: u.search, body: init.body ? JSON.parse(init.body) : undefined, auth: init.headers?.Authorization, version: init.headers?.['Notion-Version'] });
    for (const o of overrides) { const r = o(path, init, u); if (r) return r; }
    let m;
    if ((m = path.match(/^\/v1\/databases\/(.+)$/))) return Response.json({ data_sources: [{ id: `ds-${m[1]}` }] });
    if ((m = path.match(/^\/v1\/data_sources\/([^/]+)\/query$/))) {
      const all = rows[m[1]]();
      const start = init.body && JSON.parse(init.body).start_cursor ? Number(JSON.parse(init.body).start_cursor) : 0;
      const slice = all.slice(start, start + 100);
      const more = start + 100 < all.length;
      return Response.json({ results: slice, has_more: more, next_cursor: more ? String(start + 100) : null });
    }
    if ((m = path.match(/^\/v1\/data_sources\/([^/]+)$/))) {
      const ds = DATASETS.find((d) => `ds-${ENV_VARS[d.envVar]}` === m[1]);
      return Response.json({ properties: Object.fromEntries(ds.fields && Object.values(ds.fields).concat(ds.filterProps || []).map((n) => [n, { id: `id-${n}`, type: 'x' }])) });
    }
    return new Response('{}', { status: 404 });
  };
  fn.calls = calls;
  return fn;
}
const sleepLog = [];
const sleep = async (ms) => { sleepLog.push(ms); };
const runCtx = (over = {}) => ({ tagConfig: NO_TAGS, sleep, minIntervalMs: 0, now: () => NOW, ...over });

// ---- Notion client ----
test('client paginates with page_size 100 and a cursor, sends version and auth, uses only GET/POST', async () => {
  const many = Array.from({ length: 250 }, (_, i) => page({ Website: P.title(`Site ${i}`), URL: P.url(`https://s${i}.example`) }));
  const fetchImpl = fakeNotion({ rows: { 'ds-db-gtk': () => many } });
  const client = createNotionClient({ token: 'test-token-not-real', fetchImpl, sleep, minIntervalMs: 0 });
  const { pages } = await fetchDatasetPages(client, 'db-gtk', dataset('gtk-websites'));
  assert.equal(pages.length, 250);
  const queries = fetchImpl.calls.filter((c) => c.path.endsWith('/query'));
  assert.deepEqual(queries.map((q) => q.body), [{ page_size: 100 }, { page_size: 100, start_cursor: '100' }, { page_size: 100, start_cursor: '200' }]);
  assert.ok(fetchImpl.calls.every((c) => c.auth === 'Bearer test-token-not-real' && c.version === '2025-09-03'));
  assert.ok(fetchImpl.calls.every((c) => ['GET', 'POST'].includes(c.method)));
  assert.ok(queries[0].search.includes('filter_properties=id-Website'), 'requests only allowlisted property ids');
  assert.ok(!queries[0].search.includes('Editor'), 'forbidden properties are never requested');
});

test('client backs off on 429 (Retry-After) and 5xx, then succeeds', async () => {
  let n = 0;
  const log = [];
  const fetchImpl = async () => {
    n++;
    if (n === 1) return new Response('{}', { status: 429, headers: { 'retry-after': '2' } });
    if (n === 2) return new Response('{}', { status: 503 });
    return Response.json({ ok: true });
  };
  const client = createNotionClient({ token: 't', fetchImpl, sleep: async (ms) => { log.push(ms); }, minIntervalMs: 0 });
  assert.deepEqual(await client.request('GET', '/v1/x'), { ok: true });
  assert.equal(n, 3);
  assert.deepEqual(log.filter((ms) => ms > 0), [2000, 1000]);
});

test('client gives up after max retries with a safe error, and does not retry 4xx', async () => {
  let n = 0;
  const always500 = createNotionClient({ token: 't', fetchImpl: async () => { n++; return new Response('{}', { status: 500 }); }, sleep, minIntervalMs: 0, maxRetries: 2 });
  await assert.rejects(always500.request('GET', '/v1/x'), { message: 'notion_500_unknown' });
  assert.equal(n, 3);
  n = 0;
  const forbidden = createNotionClient({ token: 't', fetchImpl: async () => { n++; return Response.json({ code: 'restricted_resource', message: 'secret text' }, { status: 403 }); }, sleep, minIntervalMs: 0 });
  await assert.rejects(forbidden.request('GET', '/v1/x'), (e) => e.message === 'notion_403_restricted_resource' && !e.message.includes('secret'));
  assert.equal(n, 1);
});

test('client paces requests by minIntervalMs', async () => {
  const log = [];
  const client = createNotionClient({ token: 't', fetchImpl: async () => Response.json({}), sleep: async (ms) => { log.push(ms); }, minIntervalMs: 350 });
  await client.request('GET', '/a'); await client.request('GET', '/b'); await client.request('GET', '/c');
  assert.deepEqual(log, [350, 350]);
});

test('a configured data source id is accepted; a database with several data sources is an error', async () => {
  const asDs = fakeNotion({ overrides: [(path) => path === '/v1/databases/db-gtk' ? Response.json({ code: 'object_not_found' }, { status: 404 }) : null,
    (path) => path === '/v1/data_sources/db-gtk' ? Response.json({ properties: { Website: { id: 'a' }, URL: { id: 'b' } } }) : null,
    (path) => path === '/v1/data_sources/db-gtk/query' ? Response.json({ results: [], has_more: false }) : null] });
  const client = createNotionClient({ token: 't', fetchImpl: asDs, sleep, minIntervalMs: 0 });
  const { pages, warnings } = await fetchDatasetPages(client, 'db-gtk', dataset('gtk-websites'));
  assert.deepEqual(pages, []);
  assert.deepEqual(warnings.sort(), ['missing_property:Category', 'missing_property:Description', 'missing_property:Tags']);

  const multi = fakeNotion({ overrides: [(path) => path === '/v1/databases/db-gtk' ? Response.json({ data_sources: [{ id: 'a' }, { id: 'b' }] }) : null] });
  const c2 = createNotionClient({ token: 't', fetchImpl: multi, sleep, minIntervalMs: 0 });
  await assert.rejects(fetchDatasetPages(c2, 'db-gtk', dataset('gtk-websites')), /multiple_data_sources/);
});

test('a schema without the name or url property fails that database', async () => {
  const f = fakeNotion({ overrides: [(path) => path === '/v1/data_sources/ds-db-gtk' ? Response.json({ properties: { URL: { id: 'b' } } }) : null] });
  const client = createNotionClient({ token: 't', fetchImpl: f, sleep, minIntervalMs: 0 });
  await assert.rejects(fetchDatasetPages(client, 'db-gtk', dataset('gtk-websites')), { message: 'schema_missing_property:Website' });
});

// ---- export runner ----
const exportEnv = (bucket, extra = {}) => ({ NOTION_TOKEN: 'test-token-not-real', DATA_BUCKET: bucket, ...ENV_VARS, ...extra });

test('export writes all four files with the contract shape and contentType', async () => {
  const bucket = fakeBucket();
  const { ok, results } = await runExport({ env: exportEnv(bucket), fetchImpl: fakeNotion(), ...runCtx() });
  assert.equal(ok, true);
  assert.deepEqual(Object.keys(results), ['smartphone-apps', 'gtk-websites', 'ai-tools', 'open-source-alternatives']);
  assert.deepEqual([...bucket.store.keys()].sort(), ['ai-tools.json', 'gtk-websites.json', 'open-source-alternatives.json', 'smartphone-apps.json']);
  const file = JSON.parse(bucket.store.get('gtk-websites.json'));
  assert.deepEqual(Object.keys(file), ['updated', 'count', 'items']);
  assert.equal(file.updated, '2026-11-21T12:00:00.000Z');
  assert.ok(bucket.puts.every((p) => p.opts.httpMetadata.contentType === 'application/json'));
});

test('50% guard keeps the old file when the new count collapses', async () => {
  const old = JSON.stringify({ updated: 'old', count: 40, items: [] });
  const bucket = fakeBucket({ 'gtk-websites.json': old });
  const { ok, results } = await runExport({ env: exportEnv(bucket), fetchImpl: fakeNotion(), ...runCtx() }); // new count = 1
  assert.equal(ok, false);
  assert.equal(results['gtk-websites'].status, 'kept_old');
  assert.match(results['gtk-websites'].error, /^guard_new_count_1_below_50_percent_of_40$/);
  assert.equal(bucket.store.get('gtk-websites.json'), old, 'old file untouched');
  assert.equal(results['ai-tools'].status, 'written', 'other databases are not affected');
});

test('guard arithmetic: applies only above 10 rows and below 50%', () => {
  assert.equal(belowGuard(40, 19), true);
  assert.equal(belowGuard(40, 20), false);
  assert.equal(belowGuard(11, 5), true);
  assert.equal(belowGuard(10, 0), false);
  assert.equal(belowGuard(0, 0), false);
});

test('a failed Notion call keeps the old file and is reported without leaking details', async () => {
  const old = JSON.stringify({ updated: 'old', count: 3, items: [] });
  const bucket = fakeBucket({ 'ai-tools.json': old });
  const f = fakeNotion({ overrides: [(path) => path.startsWith('/v1/databases/db-ai') ? Response.json({ code: 'object_not_found', message: 'Could not find database with ID: db-ai' }, { status: 404 }) : null,
    (path) => path === '/v1/data_sources/db-ai' ? Response.json({ code: 'object_not_found' }, { status: 404 }) : null] });
  const { ok, results } = await runExport({ env: exportEnv(bucket), fetchImpl: f, ...runCtx() });
  assert.equal(ok, false);
  assert.deepEqual(results['ai-tools'], { status: 'error', error: 'notion_404_object_not_found' });
  assert.equal(bucket.store.get('ai-tools.json'), old);
  assert.deepEqual(['smartphone-apps', 'gtk-websites', 'open-source-alternatives'].map((n) => results[n].status), ['written', 'written', 'written']);
  assert.ok(!JSON.stringify(results).includes('db-ai'));
});

test('a missing DB variable fails only that database; a missing token or bucket fails all', async () => {
  const bucket = fakeBucket();
  const env = exportEnv(bucket); delete env.DB_AI_TOOLS;
  const { results } = await runExport({ env, fetchImpl: fakeNotion(), ...runCtx() });
  assert.deepEqual(results['ai-tools'], { status: 'error', error: 'missing_config:DB_AI_TOOLS' });
  assert.equal(results['gtk-websites'].status, 'written');
  const none = await runExport({ env: { DATA_BUCKET: bucket, ...ENV_VARS }, fetchImpl: fakeNotion(), ...runCtx() });
  assert.ok(Object.values(none.results).every((r) => r.error === 'missing_config:NOTION_TOKEN'));
});

test('an unexpected exception is reported generically, never with its message', async () => {
  const f = async () => { throw new Error('contains secret-ish text'); };
  const { results } = await runExport({ env: exportEnv(fakeBucket()), fetchImpl: f, ...runCtx({ sleep }) });
  assert.ok(Object.values(results).every((r) => r.error === 'notion_0_network_error'));
  const badBucket = { get: async () => { throw new Error('r2 exploded: secret-ish'); }, put: async () => {} };
  const r2 = await runExport({ env: exportEnv(badBucket), fetchImpl: fakeNotion(), ...runCtx() });
  assert.ok(Object.values(r2.results).every((r) => r.error === 'unexpected_error'));
});

// ---- routes ----
const handler = (over = {}) => createHandler({ rawTagConfig: { allow: [], aliases: {} }, fetchImpl: fakeNotion(), sleep, minIntervalMs: 0, ...over });
const req = (path, init) => new Request(`https://www.techfusionreport.com${path}`, init);

test('GET /data/{name}.json serves R2 with the required headers', async () => {
  const bucket = fakeBucket({ 'ai-tools.json': '{"updated":"x","count":0,"items":[]}' });
  for (const name of ['smartphone-apps', 'gtk-websites', 'ai-tools', 'open-source-alternatives']) {
    const b = fakeBucket({ [`${name}.json`]: '{"count":0}' });
    const res = await handler()(req(`/data/${name}.json`), { DATA_BUCKET: b });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Content-Type'), 'application/json');
    assert.equal(res.headers.get('Cache-Control'), 'public, max-age=300');
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
    assert.equal(await res.text(), '{"count":0}');
  }
  const head = await handler()(req('/data/ai-tools.json', { method: 'HEAD' }), { DATA_BUCKET: bucket });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});

test('unknown names and paths are 404 JSON; a missing export is a 404 JSON', async () => {
  const env = { DATA_BUCKET: fakeBucket({ 'secret.json': 'nope', 'ai-tools.json': '{}' }) };
  for (const path of ['/data/secret.json', '/data/ai-tools', '/data/ai-tools.json/', '/data/../ai-tools.json', '/data/AI-TOOLS.json', '/data/', '/data', '/other', '/', '/data/a/ai-tools.json']) {
    const res = await handler()(req(path), env);
    assert.equal(res.status, 404, path);
    assert.equal(res.headers.get('Content-Type'), 'application/json');
    assert.equal((await res.json()).error, 'not_found');
  }
  const missing = await handler()(req('/data/gtk-websites.json'), env);
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('Content-Type'), 'application/json');
  assert.equal((await missing.json()).error, 'not_found');
});

test('OPTIONS is answered with CORS; other methods on files are 405', async () => {
  const env = { DATA_BUCKET: fakeBucket() };
  const opt = await handler()(req('/data/ai-tools.json', { method: 'OPTIONS' }), env);
  assert.equal(opt.status, 204);
  assert.equal(opt.headers.get('Access-Control-Allow-Origin'), '*');
  for (const method of ['POST', 'PUT', 'DELETE']) assert.equal((await handler()(req('/data/ai-tools.json', { method }), env)).status, 405);
});

test('safeEqual compares correctly across lengths and types', async () => {
  assert.equal(await safeEqual('abc', 'abc'), true);
  assert.equal(await safeEqual('abc', 'abd'), false);
  assert.equal(await safeEqual('abc', 'abcd'), false);
  assert.equal(await safeEqual('', ''), true);
  assert.equal(await safeEqual(null, 'abc'), false);
  assert.equal(await safeEqual('abc', undefined), false);
});

test('POST /data/_export requires the exact X-Export-Key', async () => {
  const bucket = fakeBucket();
  const env = { ...exportEnv(bucket), EXPORT_KEY: 'test-export-key-not-real' };
  const post = (headers) => handler()(req('/data/_export', { method: 'POST', headers }), env);
  for (const headers of [{}, { 'X-Export-Key': '' }, { 'X-Export-Key': 'wrong' }, { 'x-export-key': 'TEST-EXPORT-KEY-NOT-REAL' }]) {
    const res = await post(headers);
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error, 'unauthorized');
  }
  assert.equal(bucket.store.size, 0, 'nothing is written without a valid key');
  const ok = await post({ 'X-Export-Key': 'test-export-key-not-real' });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.ok, true);
  assert.equal(body.results['gtk-websites'].count, 1);
  assert.equal(bucket.store.size, 4);
});

test('with EXPORT_KEY unset the export endpoint is closed, even for an empty header', async () => {
  const env = exportEnv(fakeBucket());
  for (const headers of [{}, { 'X-Export-Key': '' }, { 'X-Export-Key': 'undefined' }]) {
    assert.equal((await handler()(req('/data/_export', { method: 'POST', headers }), env)).status, 401);
  }
});

test('GET /data/_export is 405 and never runs the export', async () => {
  const bucket = fakeBucket();
  const res = await handler()(req('/data/_export'), { ...exportEnv(bucket), EXPORT_KEY: 'k' });
  assert.equal(res.status, 405);
  assert.equal(res.headers.get('Allow'), 'POST');
  assert.equal(bucket.store.size, 0);
});

test('the worker entry loads the shipped (empty) tag config and exposes fetch', async () => {
  assert.equal(typeof worker.fetch, 'function');
  const res = await worker.fetch(req('/data/nope.json'), { DATA_BUCKET: fakeBucket() });
  assert.equal(res.status, 404);
});

test('the summary and logs never contain row text, tokens or ids', async () => {
  const logs = [];
  const orig = console.log; console.log = (...a) => logs.push(a.join(' '));
  try {
    const env = { ...exportEnv(fakeBucket()), EXPORT_KEY: 'test-export-key-not-real' };
    const res = await handler()(req('/data/_export', { method: 'POST', headers: { 'X-Export-Key': 'test-export-key-not-real' } }), env);
    const text = JSON.stringify(await res.json()) + logs.join('\n');
    for (const leak of ['Good App', 'good.example', 'test-token-not-real', 'test-export-key-not-real', 'page-id-must-not-leak', 'db-sp']) assert.ok(!text.includes(leak), `leaked ${leak}`);
  } finally { console.log = orig; }
});
