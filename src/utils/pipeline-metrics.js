// Rolling 24h execution metrics for poll-based pipeline stages.
// Stored as a bounded array per stage in KV; pruned to the trailing 24h
// window on every write and read (defensive against clock skew).

const METRICS_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 200; // hard cap so a runaway loop can't bloat the KV value

function pruneToWindow(entries = []) {
  const cutoff = Date.now() - METRICS_WINDOW_MS;
  return entries.filter((e) => new Date(e.timestamp).getTime() >= cutoff);
}

// Appends one run's outcome to the stage's rolling metrics key.
// errorCount = item-level error count from that run (e.g. results.errors.length),
// not a pass/fail boolean.
export async function recordStageRun(env, stageKey, { processed = 0, approved = 0, found = null, errorCount = 0 }) {
  const kvKey = `metrics:${stageKey}`;
  const raw = await env.CONTENT_KV.get(kvKey);
  const pruned = pruneToWindow(raw ? JSON.parse(raw) : []);
  pruned.push({ timestamp: new Date().toISOString(), processed, approved, found, errorCount });
  const bounded = pruned.slice(-MAX_ENTRIES);
  // 48h TTL as a safety net, independent of the 24h logical window above
  await env.CONTENT_KV.put(kvKey, JSON.stringify(bounded), { expirationTtl: 48 * 60 * 60 });
}

// Derives Req/24h, error rate, and freshness from a stage's rolling entries.
// maxIntervalMs = longest gap allowed between runs before flagging "down"
// (cron interval + buffer) — catches a silently-stopped poller, not just errors.
export async function getStageMetrics(env, stageKey, maxIntervalMs) {
  const raw = await env.CONTENT_KV.get(`metrics:${stageKey}`);
  const entries = pruneToWindow(raw ? JSON.parse(raw) : []);
  const reqs24h = entries.length;
  const erroredRuns = entries.filter((e) => e.errorCount > 0).length;
  const errorRatePct = reqs24h ? Number(((erroredRuns / reqs24h) * 100).toFixed(1)) : 0;
  const lastRun = entries.length ? entries[entries.length - 1].timestamp : null;
  const msSinceLastRun = lastRun ? Date.now() - new Date(lastRun).getTime() : Infinity;
  const healthy = msSinceLastRun <= maxIntervalMs && errorRatePct < 20;
  return { reqs24h, errorRatePct, lastRun, healthy };
}
