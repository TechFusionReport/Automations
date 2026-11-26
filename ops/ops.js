import { renderMonitoring } from './monitoring.js';
// TechFusion Ops Center — dashboard client.
// Loaded as <script type="module">. Talks to the Access-gated Worker API at
// /ops/api/* (same origin, so the Cloudflare Access cookie rides along).
// Pure helpers are exported so they can be unit-tested under Node.

// ── canonical status strings (must match Content Catalog v2 exactly) ─────────
export const STATUS = {
  notStarted: 'Not started',
  pendingReview: '🟡 Pending Review',
  transcriptionApproved: '📄 Transcription Approved',
  inProgress: 'In progress',
  draftGenerated: 'Draft Generated',
  draftReview: '📝 Draft Review',
  draftApproval: '✅ Draft Approval',
  publishApproved: '🚀 Publish Approved',
  publishedToGithub: '✅Published To Github',
  errors: '❌ Errors',
  rejected: '❌ Rejected',
};

// Ordered non-terminal pipeline stages for the bottleneck bar chart.
export const STAGES = [
  { key: 'pending', label: 'Pending', statuses: [STATUS.pendingReview] },
  { key: 'transcribed', label: 'Transcribed', statuses: [STATUS.transcriptionApproved] },
  { key: 'enhancing', label: 'Enhancing', statuses: [STATUS.inProgress] },
  { key: 'drafted', label: 'Drafted', statuses: [STATUS.draftGenerated] },
  { key: 'draftReview', label: 'Draft Review', statuses: [STATUS.draftReview] },
  { key: 'publish', label: 'Publish', statuses: [STATUS.draftApproval, STATUS.publishApproved] },
];

const COLOR_BY_STATUS = {
  [STATUS.pendingReview]: 'amber',
  [STATUS.transcriptionApproved]: 'blue',
  [STATUS.inProgress]: 'blue',
  [STATUS.draftGenerated]: 'purple',
  [STATUS.draftReview]: 'purple',
  [STATUS.draftApproval]: 'blue',
  [STATUS.publishApproved]: 'blue',
  [STATUS.publishedToGithub]: 'green',
  [STATUS.errors]: 'red',
  [STATUS.rejected]: 'red',
  [STATUS.notStarted]: 'gray',
};

// ── pure helpers (exported for tests) ────────────────────────────────────────
/** Returns the visual color token associated with a workflow status. */
export function statusColor(statusName) {
  return COLOR_BY_STATUS[statusName] || 'gray';
}

/** Finds the active pipeline stage with the largest record count. */

export function bottleneckStage(counts = {}) {
  let best = null;
  for (const stage of STAGES) {
    const count = stage.statuses.reduce((n, s) => n + (counts[s] || 0), 0);
    if (count > 0 && (!best || count > best.count)) best = { ...stage, count };
  }
  return best;
}

/** Formats an ISO timestamp as a compact relative age. */

export function timeAgo(iso, now = Date.now) {
  if (!iso) return '—';
  const ms = now() - Date.parse(iso);
  if (Number.isNaN(ms)) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** Formats a millisecond duration for dashboard display. */

export function fmtDuration(ms) {
  if (ms == null || Number.isNaN(ms)) return '—';
  const totalMin = Math.floor(ms / 60000);
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** Escapes untrusted text before interpolation into dashboard markup. */

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function safeDashboardUrl(rawUrl, baseUrl = 'https://techfusionreport.com/') {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return null;
  try {
    const base = new URL(baseUrl);
    const url = new URL(rawUrl, base);
    return url.protocol === 'https:' || url.origin === base.origin ? url.href : null;
  } catch {
    return null;
  }
}

/** Converts a supported YouTube URL into a privacy-enhanced embed URL. */

export function youtubeEmbedUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.replace(/^www\./, '').toLowerCase();
    let id = '';
    if (host === 'youtu.be') id = url.pathname.split('/').filter(Boolean)[0] || '';
    if (host === 'youtube.com' || host === 'm.youtube.com') {
      id = url.searchParams.get('v') || '';
      if (!id) {
        const parts = url.pathname.split('/').filter(Boolean);
        if (['embed', 'shorts', 'live'].includes(parts[0])) id = parts[1] || '';
      }
    }
    return /^[A-Za-z0-9_-]{6,20}$/.test(id) ? `https://www.youtube-nocookie.com/embed/${id}` : null;
  } catch {
    return null;
  }
}

/** Builds safe media markup for YouTube, Vimeo, direct video, or link fallback. */

function videoEmbed(url) {
  let embed = youtubeEmbedUrl(url);
  const safeMediaUrl = safeDashboardUrl(url);
  try {
    const u = new URL(url);
    if (!embed && /(^|\.)vimeo\.com$/i.test(u.hostname)) {
      const id = u.pathname.split('/').filter(Boolean).find(x => /^\d+$/.test(x));
      if (id) embed = `https://player.vimeo.com/video/${id}`;
    }
    if (!embed && safeMediaUrl && /\.(mp4|webm|ogg)$/i.test(u.pathname)) {
      return `<video class="video-direct" controls preload="metadata" src="${escapeHtml(safeMediaUrl)}"></video>`;
    }
  } catch { /* fallback below */ }
  if (!embed) return safeMediaUrl
    ? `<div class="video-fallback"><a href="${escapeHtml(safeMediaUrl)}" target="_blank" rel="noopener">Open original video ↗</a></div>`
    : '<div class="state empty">No original video URL available.</div>';
  return `<div class="video-frame"><iframe src="${embed}" title="Original source video" loading="lazy"
    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
    referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe></div>`;
}

/** Normalizes a Notion page id to the compact form approval evidence uses. */
export function compactPageId(id) {
  return String(id || '').replaceAll('-', '').toLowerCase();
}

/** Indexes approvals whose receipt is still active by gate and compact page id. */
export function indexApprovals(recent, extra = {}) {
  const index = { 1: new Map(), 2: new Map() };
  for (const group of recent?.gates || []) {
    if (!index[group.gate]) continue;
    for (const item of group.items || []) {
      if (item.receiptActive) index[group.gate].set(compactPageId(item.pageId), item);
    }
  }
  // Approvals made in this tab win, since KV listings can lag a fresh write.
  for (const gate of [1, 2]) {
    for (const [id, evidence] of extra[gate] || []) index[gate].set(id, evidence);
  }
  return index;
}

