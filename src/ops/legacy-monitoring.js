// Read-only, Access-gated bridge for the Oracle status collector.
// Configure STATUS_COLLECTOR_URL to a PRIVATE authenticated JSON endpoint,
// independent of status.techfusionreport.com, before retiring that hostname.
export async function buildLegacyMonitoring(env, secrets = {}, deps = {}) {
  const now = deps.now || Date.now;
  const url = env.STATUS_COLLECTOR_URL;
  const unavailable = (reason) => ({ status: 'unavailable', reason, generatedAt: null, nodes: [], wireguard: null, n8n: null, lan_watchtower: null });
  if (!url) return unavailable('Private collector endpoint not configured');
  let parsed;
  try {
    parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith('.techfusionreport.com'))
      return unavailable('Collector URL must be HTTPS on a TechFusion subdomain');
  } catch { return unavailable('Invalid collector URL'); }
  const token = secrets.status_collector_token || env.STATUS_COLLECTOR_TOKEN;
  if (!token) return unavailable('Collector authentication not configured');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await (deps.fetch || fetch)(parsed.href, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: controller.signal,
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`Collector HTTP ${response.status}`);
    const body = await response.json();
    const generatedAt = body?.generated_at || null;
    const age = Date.parse(generatedAt);
    if (!Number.isFinite(age) || now() - age > 15 * 60_000 || age - now() > 60_000)
      return { ...unavailable('Collector data is stale or has an invalid timestamp'), generatedAt };
    return {
      status: 'ok', generatedAt,
      nodes: Array.isArray(body.nodes) ? body.nodes : [],
      wireguard: body.wireguard || null,
      n8n: body.n8n || null,
      lan_watchtower: body.lan_watchtower || null,
    };
  } catch { return unavailable('Private collector unavailable'); }
  finally { clearTimeout(timer); }
}
