// Read-only TechFusion OS Command Center aggregation.
// Each source remains authoritative; this module normalizes live state for /ops.
const TASK_DATABASE_ID = '9a75e952-ff61-40c7-86a1-e364ce60eea6';
const GITHUB_ORG = 'TechFusionReport';
const PRIORITY_ORDER = new Map([
  ['🔴 Critical', 0], ['🟠 High', 1], ['🟡 Medium', 2], ['⚪ Low', 3],
]);

const text = (parts = []) => parts.map((v) => v.plain_text ?? v.text?.content ?? '').join('').trim();
const select = (property) => property?.select?.name ?? property?.status?.name ?? null;

async function responseJson(response, label) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${label} returned ${response.status}`);
  return body;
}

async function readTasks(fetchFn, token, databaseId = TASK_DATABASE_ID) {
  if (!token) return { status: 'unavailable', reason: 'notion credential missing', items: [] };
  const body = {
    page_size: 50,
    filter: { and: [
      { property: 'Scope', select: { equals: 'Professional' } },
      { property: 'Status', select: { does_not_equal: 'Done' } },
      { property: 'Status', select: { does_not_equal: 'Abandoned' } },
    ] },
  };
  const response = await fetchFn(`https://api.notion.com/v1/databases/${databaseId}/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = await responseJson(response, 'Task Tracker');
  const items = (data.results || []).map((page) => ({
    id: page.id,
    title: text(page.properties?.Task?.title),
    status: select(page.properties?.Status),
    priority: select(page.properties?.Priority),
    area: select(page.properties?.Area),
    url: page.url || `https://www.notion.so/${page.id.replace(/-/g, '')}`,
  })).sort((a, b) =>
    (PRIORITY_ORDER.get(a.priority) ?? 99) - (PRIORITY_ORDER.get(b.priority) ?? 99)
    || a.title.localeCompare(b.title)
  );
  return {
    status: 'ok',
    counts: {
      critical: items.filter((item) => item.priority === '🔴 Critical').length,
      inProgress: items.filter((item) => item.status === 'In Progress').length,
      blocked: items.filter((item) => item.status === 'Blocked').length,
      open: items.length,
    },
    items: items.slice(0, 12),
    authoritativeUrl: `https://www.notion.so/${databaseId.replace(/-/g, '')}`,
  };
}

async function readPullRequests(fetchFn, token, org = GITHUB_ORG) {
  const query = encodeURIComponent(`org:${org} is:pr is:open`);
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'techfusion-os' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetchFn(`https://api.github.com/search/issues?q=${query}&sort=updated&order=desc&per_page=20`, { headers });
  const data = await responseJson(response, 'GitHub');
  return {
    status: 'ok',
    count: data.total_count || 0,
    items: (data.items || []).map((item) => ({
      number: item.number,
      title: item.title,
      repository: item.repository_url?.split('/').slice(-1)[0] || null,
      draft: item.draft === true,
      updatedAt: item.updated_at,
      url: item.html_url,
    })),
    authoritativeUrl: `https://github.com/pulls?q=is%3Aopen+is%3Apr+org%3A${org}`,
  };
}

async function readCloudflare(fetchFn, token, accountId) {
  if (!token || !accountId) {
    return { status: 'unavailable', reason: 'cloudflare runtime credential or account id missing' };
  }
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}`;
  const [workers, access, tunnels] = await Promise.all([
    fetchFn(`${base}/workers/scripts`, { headers }).then((r) => responseJson(r, 'Cloudflare workers')),
    fetchFn(`${base}/access/apps?per_page=100`, { headers }).then((r) => responseJson(r, 'Cloudflare Access')),
    fetchFn(`${base}/cfd_tunnel?is_deleted=false&per_page=100`, { headers }).then((r) => responseJson(r, 'Cloudflare tunnels')),
  ]);
  const tunnelItems = (tunnels.result || []).map((item) => ({
    name: item.name,
    status: item.status || 'unknown',
    connections: Array.isArray(item.connections) ? item.connections.length : 0,
  }));
  return {
    status: 'ok',
    workers: (workers.result || []).map((item) => ({ name: item.id, modifiedAt: item.modified_on })),
    accessApplications: (access.result || []).map((item) => ({ name: item.name, domain: item.domain })),
    tunnels: tunnelItems,
    summary: {
      workers: (workers.result || []).length,
      accessApplications: (access.result || []).length,
      healthyTunnels: tunnelItems.filter((item) => item.status === 'healthy').length,
      downTunnels: tunnelItems.filter((item) => item.status === 'down').length,
    },
  };
}

async function probe(fetchFn, name, url) {
  const started = Date.now();
  try {
    const response = await fetchFn(url, { method: 'GET', signal: AbortSignal.timeout(5000) });
    return { name, url, status: response.ok ? 'ok' : 'degraded', httpStatus: response.status, latencyMs: Date.now() - started };
  } catch (error) {
    return { name, url, status: 'down', httpStatus: null, latencyMs: Date.now() - started, error: error.message };
  }
}

const settled = async (fn, fallback) => {
  try { return await fn(); }
  catch (error) { return { ...fallback, reason: error.message }; }
};

export async function buildCommandCenter(env, secrets = {}, deps = {}) {
  const fetchFn = deps.fetch || fetch;
  const generatedAt = new Date((deps.now || Date.now)()).toISOString();
  const notionToken = secrets.notion_token || env.NOTION_TOKEN;
  const githubToken = secrets.github_pat || secrets.GITHUB_PAT || env.GITHUB_PAT;
  const cloudflareToken = secrets.cloudflare_api_token || env.CLOUDFLARE_API_TOKEN;
  const cloudflareAccountId = secrets.cloudflare_account_id || env.CLOUDFLARE_ACCOUNT_ID;

  const [tasks, pullRequests, cloudflare, services] = await Promise.all([
    settled(() => readTasks(fetchFn, notionToken, secrets.notion_task_database_id), { status: 'error', items: [] }),
    settled(() => readPullRequests(fetchFn, githubToken), { status: 'error', items: [] }),
    settled(() => readCloudflare(fetchFn, cloudflareToken, cloudflareAccountId), { status: 'error' }),
    Promise.all([
      probe(fetchFn, 'TechFusion API', 'https://techfusion-api.quiet-shadow-2fce.workers.dev/health'),
      probe(fetchFn, 'Website', 'https://techfusionreport.com/'),
      probe(fetchFn, 'OmniRoute', 'https://omniroute.techfusionreport.com/v1/models'),
    ]),
  ]);

  const attention = [
    ...(tasks.items || []).filter((item) => item.priority === '🔴 Critical' || item.status === 'Blocked')
      .map((item) => ({ source: 'notion', type: 'task', title: item.title, url: item.url })),
    ...(pullRequests.items || []).filter((item) => item.draft)
      .map((item) => ({ source: 'github', type: 'draft-pr', title: `${item.repository} #${item.number}: ${item.title}`, url: item.url })),
    ...services.filter((item) => item.status !== 'ok')
      .map((item) => ({ source: 'system', type: 'health', title: `${item.name} is ${item.status}`, url: item.url })),
  ];

  return { generatedAt, tasks, pullRequests, cloudflare, services, attention };
}