/** Formats evidence as "Approved <local date/time> by <approver>". */
export function approvalText(evidence, format = (date) => date.toLocaleString()) {
  const date = new Date(evidence?.approvedAt);
  const when = Number.isNaN(date.getTime()) ? 'at an unknown time' : format(date);
  return `Approved ${when} by ${evidence?.approver || 'unknown'}`;
}

// ═════════════════════════════════════════════════════════════════════════════
// Everything below runs only in the browser.
// ═════════════════════════════════════════════════════════════════════════════
if (typeof document !== 'undefined') {
  const API = '/ops/api';
  const NOTION_DB = 'https://www.notion.so/1fbbd080de92804389aadc02853c15c7';

  const state = {
    overview: null,
    commandCenter: null,
    observability: null,
    attention: null,
    queue: [],
    drafts: [],
    draftDetails: {},
    draftDetailLoading: null,
    draftsCursor: null,
    draftsHasMore: false,
    draftsLoading: false,
    selectedQueue: null,
    selectedDraft: null,
    selectedDraftIds: new Set(),
    draftQuery: { q: '', sort: 'oldest', featured: '' },
    dirtyDraft: false,
    // Approval evidence from /approvals/recent, indexed by gate → compact page id.
    recentApprovals: null,
    approvals: { 1: new Map(), 2: new Map() },
    localApprovals: { 1: new Map(), 2: new Map() },
  };
  const APPROVAL_GATE = { 'approve-transcription': 1, 'approve-publish': 2 };
  /** Returns the first matching element within an optional root. */
  const $ = (sel, root = document) => root.querySelector(sel);
  /** Returns the root element for a named dashboard view. */
  const view = (name) => $(`#view-${name}`);

  /** Sends an authenticated same-origin request to the Ops Worker API. */

  async function api(path, opts = {}, expectedStatus = null) {
    const res = await fetch(`${API}${path}`, {
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      ...opts,
    });
    let body = null;
    try { body = await res.json(); } catch { /* non-JSON */ }
    if (!res.ok || (expectedStatus !== null && res.status !== expectedStatus)) throw new Error(body?.error || `Request failed (${res.status})`);
    return body;
  }

  /** Builds a loading-state fragment. */

  const loading = (msg = 'Loading…') => `<div class="state loading"><span class="spinner"></span>${escapeHtml(msg)}</div>`;
  /** Builds an empty-state fragment. */
  const empty = (msg) => `<div class="state empty">${escapeHtml(msg)}</div>`;
  /** Builds an escaped error-state fragment. */
  const errorState = (msg) => `<div class="state error">⚠ ${escapeHtml(msg)}</div>`;
  /** Builds monospace markup for a nullable numeric value. */
  const num = (n) => `<span class="mono">${n == null ? '—' : n}</span>`;
  /** Builds a new-tab link for a valid URL, otherwise inert text (same URL rules as safeDashboardUrl). */
  const externalLink = (url, label, className = '', { noreferrer = false } = {}) => {
    const href = safeDashboardUrl(url, window.location.href);
    const cls = className ? ` class="${escapeHtml(className)}"` : '';
    return href
      ? `<a${cls} href="${escapeHtml(href)}" target="_blank" rel="noopener${noreferrer ? ' noreferrer' : ''}">${escapeHtml(label)}</a>`
      : `<span${cls}>${escapeHtml(label)}</span>`;
  };

  // ── navigation ─────────────────────────────────────────────────────────────
  /** Activates a dashboard view and loads its current data. */
  function switchView(name) {
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach((n) => n.classList.toggle('current', n.dataset.view === name));
    view(name)?.classList.add('active');
    if (name === 'dashboard') loadDashboard();
    if (name === 'infrastructure') loadInfrastructure();
    if (name === 'queue') loadQueue();
    if (name === 'drafts') loadDrafts();
    if (name === 'board') loadBoard();
    if (name === 'errors') loadErrors();
  }

  /** Refreshes navigation badges from the cached overview response. */

  function setBadges() {
    const k = state.overview?.kpis;
    if (!k) return;
    $('#badge-queue').textContent = k.gate1Backlog ?? 0;
    $('#badge-drafts').textContent = k.gate2Backlog ?? 0;
    $('#badge-errors').textContent = k.errorCount ?? 0;
  }

  // ── dashboard ──────────────────────────────────────────────────────────────
  /** Loads and renders the operations overview. */
  async function loadDashboard() {
    const root = view('dashboard');
    root.innerHTML = loading('Loading operations…');
    try {
      const o = await api('/overview');
      const commandCenter = await api('/command-center').catch((error) => ({
        generatedAt: o.generatedAt,
        tasks: { status: 'error', reason: error.message, items: [] },
        pullRequests: { status: 'error', reason: error.message, items: [] },
        cloudflare: { status: 'error', reason: error.message },
        services: [],
        attention: [],
      }));
      const attention = await api('/attention').catch((error) => ({
        generatedAt: o.generatedAt,
        count: 0,
        criticalCount: 0,
        items: [],
        error: error.message,
      }));
      state.overview = o;
      state.commandCenter = commandCenter;
      state.attention = attention;
      setBadges();
      root.innerHTML = renderDashboard(o, commandCenter, attention);
    } catch (e) {
      root.innerHTML = errorState(e.message);
    }
  }

  /** Builds the markup for one key-performance indicator card. */

  function kpiCard(label, value, sub) {
    return `<div class="kpi"><div class="kpi-label">${escapeHtml(label)}</div>
      <div class="kpi-value mono">${value}</div>${sub ? `<div class="kpi-sub">${sub}</div>` : ''}</div>`;
  }

  // ── infrastructure / observability ───────────────────────────────────────────
  /** Loads the authenticated Prometheus summary for the Infrastructure view. */
  async function loadInfrastructure() {
    const root = view('infrastructure');
    root.innerHTML = loading('Loading Prometheus telemetry…');
    try {
      state.observability = await api('/observability');
      root.innerHTML = renderInfrastructure(state.observability);
      try {
        const monitoring = await api('/legacy-monitoring');
        root.insertAdjacentHTML('beforeend', renderMonitoring(monitoring));
      } catch (monitorError) {
        root.insertAdjacentHTML('beforeend', renderMonitoring({ status: 'unavailable', reason: monitorError.message }));
      }
    } catch (e) {
      root.innerHTML = `<header class="page-head"><h1>Infrastructure</h1></header>${errorState(e.message)}`;
    }
  }

  /** Formats an average percentage from a possibly missing metric series. */
  function metricValue(points = []) {
    const values = (Array.isArray(points) ? points : []).flatMap((point) => {
      const rawValue = point?.value;
      if (rawValue === null || rawValue === undefined || rawValue === '') return [];
      const value = Number(rawValue);
      return Number.isFinite(value) ? [value] : [];
    });
    if (!values.length) return '—';
    return `${(values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(1)}%`;
  }

  /** Builds the Infrastructure view without turning unavailable data into health. */
  function renderInfrastructure(data) {
    const targets = data?.targets || { items: [] };
    const alerts = data?.alerts || { items: [] };
    const status = data?.status || 'unavailable';
    const grafana = safeDashboardUrl(data?.grafana?.url, window.location.href);
    const hasNumber = (value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
    const hasTargetCounts = hasNumber(targets.healthy) && hasNumber(targets.total);
    const hasAlertCount = hasNumber(alerts.firing);
    const targetValue = hasTargetCounts ? `${Number(targets.healthy)}/${Number(targets.total)}` : '—';
    const targetSub = hasTargetCounts
      ? (hasNumber(targets.down) && Number(targets.down) > 0 ? `${Number(targets.down)} down` : 'All reporting')
      : 'Unavailable';
    const alertValue = hasAlertCount ? Number(alerts.firing) : '—';
    const alertSub = hasAlertCount ? (Number(alerts.firing) > 0 ? 'Needs attention' : 'None firing') : 'Unavailable';
    const targetItems = Array.isArray(targets.items) ? targets.items : [];
    const rows = targetItems.length
      ? targetItems.map((target) => `<tr><td>${escapeHtml(target.job || 'unknown')}</td><td class="mono">${escapeHtml(target.instance || '—')}</td><td><span class="pill ${target.health === 'up' ? 'green' : 'red'}"></span>${escapeHtml(target.health)}</td><td class="muted">${escapeHtml(target.lastError || '—')}</td><td class="mono muted">${timeAgo(target.lastScrape)}</td></tr>`).join('')
      : '<tr><td colspan="5" class="muted">No scrape-target data available.</td></tr>';
    return `<header class="page-head"><div><h1>Infrastructure</h1><p class="muted">Prometheus telemetry · Grafana dashboards</p></div>
      <div class="header-actions"><span class="badge ${escapeHtml(status)}">${escapeHtml(status)}</span>${grafana ? `<a class="btn ghost" href="${escapeHtml(grafana)}" target="_blank" rel="noopener">Open Grafana ↗</a>` : ''}</div></header>
      ${data?.reason ? `<div class="state error">⚠ ${escapeHtml(data.reason)}</div>` : ''}
      <div class="kpis infra-kpis">
        ${kpiCard('Targets healthy', targetValue, targetSub)}
        ${kpiCard('Firing alerts', alertValue, alertSub)}
        ${kpiCard('Average CPU', metricValue(data?.metrics?.cpu), '5-minute rate')}
        ${kpiCard('Average memory', metricValue(data?.metrics?.memory), 'Current utilization')}
        ${kpiCard('Average disk', metricValue(data?.metrics?.disk), 'Non-temporary filesystems')}
      </div>
      <section class="panel"><div class="section-head"><h2>Prometheus scrape targets</h2><span class="mono muted">Updated ${timeAgo(data?.generatedAt)}</span></div>
        <table class="tbl"><thead><tr><th>Job</th><th>Instance</th><th>Health</th><th>Last error</th><th>Last scrape</th></tr></thead><tbody>${rows}</tbody></table></section>`;
  }

  /** Builds the operations-overview markup from API data. */

  function renderDashboard(o, commandCenter, unifiedAttention = {}) {
    const k = o.kpis;
    const tasks = commandCenter?.tasks || { status: 'error', items: [] };
    const pullRequests = commandCenter?.pullRequests || { status: 'error', items: [] };
    const cloudflare = commandCenter?.cloudflare || { status: 'error' };
    const services = commandCenter?.services || [];
    const attention = unifiedAttention?.items || commandCenter?.attention || [];

    const sourceBadge = (label, source) =>
      `<span class="badge ${escapeHtml(source.status || 'error')}">${escapeHtml(label)} · ${escapeHtml(source.status || 'error')}</span>`;
    const safeLink = (url, label, className = '') => {
      const href = safeDashboardUrl(url, window.location.href);
      return href
        ? `<a${className ? ` class="${escapeHtml(className)}"` : ''} href="${escapeHtml(href)}" target="_blank" rel="noopener">${escapeHtml(label)}</a>`
        : `<span${className ? ` class="${escapeHtml(className)}"` : ''}>${escapeHtml(label)}</span>`;
    };
    const taskRows = tasks.items?.length
      ? tasks.items.map((item) => `<li>${safeLink(item.url, item.title)}<span class="mono muted">${escapeHtml(item.priority || '')} · ${escapeHtml(item.status || '')}</span></li>`).join('')
      : '<li class="muted">No task records available.</li>';
    const prRows = pullRequests.items?.length
      ? pullRequests.items.slice(0, 8).map((item) => `<li>${safeLink(item.url, `${item.repository || 'repo'} #${item.number}: ${item.title}`)}<span class="mono muted">${item.draft ? 'draft' : 'open'} · ${timeAgo(item.updatedAt)}</span></li>`).join('')
      : '<li class="muted">No open pull requests available.</li>';
    const serviceRows = services.length
      ? services.map((item) => `<li>${escapeHtml(item.name)} <span class="badge ${escapeHtml(item.status)}">${escapeHtml(item.status)}</span><span class="mono muted">${item.httpStatus ?? '—'} · ${item.latencyMs ?? '—'}ms</span></li>`).join('')
      : '<li class="muted">No service probes available.</li>';
    const attentionRows = attention.length
      ? attention.slice(0, 12).map((item) => {
        const destination = item.externalUrl || item.notionUrl;
        const title = destination ? safeLink(destination, item.title) : escapeHtml(item.title);
        const inspect = item.targetView
          ? `<button class="btn ghost compact" data-view="${escapeHtml(item.targetView)}">Inspect</button>`
          : destination ? safeLink(destination, 'Open ↗', 'btn ghost compact') : '';
        const directAction = item.action
          ? `<button class="btn amber compact" data-act="${escapeHtml(item.action)}" data-id="${escapeHtml(item.id)}">Re-authorize</button>`
          : '';
        return `<li class="attention-item">
          <div class="attention-copy"><span class="badge ${item.priority === 'critical' ? 'error' : 'degraded'}">${escapeHtml(item.priority || 'high')}</span>
          ${title}<span class="muted">${escapeHtml(item.recommendedAction || '')}</span>
          ${item.reason ? `<span class="mono muted">${escapeHtml(item.reason)}</span>` : ''}
          ${item.jobId ? `<span class="mono muted">${escapeHtml(item.jobId)} · attempt ${item.attemptCount ?? 0}</span>` : ''}</div>
          <div class="actions compact-actions">${inspect}${directAction}</div>
        </li>`;
      }).join('')
      : `<li class="muted">${unifiedAttention?.error ? `Action queue unavailable: ${escapeHtml(unifiedAttention.error)}` : 'Nothing currently requires attention.'}</li>`;
    const cfSummary = cloudflare.status === 'ok'
      ? `${cloudflare.summary.workers} Workers · ${cloudflare.summary.accessApplications} Access apps · ${cloudflare.summary.healthyTunnels} healthy / ${cloudflare.summary.downTunnels} down tunnels`
      : escapeHtml(cloudflare.reason || 'Cloudflare state unavailable');
    const kpis = [
      kpiCard('In Pipeline', k.inPipeline),
      kpiCard('Gate 1 Backlog', k.gate1Backlog, `oldest ${fmtDuration(k.gate1OldestAgeMs)} · target &lt;4h`),
      kpiCard('Gate 2 Backlog', k.gate2Backlog, `oldest ${fmtDuration(k.gate2OldestAgeMs)} · target &lt;8h`),
      kpiCard('Published', k.publishedTotal, `${k.publishedThisMonth} this month`),
      kpiCard('Errors', k.errorCount, `${k.rejectionCount} rejected`),
      kpiCard('Featured', k.featuredRate == null ? '—' : `${Math.round(k.featuredRate * 100)}%`, `${k.featuredCount ?? '—'} published articles`),
    ].join('');

    const warn = (o.warnings && o.warnings.length)
      ? `<div class="state error" style="text-align:left">Some data degraded: ${escapeHtml(o.warnings.join(' · '))}</div>`
      : '';

    const bottleneck = bottleneckStage(o.counts);
    const maxCount = Math.max(1, ...STAGES.map((s) => s.statuses.reduce((n, st) => n + (o.counts[st] || 0), 0)));
    const bars = STAGES.map((s) => {
      const c = s.statuses.reduce((n, st) => n + (o.counts[st] || 0), 0);
      const isBn = bottleneck && bottleneck.key === s.key;
      const h = Math.round((c / maxCount) * 100);
      return `<div class="bar-col ${isBn ? 'bottleneck' : ''}">
        <div class="bar-num mono">${c}</div>
        <div class="bar" style="height:${Math.max(h, 4)}%"></div>
        <div class="bar-label">${escapeHtml(s.label)}${isBn ? ' ⚠' : ''}</div></div>`;
    }).join('');

    const agents = o.agents.map((a) =>
      `<li class="agent ${a.status}"><span class="dot"></span>${escapeHtml(a.name)}
        <span class="agent-status">${a.status}</span>
        <span class="mono muted">${a.lastHeartbeat ? timeAgo(a.lastHeartbeat) : '—'}</span></li>`).join('');

    const recent = o.recentPublished.length
      ? o.recentPublished.map((r) =>
          `<li>${externalLink(r.publishedUrl || r.notionUrl, r.title || 'Untitled')}
            <span class="mono muted">${escapeHtml(r.publishedDate || '')}</span></li>`).join('')
      : `<li class="muted">Nothing published yet.</li>`;

    const errs = o.errors.length
      ? o.errors.map((e) =>
          `<li><span class="pill red"></span>${escapeHtml(e.title || 'Untitled')}
            <span class="muted">${escapeHtml((e.lastError || e.status || '').slice(0, 80))}</span></li>`).join('')
      : `<li class="muted">No errors. Clean board.</li>`;

    return `
      <header class="page-head"><h1>Command Center</h1>
        <span class="mono muted">${new Date(commandCenter?.generatedAt || o.generatedAt).toLocaleString()}</span></header>
      ${warn}
      <section class="source-strip">
        ${sourceBadge('Task Tracker', tasks)}
        ${sourceBadge('GitHub PRs', pullRequests)}
        ${sourceBadge('Cloudflare', cloudflare)}
      </section>
      <div class="cols command-grid">
        <section class="panel"><div class="section-head"><h2>Action Required</h2><span class="mono muted">${unifiedAttention?.criticalCount ?? 0} critical · ${unifiedAttention?.count ?? attention.length} total</span></div><ul class="list attention-list">${attentionRows}</ul></section>
        <section class="panel"><h2>System Health</h2><ul class="health">${serviceRows}</ul>
          <div class="source-note">${cfSummary}</div></section>
      </div>
      <div class="cols command-grid">
        <section class="panel"><h2>Authoritative Tasks</h2><ul class="list">${taskRows}</ul>
          ${tasks.authoritativeUrl ? safeLink(tasks.authoritativeUrl, 'Open Task Tracker ↗', 'source-link') : ''}</section>
        <section class="panel"><h2>Open Pull Requests</h2><ul class="list">${prRows}</ul>
          ${pullRequests.authoritativeUrl ? safeLink(pullRequests.authoritativeUrl, 'Open GitHub PRs ↗', 'source-link') : ''}</section>
      </div>
      <section class="kpi-strip">${kpis}</section>
      <section class="panel"><h2>Pipeline — Active Stages</h2>
        <div class="chart">${bars}</div>
        <div class="chart-note">${bottleneck ? `Bottleneck: <strong>${escapeHtml(bottleneck.label)}</strong> (${bottleneck.count})` : 'Pipeline clear.'}</div>
      </section>
      <div class="cols">
        <section class="panel"><h2>Automation Jobs</h2><ul class="agents">${agents}</ul>
          <h2>Errors &amp; Exceptions</h2><ul class="list">${errs}</ul></section>
        <section class="panel"><h2>Recently Published</h2><ul class="list">${recent}</ul>
          <h2>System Health</h2>
          <ul class="health">
            <li>API <span class="badge ${o.health.api}">${o.health.api}</span></li>
            <li>Notion <span class="badge ${o.health.notion}">${o.health.notion}</span></li>
            <li>Agents <span class="badge ${o.health.agents}">${o.health.agents}</span></li>
          </ul>
          <h2>Quick Links</h2>
          <div class="quick">
            <a href="#" data-view="queue">Review Queue</a>
            <a href="#" data-view="drafts">Draft Review</a>
            <a href="#" data-view="board">Catalog</a>
          </div>
        </section>
      </div>`;
  }

  // ── approval evidence ──────────────────────────────────────────────────────
  /** Loads recent approval evidence; a failure leaves Approve buttons enabled. */
  async function loadApprovals() {
    try {
      state.recentApprovals = await api('/approvals/recent');
    } catch (e) {
      state.recentApprovals = { error: e.message, gates: [] };
    }
    state.approvals = indexApprovals(state.recentApprovals, state.localApprovals);
  }

  /** Builds an Approve button, greyed out with its evidence once approved. */
  function approveButton(act, id, label) {
    const evidence = state.approvals[APPROVAL_GATE[act]].get(compactPageId(id));
    if (evidence) {
      return `<button class="btn green" disabled aria-disabled="true">${escapeHtml(label)}</button>
        <span class="approved-note">${escapeHtml(approvalText(evidence))}</span>`;
    }
    return `<button class="btn green" data-act="${act}" data-id="${escapeHtml(id)}">${escapeHtml(label)}</button>`;
  }

  /** Builds the "Recently approved" list for one gate (last 14 days, newest first). */
  function recentApprovedSection(gate, label) {
    const recent = state.recentApprovals;
    if (!recent) return '';
    const group = (recent.gates || []).find((g) => g.gate === gate);
    const items = group?.items || [];
    const body = recent.error
      ? errorState(`Approval history unavailable: ${recent.error}`)
      : items.length
        ? items.map((it) => `<div class="recent-row">
            <span class="row-title">${externalLink(it.notionUrl, it.title || 'Untitled')}</span>
            <span class="row-sub muted">Gate ${gate} · ${escapeHtml(approvalText(it))}${it.receiptActive ? '' : ' · receipt revoked'}</span>
            <button class="btn green" disabled aria-disabled="true">${escapeHtml(label)}</button>
          </div>`).join('')
        : empty(`Nothing approved at Gate ${gate} in the last ${recent.windowDays || 14} days.`);
    const skipped = group?.skipped ? `<div class="muted small">${group.skipped} approved item(s) could not be loaded from Notion.</div>` : '';
    return `<section class="recent-approvals"><h2>Recently approved</h2>${body}${skipped}</section>`;
  }

  // ── review queue (Gate 1) ───────────────────────────────────────────────────
  /** Loads the transcription approval queue from Notion through the Worker. */
  async function loadQueue() {
    const root = view('queue');
    root.innerHTML = `<div class="split"><div class="list-pane">${loading('Loading queue…')}</div><div class="detail-pane"></div></div>`;
    try {
      const [data] = await Promise.all([api('/queue'), loadApprovals()]);
      state.queue = data.items;
      renderQueue();
    } catch (e) {
      $('.list-pane', root).innerHTML = errorState(e.message);
    }
  }

  /** Renders the Gate 1 review list and selects a default record. */

  function renderQueue() {
    const root = view('queue');
    const listPane = $('.list-pane', root);
    const recent = recentApprovedSection(1, 'Approve for Transcription');
    if (!state.queue.length) { listPane.innerHTML = empty('Queue clear — nothing pending review.') + recent; $('.detail-pane', root).innerHTML = ''; return; }
    listPane.innerHTML = state.queue.map((it, i) => `
      <button class="row ${i === state.selectedQueue ? 'sel' : ''}" data-i="${i}">
        <span class="row-title">${escapeHtml(it.title || 'Untitled')}</span>
        <span class="row-sub muted">${escapeHtml(it.category || '')}${it.subcategory ? ' · ' + escapeHtml(it.subcategory) : ''}</span>
      </button>`).join('') + recent;
    if (state.selectedQueue == null) state.selectedQueue = 0;
    renderQueueDetail();
  }

  /** Renders the selected Gate 1 record and its source video. */

  function renderQueueDetail() {
    const root = view('queue');
    const it = state.queue[state.selectedQueue];
    if (!it) { $('.detail-pane', root).innerHTML = ''; return; }
    $('.detail-pane', root).innerHTML = `
      <h2>${escapeHtml(it.title || 'Untitled')}</h2>
      ${videoEmbed(it.videoUrl)}
      <dl class="meta">
        <dt>Source</dt><dd>${escapeHtml((it.source || []).join(', ') || '—')}</dd>
        <dt>Category</dt><dd>${escapeHtml(it.category || '—')} / ${escapeHtml(it.subcategory || '—')}</dd>
        <dt>Tags</dt><dd>${(it.tags || []).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join(' ') || '—'}</dd>
        <dt>Added</dt><dd class="mono">${timeAgo(it.createdTime)} ago</dd>
        <dt>Video</dt><dd>${it.videoUrl ? externalLink(it.videoUrl, 'Open video ↗') : '—'}</dd>
      </dl>
      <div class="actions">
        ${approveButton('approve-transcription', it.id, 'Approve for Transcription')}
        <button class="btn red" data-act="reject" data-id="${escapeHtml(it.id)}">Reject</button>
        ${externalLink(it.notionUrl, 'Open in Notion ↗', 'btn ghost')}
      </div>
      <div class="act-msg"></div>`;
  }

  // ── draft review (Gate 2) ──────────────────────────────────────────────────
  /** Builds the encoded query string for draft filters and pagination. */
  function draftParams(cursor = '') {
    const p = new URLSearchParams();
    Object.entries(state.draftQuery).forEach(([k, v]) => { if (v !== '') p.set(k, v); });
    if (cursor) p.set('cursor', cursor);
    return p.toString() ? `?${p}` : '';
  }

  /** Loads the first filtered page of records awaiting draft review. */

  async function loadDrafts() {
    const root = view('drafts');
    state.draftDetails = {};
    state.draftDetailLoading = null;
    state.dirtyDraft = false;
    root.innerHTML = `<div class="split"><div class="list-pane">${loading('Loading drafts…')}</div><div class="detail-pane"></div></div>`;
    try {
      const [data] = await Promise.all([api('/drafts' + draftParams()), loadApprovals()]);
      state.drafts = data.items;
      state.draftsCursor = data.nextCursor || null;
      state.draftsHasMore = data.hasMore === true;
      state.draftsLoading = false;
      state.selectedDraft = state.drafts.length ? 0 : null;
      renderDrafts();
    } catch (e) { $('.list-pane', root).innerHTML = errorState(e.message); }
  }

  /** Derives a compact editorial risk indicator from a comparison report. */

  function riskSummary(text = '') {
    const estimate = text.match(/(\d{1,3})\s*%/)?.[1];
    const unsupported = (text.match(/POSSIBLY UNSUPPORTED[\s\S]*?(?=CHANGED DETAILS|COVERAGE ESTIMATE|$)/i)?.[0].match(/^-/gm) || []).length;
    const changed = (text.match(/CHANGED DETAILS[\s\S]*?(?=COVERAGE ESTIMATE|$)/i)?.[0].match(/^-/gm) || []).length;
    const level = unsupported + changed > 4 ? 'high' : unsupported + changed ? 'medium' : 'low';
    return `<div class="risk ${level}"><strong>${level.toUpperCase()} RISK</strong> · Coverage ${estimate ? estimate + '%' : 'not scored'} · ${unsupported} unsupported · ${changed} changed</div>`;
  }

  /** Renders draft filters, selectable records, pagination, and bulk controls. */

  function renderDrafts() {
    const root = view('drafts'), listPane = $('.list-pane', root);
    const tools = `<div class="review-tools">
      <input id="draft-search" type="search" value="${escapeHtml(state.draftQuery.q)}" placeholder="Search title">
      <select id="draft-sort"><option value="oldest">Oldest first</option><option value="newest">Newest first</option><option value="seoHigh">SEO high–low</option><option value="seoLow">SEO low–high</option></select>
      <select id="draft-featured"><option value="">All</option><option value="true">Featured</option><option value="false">Not featured</option></select>
      <button class="btn ghost" data-filter-drafts>Apply</button>
    </div>`;
    const recent = recentApprovedSection(2, 'Approve Publishing');
    if (!state.drafts.length) { listPane.innerHTML = tools + empty('No matching drafts awaiting review.') + recent; $('.detail-pane', root).innerHTML = ''; return; }
    const rows = state.drafts.map((it, i) => `<div class="row-wrap">
      <input type="checkbox" data-select-draft="${escapeHtml(it.id)}" ${state.selectedDraftIds.has(it.id) ? 'checked' : ''} aria-label="Select ${escapeHtml(it.title)}">
      <button class="row ${i === state.selectedDraft ? 'sel' : ''}" data-i="${i}">
        <span class="row-title">${escapeHtml(it.title || 'Untitled')}${it.featured ? ' ⭐' : ''}</span>
        <span class="row-sub muted mono">${it.wordCount}w · SEO ${it.seoScore ?? '—'}</span>
      </button></div>`).join('');
    const total = state.overview?.kpis?.gate2Backlog;
    const progress = total == null ? `${state.drafts.length} loaded` : `${state.drafts.length} of ${total} total loaded`;
    const more = state.draftsHasMore ? `<button class="btn ghost" data-load-more="drafts">Load 50 More</button>` : '';
    listPane.innerHTML = tools + rows + recent + `<div class="actions bulk"><select id="bulk-action"><option value="feature">Feature</option><option value="unfeature">Unfeature</option><option value="revision">Return for revision</option><option value="reject">Reject</option></select><button class="btn ghost" data-bulk-apply>Apply to selected</button>${more}<span class="muted mono">${progress}</span></div>`;
    $('#draft-sort').value = state.draftQuery.sort;
    $('#draft-featured').value = state.draftQuery.featured;
    renderDraftDetail();
  }

  /** Appends the next cursor page of draft-review records. */

  async function loadMoreDrafts() {
    if (state.draftsLoading || !state.draftsHasMore || !state.draftsCursor) return;
    state.draftsLoading = true;
    try {
      const data = await api('/drafts' + draftParams(state.draftsCursor));
      const seen = new Set(state.drafts.map(x => x.id));
      state.drafts.push(...data.items.filter(x => !seen.has(x.id)));
      state.draftsCursor = data.nextCursor || null; state.draftsHasMore = data.hasMore === true;
    } catch (e) { alert(e.message); } finally { state.draftsLoading = false; renderDrafts(); }
  }

  /** Loads the transcript, draft, comparison, notes, and audit data for one record. */

  async function loadDraftDetail(pageId) {
    if (!pageId || state.draftDetails[pageId] || state.draftDetailLoading === pageId) return;
    state.draftDetailLoading = pageId; renderDraftDetail();
    try { state.draftDetails[pageId] = await api(`/drafts/${encodeURIComponent(pageId)}`); }
    catch (e) { state.draftDetails[pageId] = { error: e.message }; }
    finally { state.draftDetailLoading = null; renderDraftDetail(); }
  }

  /** Renders the complete Gate 2 comparison and editing workspace. */

  function renderDraftDetail() {
    const root = view('drafts'), summary = state.drafts[state.selectedDraft], pane = $('.detail-pane', root);
    if (!summary || !pane) { if (pane) pane.innerHTML = ''; return; }
    const detail = state.draftDetails[summary.id];
    if (!detail) { pane.innerHTML = `<h2>${escapeHtml(summary.title)}</h2>${loading('Loading review workspace…')}`; loadDraftDetail(summary.id); return; }
    if (detail.error) { pane.innerHTML = errorState(detail.error); return; }
    pane.innerHTML = `
      <h2>${escapeHtml(detail.title || 'Untitled')}${detail.featured ? ' ⭐' : ''}</h2>
      ${videoEmbed(detail.videoUrl)}
      <dl class="meta"><dt>SEO Title</dt><dd>${escapeHtml(detail.seoTitle || '—')}</dd><dt>SEO Score</dt><dd>${detail.seoScore ?? '—'}</dd><dt>Focus KW</dt><dd>${escapeHtml(detail.focusKeyword || '—')}</dd><dt>Transcript</dt><dd>${detail.transcriptWordCount} words</dd><dt>Draft</dt><dd>${detail.wordCount} words</dd></dl>
      ${riskSummary(detail.keyPointComparison)}
      <section class="review-section comparison-panel"><div class="section-head"><h3>Key-Point Comparison</h3><button class="btn ghost" data-act="generate-comparison" data-id="${detail.id}">${detail.keyPointComparison ? 'Regenerate' : 'Generate'} Comparison</button></div><div class="review-copy">${escapeHtml(detail.keyPointComparison || 'Generate a transcript-grounded comparison for this draft.')}</div></section>
      <div class="compare-grid"><section class="review-section"><h3>Original Transcript</h3><div class="review-copy">${escapeHtml(detail.transcript || 'Unavailable')}</div></section>
      <section class="review-section"><div class="section-head"><h3>Editable Blog Draft</h3><span id="draft-count" class="mono muted">${detail.wordCount} words</span></div><textarea id="draft-editor" class="draft-editor">${escapeHtml(detail.blogDraft || '')}</textarea><details><summary>Rendered HTML preview</summary><iframe id="draft-preview" class="draft-preview" sandbox srcdoc="${escapeHtml(detail.blogDraft || '')}"></iframe></details></section></div>
      <label class="review-notes">Reviewer notes<textarea id="reviewer-notes">${escapeHtml(detail.reviewerNotes || '')}</textarea></label>
      <details class="audit"><summary>Review audit history</summary><pre>${escapeHtml(detail.reviewAuditLog || 'No dashboard actions recorded yet.')}</pre></details>
      <div class="actions">${externalLink(detail.notionUrl, 'Open in Notion ↗', 'btn ghost')}
      <button class="btn purple" data-act="save-draft" data-id="${detail.id}">Save Draft</button>
      <button class="btn amber" data-act="return-revision" data-id="${detail.id}">Return for Revision</button>
      <button class="btn red" data-act="reject" data-id="${detail.id}">Reject</button>
      <button class="btn ${detail.featured ? 'amber' : 'purple'}" data-act="toggle-featured" data-id="${detail.id}" data-val="${!detail.featured}">${detail.featured ? 'Unfeature' : 'Feature'}</button>
      ${approveButton('approve-publish', detail.id, 'Approve Publishing')}</div><div class="act-msg"></div>`;
  }

  // ── board ──────────────────────────────────────────────────────────────────
  /** Loads and renders the Content Catalog pipeline board. */
  async function loadBoard() {
    const root = view('board');
    root.innerHTML = loading('Loading catalog…');
    try {
      const data = await api('/board');
      root.innerHTML = `<header class="page-head"><h1>Content Catalog</h1></header>
        <div class="board">${data.columns.map((col) => `
          <div class="board-col">
            <div class="board-head ${statusColor(col.status)}">${escapeHtml(col.status)} <span class="mono">${col.count}</span></div>
            ${col.items.map((it) => `<div class="board-card">${escapeHtml(it.title || 'Untitled')}${it.featured ? ' ⭐' : ''}</div>`).join('') || '<div class="muted small">—</div>'}
          </div>`).join('')}</div>`;
    } catch (e) {
      root.innerHTML = errorState(e.message);
    }
  }

  // ── errors ─────────────────────────────────────────────────────────────────
  /** Loads and renders rejected records and automation errors. */
  async function loadErrors() {
    const root = view('errors');
    root.innerHTML = loading('Loading errors…');
    try {
      const data = await api('/errors');
      if (!data.items.length) { root.innerHTML = `<header class="page-head"><h1>Errors &amp; Exceptions</h1></header>${empty('No errors or rejections.')}`; return; }
      root.innerHTML = `<header class="page-head"><h1>Errors &amp; Exceptions</h1></header>
        <table class="tbl"><thead><tr><th>Title</th><th>Status</th><th>Last Error</th><th>Source</th></tr></thead>
        <tbody>${data.items.map((e) => `<tr>
          <td>${externalLink(e.notionUrl, e.title || 'Untitled')}</td>
          <td><span class="pill ${statusColor(e.status)}"></span>${escapeHtml(e.status || '')}</td>
          <td class="muted">${escapeHtml(e.lastError || '—')}</td>
          <td>${escapeHtml((e.source || []).join(', '))}</td></tr>`).join('')}</tbody></table>`;
    } catch (e) {
      root.innerHTML = errorState(e.message);
    }
  }

  // ── action handling (event delegation) ─────────────────────────────────────
  /** Shows persistent success or error feedback after a dashboard action. */
  function toast(message, bad = false) {
    let el = $('#ops-toast');
    if (!el) { el = document.createElement('div'); el.id = 'ops-toast'; document.body.appendChild(el); }
    el.className = `toast ${bad ? 'bad' : 'ok'}`; el.textContent = message; el.hidden = false;
    clearTimeout(el._timer); el._timer = setTimeout(() => { el.hidden = true; }, 5000);
  }

  /** Validates and submits a single governed review action. */

  async function runAction(btn) {
    // Disable on the click itself so a double click can't send a second request.
    if (btn.disabled) return;
    btn.disabled = true;
    const act = btn.dataset.act, pageId = btn.dataset.id;
    const gate = APPROVAL_GATE[act];
    const msg = btn.closest('.detail-pane')?.querySelector('.act-msg');
    if (msg) msg.innerHTML = '';
    const cancel = () => { btn.disabled = false; };
    const destructive = ['reject', 'return-revision', 'approve-publish', 'generate-comparison'];
    if (destructive.includes(act) && !confirm(`${act.replaceAll('-', ' ')} for this record?`)) return cancel();
    const body = { pageId };
    const editor = $('#draft-editor'), notes = $('#reviewer-notes');
    if (act === 'toggle-featured') body.value = btn.dataset.val === 'true';
    if (['save-draft', 'return-revision', 'reject', 'approve-publish'].includes(act)) {
      body.blogDraft = editor?.value; body.reviewerNotes = notes?.value;
      if (act === 'return-revision' || act === 'reject') body.note = prompt('Reason / requested change (required):') || '';
      if ((act === 'return-revision' || act === 'reject') && !body.note) return cancel();
    }
    try {
      const result = await api(`/actions/${act}`, { method: 'POST', body: JSON.stringify(body) });
      if (gate && result.evidence) {
        // Keep the button greyed even if the recent-approvals listing lags the write.
        state.localApprovals[gate].set(compactPageId(pageId), result.evidence);
        state.approvals[gate].set(compactPageId(pageId), result.evidence);
      }
      const message = result.alreadyApproved && result.evidence
        ? `Already approved — ${approvalText(result.evidence)}`
        : result.message || 'Saved successfully';
      state.dirtyDraft = false; toast(message);
      if (act === 'generate-comparison') {
        const d = state.draftDetails[pageId]; d.keyPointComparison = result.comparison; d.comparisonGeneratedAt = result.generatedAt; renderDraftDetail();
      } else if (act === 'save-draft') {
        const d = state.draftDetails[pageId]; d.blogDraft = body.blogDraft; d.reviewerNotes = body.reviewerNotes; renderDraftDetail();
      } else {
        const o = await api('/overview'); state.overview = o; setBadges();
        if (view('queue').classList.contains('active')) { state.selectedQueue = null; await loadQueue(); }
        else if (view('drafts').classList.contains('active')) await loadDrafts();
        else if (view('errors').classList.contains('active')) await loadErrors();
        else await loadDashboard();
      }
    } catch (e) {
      // Re-enable only on error, with the error shown next to the button.
      btn.disabled = false; toast(e.message, true);
      if (msg) msg.innerHTML = errorState(e.message);
    }
  }

  /** Validates and submits a guarded non-publishing bulk action. */

  async function runBulk() {
    const ids = [...state.selectedDraftIds], action = $('#bulk-action')?.value;
    if (!ids.length) return toast('Select at least one draft', true);
    if (!confirm(`${action} ${ids.length} selected records? Bulk publishing is never permitted.`)) return;
    const note = ['reject', 'revision'].includes(action) ? (prompt('Reason / requested change (required):') || '') : '';
    if (['reject', 'revision'].includes(action) && !note) return;
    try {
      const r = await api('/actions/bulk', { method: 'POST', body: JSON.stringify({ pageIds: ids, action, note }) });
      state.selectedDraftIds.clear(); toast(r.message); await loadDrafts();
    } catch (e) { toast(e.message, true); }
  }

  async function loadEnvironment() {
    const config = await api('/config', {}, 200).catch(() => null);
    const label = config?.environment;
    if (label !== 'PREVIEW' && label !== 'LIVE') return;

    const { siteUrl } = config;
    if (siteUrl !== null && typeof siteUrl !== 'string') return;
    const safeUrl = siteUrl?.startsWith('https://') ? safeDashboardUrl(siteUrl, window.location.href) : null;

    const badge = $('#ops-environment');
    badge.textContent = label;
    badge.dataset.environment = label;
    badge.hidden = false;
    document.title = `[${label}] TechFusion OS`;
    if (safeUrl) {
      $('#editorial-site-link').insertAdjacentHTML('afterend',
        externalLink(safeUrl, `View ${label} site`, 'nav-item ext', { noreferrer: true }));
    }
  }

  /** Registers dashboard event handlers and opens the overview. */

  function init() {
    void loadEnvironment();
    document.body.addEventListener('input', (ev) => {
      if (ev.target.id === 'draft-editor') {
        state.dirtyDraft = true;
        const words = ev.target.value.trim().split(/\s+/).filter(Boolean).length;
        if ($('#draft-count')) $('#draft-count').textContent = `${words} words · unsaved`;
        if ($('#draft-preview')) $('#draft-preview').srcdoc = ev.target.value;
      }
      if (ev.target.id === 'reviewer-notes') state.dirtyDraft = true;
    });
    document.body.addEventListener('change', (ev) => {
      const cb = ev.target.closest('[data-select-draft]');
      if (cb) { cb.checked ? state.selectedDraftIds.add(cb.dataset.selectDraft) : state.selectedDraftIds.delete(cb.dataset.selectDraft); }
    });
    document.body.addEventListener('click', (ev) => {
      const nav = ev.target.closest('[data-view]');
      if (nav) { ev.preventDefault(); if (state.dirtyDraft && !confirm('Discard unsaved draft changes?')) return; switchView(nav.dataset.view); return; }
      if (ev.target.closest('[data-filter-drafts]')) {
        state.draftQuery = { q: $('#draft-search').value.trim(), sort: $('#draft-sort').value, featured: $('#draft-featured').value }; loadDrafts(); return;
      }
      if (ev.target.closest('[data-bulk-apply]')) { runBulk(); return; }
      const more = ev.target.closest('[data-load-more="drafts"]');
      if (more) { loadMoreDrafts(); return; }
      const row = ev.target.closest('.row');
      if (row) {
        if (state.dirtyDraft && !confirm('Discard unsaved draft changes?')) return;
        const i = Number(row.dataset.i);
        if (view('queue').classList.contains('active')) { state.selectedQueue = i; renderQueue(); }
        else { state.selectedDraft = i; state.dirtyDraft = false; renderDrafts(); }
        return;
      }
      const actBtn = ev.target.closest('[data-act]');
      if (actBtn) { ev.preventDefault(); runAction(actBtn); }
    });
    window.addEventListener('beforeunload', (ev) => { if (state.dirtyDraft) { ev.preventDefault(); ev.returnValue = ''; } });
    switchView('dashboard');
  }

  document.addEventListener('DOMContentLoaded', init);
}
