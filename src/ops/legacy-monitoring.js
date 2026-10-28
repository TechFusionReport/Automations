// Oracle pushes monitoring snapshots; /ops reads the last stored report.
// The ingest route must ALSO have a dedicated Cloudflare Access Service Auth app.
const KEY = 'ops:monitoring:snapshot:v1';
const STALE_MS = 15 * 60_000;
const unavailable = (reason) => ({ status: 'unavailable', reason, generatedAt: null, ageSeconds: null, nodes: [], wireguard: null, n8n: null, lan_watchtower: null });
const validDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const arr = value => Array.isArray(value) ? value : [];
// Explicit allowlist: do not persist internal/public IPs, WireGuard keys,
// allowed_ips, webhook addresses, or other unreviewed collector fields.
export function sanitizeSnapshot(raw) {
  if (!raw || !validDate(raw.generated_at)) throw new Error('Invalid snapshot timestamp');
  if (!Array.isArray(raw.nodes) || !raw.wireguard || !raw.n8n || !raw.lan_watchtower)
    throw new Error('Required monitoring sections missing');
  return {
    generatedAt: raw.generated_at,
    nodes: raw.nodes.slice(0, 100).map(n => ({
      id: String(n.id || '').slice(0, 100), label: String(n.label || '').slice(0, 120),
      role: String(n.role || '').slice(0, 80), reachable: n.reachable === true,
      services: arr(n.services).slice(0, 100).map(s => ({
        name: String(s.name || '').slice(0, 120), status: String(s.status || '').slice(0, 50),
        latency_ms: Number.isFinite(s.latency_ms) ? s.latency_ms : null,
      })),
    })),
    wireguard: {
      hub: String(raw.wireguard.hub || '').slice(0, 120),
      peers: arr(raw.wireguard.peers).slice(0, 100).map(p => ({
        node_id: String(p.node_id || '').slice(0, 100),
        latest_handshake: String(p.latest_handshake || '').slice(0, 100),
        connected: p.connected === true,
        transfer_rx_bytes: Number.isFinite(p.transfer_rx_bytes) ? p.transfer_rx_bytes : null,
        transfer_tx_bytes: Number.isFinite(p.transfer_tx_bytes) ? p.transfer_tx_bytes : null,
      })),
    },
    n8n: {
      // Deliberately omit host address and workflow IDs.
      reachable: raw.n8n.reachable === true,
      workflows: arr(raw.n8n.workflows).slice(0, 200).map(w => ({
        name: String(w.name || '').slice(0, 150), active: w.active === true,
      })),
    },
    lan_watchtower: {
      healthy: raw.lan_watchtower.healthy === true,
      incident_open: raw.lan_watchtower.incident_open === true,
      failure_count: Number.isFinite(raw.lan_watchtower.failure_count) ? raw.lan_watchtower.failure_count : null,
      probe_online: raw.lan_watchtower.probe_online === true,
      last_seen: raw.lan_watchtower.last_seen || null,
      wifi_signal_dbm: Number.isFinite(raw.lan_watchtower.wifi_signal_dbm) ? raw.lan_watchtower.wifi_signal_dbm : null,
      checks: arr(raw.lan_watchtower.checks).slice(0, 100).map(c => ({
        name: String(c.name || '').slice(0, 120), ok: c.ok === true, required: c.required === true,
        latency_avg_ms: Number.isFinite(c.latency_avg_ms) ? c.latency_avg_ms : null,
        packet_loss_pct: Number.isFinite(c.packet_loss_pct) ? c.packet_loss_pct : null,
      })),
    },
  };
}
export async function ingestMonitoring(request, env, secrets = {}, deps = {}) {
  const expected = secrets.monitoring_ingest_secret || env.MONITORING_INGEST_SECRET;
  const supplied = request.headers.get('Authorization') || '';
  if (!expected || supplied !== `Bearer ${expected}`) return { code: 401, body: { error: 'Unauthorized' } };
  if (!env.CONTENT_KV) return { code: 503, body: { error: 'Storage unavailable' } };
  const rawText = await request.text();
  if (rawText.length > 150_000) return { code: 413, body: { error: 'Snapshot too large' } };
  let snapshot;
  try { snapshot = sanitizeSnapshot(JSON.parse(rawText)); }
  catch { return { code: 400, body: { error: 'Invalid snapshot' } }; }
  const now = (deps.now || Date.now)();
  const ts = Date.parse(snapshot.generatedAt);
  if (ts > now + 60_000 || ts < now - 10 * 60_000)
    return { code: 400, body: { error: 'Snapshot timestamp out of range' } };
  const previousRaw = await env.CONTENT_KV.get(KEY);
  if (previousRaw) {
    const previous = JSON.parse(previousRaw);
    if (Date.parse(previous.generatedAt) >= ts) return { code: 409, body: { error: 'Duplicate or older snapshot' } };
  }
  await env.CONTENT_KV.put(KEY, JSON.stringify(snapshot));
  return { code: 202, body: { accepted: true, generatedAt: snapshot.generatedAt } };
}
export async function buildLegacyMonitoring(env, secrets = {}, deps = {}) {
  if (!env.CONTENT_KV) return unavailable('Storage unavailable');
  let snapshot;
  try { snapshot = JSON.parse(await env.CONTENT_KV.get(KEY) || 'null'); }
  catch { return unavailable('Stored snapshot invalid'); }
  if (!snapshot || !validDate(snapshot.generatedAt)) return unavailable('No monitoring snapshot received');
  const ageSeconds = Math.max(0, Math.floor(((deps.now || Date.now)() - Date.parse(snapshot.generatedAt)) / 1000));
  return { ...snapshot, status: ageSeconds * 1000 > STALE_MS ? 'stale' : 'ok', ageSeconds };
}
