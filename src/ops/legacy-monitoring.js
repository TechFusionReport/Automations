// Read the last stored monitoring snapshot for /ops.
const KEY = 'ops:monitoring:snapshot:v1';
const STALE_MS = 15 * 60_000;
const unavailable = (reason) => ({ status: 'unavailable', reason, generatedAt: null, ageSeconds: null, nodes: [], wireguard: null, n8n: null, lan_watchtower: null });
const validDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
export async function buildLegacyMonitoring(env, secrets = {}, deps = {}) {
  if (!env.CONTENT_KV) return unavailable('Storage unavailable');
  let snapshot;
  try { snapshot = JSON.parse(await env.CONTENT_KV.get(KEY) || 'null'); }
  catch { return unavailable('Stored snapshot invalid'); }
  if (!snapshot || !validDate(snapshot.generatedAt)) return unavailable('No monitoring snapshot received');
  const ageSeconds = Math.max(0, Math.floor(((deps.now || Date.now)() - Date.parse(snapshot.generatedAt)) / 1000));
  return { ...snapshot, status: ageSeconds * 1000 > STALE_MS ? 'stale' : 'ok', ageSeconds };
}
