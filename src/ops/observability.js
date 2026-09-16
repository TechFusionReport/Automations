const DEFAULT_TIMEOUT_MS = 5000;

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function point(row) {
  return {
    labels: {
      job: row?.metric?.job || null,
      instance: row?.metric?.instance || null,
      service: row?.metric?.service || null,
      environment: row?.metric?.environment || null,
    },
    value: finite(row?.value?.[1]),
    timestamp: finite(row?.value?.[0]),
  };
}

function accessHeaders(secrets = {}) {
  const clientId = secrets.prometheus_access_client_id;
  const clientSecret = secrets.prometheus_access_client_secret;
  return clientId && clientSecret
    ? { 'CF-Access-Client-Id': clientId, 'CF-Access-Client-Secret': clientSecret }
    : {};
}

async function readJson(url, headers, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { headers: { Accept: 'application/json', ...headers }, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function query(baseUrl, expression, headers, fetchImpl, timeoutMs) {
  const url = new URL('/api/v1/query', baseUrl);
  url.searchParams.set('query', expression);
  const body = await readJson(url, headers, fetchImpl, timeoutMs);
  if (body?.status !== 'success') throw new Error(body?.error || 'Prometheus query failed');
  return (body?.data?.result || []).map(point);
}

function overallStatus(targets, alerts) {
  if (!targets.total) return 'unavailable';
  if (targets.down > 0 || alerts.firing > 0) return 'degraded';
  return 'healthy';
}

export async function buildObservability(env, secrets = {}, deps = {}) {
  const now = deps.now || Date.now;
  const fetchImpl = deps.fetch || fetch;
  const timeoutMs = Number(env.PROMETHEUS_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const baseUrl = env.PROMETHEUS_BASE_URL;
  const grafanaUrl = env.GRAFANA_BASE_URL || 'https://grafana.techfusionreport.com';

  const unavailable = (reason) => ({
    generatedAt: new Date(now()).toISOString(),
    status: 'unavailable',
    reason,
    grafana: { status: 'unknown', url: grafanaUrl },
    prometheus: { status: 'unavailable' },
    targets: { total: 0, healthy: 0, down: 0, items: [] },
    alerts: { firing: 0, items: [] },
    metrics: { cpu: [], memory: [], disk: [] },
  });

  if (!baseUrl) return unavailable('Prometheus is not configured');

  const headers = accessHeaders(secrets);
  try {
    const targetsUrl = new URL('/api/v1/targets', baseUrl);
    targetsUrl.searchParams.set('state', 'active');
    const [targetBody, alertRows, cpu, memory, disk] = await Promise.all([
      readJson(targetsUrl, headers, fetchImpl, timeoutMs),
      query(baseUrl, 'ALERTS{alertstate="firing"}', headers, fetchImpl, timeoutMs),
      query(baseUrl, '100 * (1 - avg by (instance,job) (rate(node_cpu_seconds_total{mode="idle"}[5m])))', headers, fetchImpl, timeoutMs),
      query(baseUrl, '100 * (1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)', headers, fetchImpl, timeoutMs),
      query(baseUrl, '100 * (1 - node_filesystem_avail_bytes{fstype!~"tmpfs|overlay"} / node_filesystem_size_bytes{fstype!~"tmpfs|overlay"})', headers, fetchImpl, timeoutMs),
    ]);

    if (targetBody?.status !== 'success') throw new Error(targetBody?.error || 'Prometheus targets failed');
    const items = (targetBody?.data?.activeTargets || []).map((target) => ({
      job: target?.labels?.job || target?.scrapePool || 'unknown',
      instance: target?.labels?.instance || null,
      health: target?.health === 'up' ? 'up' : 'down',
      lastScrape: target?.lastScrape || null,
      lastError: target?.lastError || null,
    }));
    const targets = {
      total: items.length,
      healthy: items.filter((item) => item.health === 'up').length,
      down: items.filter((item) => item.health !== 'up').length,
      items,
    };
    const alertItems = alertRows.map((row) => ({
      name: row.labels.service || row.labels.job || 'Prometheus alert',
      instance: row.labels.instance,
      value: row.value,
    }));
    const alerts = { firing: alertItems.length, items: alertItems };

    return {
      generatedAt: new Date(now()).toISOString(),
      status: overallStatus(targets, alerts),
      grafana: { status: 'available', url: grafanaUrl },
      prometheus: { status: 'available', url: baseUrl },
      targets,
      alerts,
      metrics: { cpu, memory, disk },
    };
  } catch (error) {
    return unavailable(error?.name === 'AbortError' ? 'Prometheus request timed out' : error.message);
  }
}

export function publicObservability(detail) {
  const generatedAt = detail?.generatedAt || null;
  const ageMs = generatedAt ? Math.max(0, Date.now() - Date.parse(generatedAt)) : null;
  const stale = ageMs == null || ageMs > 180000;
  const status = stale ? 'unavailable' : detail.status;
  return {
    generatedAt,
    status,
    stale,
    targets: {
      total: detail?.targets?.total || 0,
      healthy: detail?.targets?.healthy || 0,
      down: detail?.targets?.down || 0,
    },
    alerts: { firing: detail?.alerts?.firing || 0 },
  };
}
