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
export function statusColor(statusName) {
  return COLOR_BY_STATUS[statusName] || 'gray';
}

export function bottleneckStage(counts = {}) {
  let best = null;
  for (const stage of STAGES) {
    const count = stage.statuses.reduce((n, s) => n + (counts[s] || 0), 0);
    if (count > 0 && (!best || count > best.count)) best = { ...stage, count };
  }
  return best;
}

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

export function fmtDuration(ms) {
  if (ms == null || Number.isNaN(ms)) return '—';
  const totalMin = Math.floor(ms / 60000);
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ═════════════════════════════════════════════════════════════════════════════
// Everything below runs only in the browser.
// ═════════════════════════════════════════════════════════════════════════════
if (typeof document !== 'undefined') {
  const API = '/ops/api';
  const NOTION_DB = 'https://www.notion.so/1fbbd080de92804389aadc02853c15c7';

  const state = {
    overview: null,
    queue: [],
    drafts: [],
    draftsCursor: null,
    draftsHasMore: false,
    draftsLoading: false,
    selectedQueue: null,
    selectedDraft: null,
  };
  const $ = (sel, root = document) => root.querySelector(sel);
  const view = (name) => $(`#view-${name}`);

  async function api(path, opts = {}) {
    const res = await fetch(`${API}${path}`, {
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      ...opts,
    });
    let body = null;
    try { body = await res.json(); } catch { /* non-JSON */ }
    if (!res.ok) throw new Error(body?.error || `Request failed (${res.status})`);
    return body;
  }

  const loading = (msg = 'Loading…') => `<div class="state loading"><span class="spinner"></span>${escapeHtml(msg)}</div>`;
  const empty = (msg) => `<div class="state empty">${escapeHtml(msg)}</div>`;
  const errorState = (msg) => `<div class="state error">⚠ ${escapeHtml(msg)}</div>`;
  const num = (n) => `<span class="mono">${n == null ? '—' : n}</span>`;

  // ── navigation ─────────────────────────────────────────────────────────────
  function switchView(name) {
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach((n) => n.classList.toggle('current', n.dataset.view === name));
    view(name)?.classList.add('active');
    if (name === 'dashboard') loadDashboard();
    if (name === 'queue') loadQueue();
    if (name === 'drafts') loadDrafts();
    if (name === 'board') loadBoard();
    if (name === 'errors') loadErrors();
  }

  function setBadges() {
    const k = state.overview?.kpis;
    if (!k) return;
    $('#badge-queue').textContent = k.gate1Backlog ?? 0;
    $('#badge-drafts').textContent = k.gate2Backlog ?? 0;
    $('#badge-errors').textContent = (k.errorCount ?? 0) + (k.rejectionCount ?? 0);
  }

  // ── dashboard ──────────────────────────────────────────────────────────────
  async function loadDashboard() {
    const root = view('dashboard');
    root.innerHTML = loading('Loading operations…');
    try {
      const o = await api('/overview');
      state.overview = o;
      setBadges();
      root.innerHTML = renderDashboard(o);
    } catch (e) {
      root.innerHTML = errorState(e.message);
    }
  }

  function kpiCard(label, value, sub) {
    return `<div class="kpi"><div class="kpi-label">${escapeHtml(label)}</div>
      <div class="kpi-value mono">${value}</div>${sub ? `<div class="kpi-sub">${sub}</div>` : ''}</div>`;
  }

  function renderDashboard(o) {
    const k = o.kpis;
    const kpis = [
      kpiCard('In Pipeline', k.inPipeline),
      kpiCard('Gate 1 Backlog', k.gate1Backlog, `oldest ${fmtDuration(k.gate1OldestAgeMs)} · target &lt;4h`),
      kpiCard('Gate 2 Backlog', k.gate2Backlog, `oldest ${fmtDuration(k.gate2OldestAgeMs)} · target &lt;8h`),
      kpiCard('Published', k.publishedTotal, `${k.publishedThisMonth} this month`),
      kpiCard('Errors', k.errorCount, `${k.rejectionCount} rejected`),
      kpiCard('Featured', k.featuredRate == null ? '—' : `${Math.round(k.featuredRate * 100)}%`, `${k.featuredCount ?? '—'} flagged`),
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
          `<li><a href="${escapeHtml(r.publishedUrl || r.notionUrl)}" target="_blank" rel="noopener">${escapeHtml(r.title || 'Untitled')}</a>
            <span class="mono muted">${escapeHtml(r.publishedDate || '')}</span></li>`).join('')
      : `<li class="muted">Nothing published yet.</li>`;

    const errs = o.errors.length
      ? o.errors.map((e) =>
          `<li><span class="pill red"></span>${escapeHtml(e.title || 'Untitled')}
            <span class="muted">${escapeHtml((e.lastError || e.status || '').slice(0, 80))}</span></li>`).join('')
      : `<li class="muted">No errors. Clean board.</li>`;

    return `
      <header class="page-head"><h1>Operations Dashboard</h1>
        <span class="mono muted">${new Date(o.generatedAt).toLocaleString()}</span></header>
      ${warn}
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

  // ── review queue (Gate 1) ───────────────────────────────────────────────────
  async function loadQueue() {
    const root = view('queue');
    root.innerHTML = `<div class="split"><div class="list-pane">${loading('Loading queue…')}</div><div class="detail-pane"></div></div>`;
    try {
      const data = await api('/queue');
      state.queue = data.items;
      renderQueue();
    } catch (e) {
      $('.list-pane', root).innerHTML = errorState(e.message);
    }
  }

  function renderQueue() {
    const root = view('queue');
    const listPane = $('.list-pane', root);
    if (!state.queue.length) { listPane.innerHTML = empty('Queue clear — nothing pending review.'); $('.detail-pane', root).innerHTML = ''; return; }
    listPane.innerHTML = state.queue.map((it, i) => `
      <button class="row ${i === state.selectedQueue ? 'sel' : ''}" data-i="${i}">
        <span class="row-title">${escapeHtml(it.title || 'Untitled')}</span>
        <span class="row-sub muted">${escapeHtml(it.category || '')}${it.subcategory ? ' · ' + escapeHtml(it.subcategory) : ''}</span>
      </button>`).join('');
    if (state.selectedQueue == null) state.selectedQueue = 0;
    renderQueueDetail();
  }

  function renderQueueDetail() {
    const root = view('queue');
    const it = state.queue[state.selectedQueue];
    if (!it) { $('.detail-pane', root).innerHTML = ''; return; }
    $('.detail-pane', root).innerHTML = `
      <h2>${escapeHtml(it.title || 'Untitled')}</h2>
      <dl class="meta">
        <dt>Source</dt><dd>${escapeHtml((it.source || []).join(', ') || '—')}</dd>
        <dt>Category</dt><dd>${escapeHtml(it.category || '—')} / ${escapeHtml(it.subcategory || '—')}</dd>
        <dt>Tags</dt><dd>${(it.tags || []).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join(' ') || '—'}</dd>
        <dt>Added</dt><dd class="mono">${timeAgo(it.createdTime)} ago</dd>
        <dt>Video</dt><dd>${it.videoUrl ? `<a href="${escapeHtml(it.videoUrl)}" target="_blank" rel="noopener">Open video ↗</a>` : '—'}</dd>
      </dl>
      <div class="actions">
        <button class="btn green" data-act="approve-transcription" data-id="${escapeHtml(it.id)}">Approve for Transcription</button>
        <button class="btn red" data-act="reject" data-id="${escapeHtml(it.id)}">Reject</button>
        <a class="btn ghost" href="${escapeHtml(it.notionUrl)}" target="_blank" rel="noopener">Open in Notion ↗</a>
      </div>
      <div class="act-msg"></div>`;
  }

  // ── draft review (Gate 2) ──────────────────────────────────────────────────
  async function loadDrafts() {
    const root = view('drafts');
    root.innerHTML = `<div class="split"><div class="list-pane">${loading('Loading drafts…')}</div><div class="detail-pane"></div></div>`;
    try {
      const data = await api('/drafts');
      state.drafts = data.items;
      state.draftsCursor = data.nextCursor || null;
      state.draftsHasMore = data.hasMore === true;
      state.draftsLoading = false;
      renderDrafts();
    } catch (e) {
      $('.list-pane', root).innerHTML = errorState(e.message);
    }
  }

  function renderDrafts() {
    const root = view('drafts');
    const listPane = $('.list-pane', root);
    if (!state.drafts.length) { listPane.innerHTML = empty('No drafts awaiting review.'); $('.detail-pane', root).innerHTML = ''; return; }
    const rows = state.drafts.map((it, i) => `
      <button class="row ${i === state.selectedDraft ? 'sel' : ''}" data-i="${i}">
        <span class="row-title">${escapeHtml(it.title || 'Untitled')}${it.featured ? ' ⭐' : ''}</span>
        <span class="row-sub muted mono">${it.wordCount}w · SEO ${it.seoScore ?? '—'}</span>
      </button>`).join('');
    const total = state.overview?.kpis?.gate2Backlog;
    const progress = total == null ? `${state.drafts.length} loaded` : `${state.drafts.length} of ${total} loaded`;
    const more = state.draftsHasMore
      ? `<div class="actions"><button class="btn ghost" data-load-more="drafts" ${state.draftsLoading ? 'disabled' : ''}>
          ${state.draftsLoading ? 'Loading…' : 'Load 50 More'}</button><span class="muted mono">${progress}</span></div>`
      : `<div class="actions"><span class="muted mono">${progress}</span></div>`;
    listPane.innerHTML = rows + more;
    if (state.selectedDraft == null) state.selectedDraft = 0;
    renderDraftDetail();
  }

  async function loadMoreDrafts() {
    if (state.draftsLoading || !state.draftsHasMore || !state.draftsCursor) return;
    state.draftsLoading = true;
    renderDrafts();
    try {
      const data = await api(`/drafts?cursor=${encodeURIComponent(state.draftsCursor)}`);
      const seen = new Set(state.drafts.map((item) => item.id));
      state.drafts.push(...(data.items || []).filter((item) => !seen.has(item.id)));
      state.draftsCursor = data.nextCursor || null;
      state.draftsHasMore = data.hasMore === true;
    } catch (e) {
      const root = view('drafts');
      const detail = $('.detail-pane', root);
      if (detail) detail.innerHTML = errorState(e.message);
    } finally {
      state.draftsLoading = false;
      renderDrafts();
    }
  }

  function renderDraftDetail() {
    const root = view('drafts');
    const it = state.drafts[state.selectedDraft];
    if (!it) { $('.detail-pane', root).innerHTML = ''; return; }
    $('.detail-pane', root).innerHTML = `
      <h2>${escapeHtml(it.title || 'Untitled')}${it.featured ? ' <span class="star">⭐</span>' : ''}</h2>
      <dl class="meta">
        <dt>SEO Title</dt><dd>${escapeHtml(it.seoTitle || '—')}</dd>
        <dt>SEO Score</dt><dd class="mono">${it.seoScore ?? '—'}</dd>
        <dt>Focus KW</dt><dd>${escapeHtml(it.focusKeyword || '—')}</dd>
        <dt>Length</dt><dd class="mono">${it.wordCount} words</dd>
      </dl>
      <div class="draft-preview">${escapeHtml(it.draftPreview || 'No draft content.')}</div>
      <div class="actions">
        <a class="btn ghost" href="${escapeHtml(it.notionUrl)}" target="_blank" rel="noopener">Edit Draft ↗</a>
        <button class="btn ${it.featured ? 'amber' : 'purple'}" data-act="toggle-featured" data-id="${escapeHtml(it.id)}" data-val="${it.featured ? 'false' : 'true'}">${it.featured ? 'Unfeature' : 'Mark Featured'}</button>
        <button class="btn green" data-act="approve-publish" data-id="${escapeHtml(it.id)}">Approve for Publishing</button>
      </div>
      <div class="act-msg"></div>`;
  }

  // ── board ──────────────────────────────────────────────────────────────────
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
  async function loadErrors() {
    const root = view('errors');
    root.innerHTML = loading('Loading errors…');
    try {
      const data = await api('/errors');
      if (!data.items.length) { root.innerHTML = `<header class="page-head"><h1>Errors &amp; Exceptions</h1></header>${empty('No errors or rejections.')}`; return; }
      root.innerHTML = `<header class="page-head"><h1>Errors &amp; Exceptions</h1></header>
        <table class="tbl"><thead><tr><th>Title</th><th>Status</th><th>Last Error</th><th>Source</th></tr></thead>
        <tbody>${data.items.map((e) => `<tr>
          <td><a href="${escapeHtml(e.notionUrl)}" target="_blank" rel="noopener">${escapeHtml(e.title || 'Untitled')}</a></td>
          <td><span class="pill ${statusColor(e.status)}"></span>${escapeHtml(e.status || '')}</td>
          <td class="muted">${escapeHtml(e.lastError || '—')}</td>
          <td>${escapeHtml((e.source || []).join(', '))}</td></tr>`).join('')}</tbody></table>`;
    } catch (e) {
      root.innerHTML = errorState(e.message);
    }
  }

  // ── action handling (event delegation) ─────────────────────────────────────
  async function runAction(btn) {
    const act = btn.dataset.act;
    const pageId = btn.dataset.id;
    const msg = btn.closest('.detail-pane')?.querySelector('.act-msg');
    const body = { pageId };
    if (act === 'toggle-featured') body.value = btn.dataset.val === 'true';
    btn.disabled = true;
    if (msg) msg.innerHTML = loading('Working…');
    try {
      await api(`/actions/${act}`, { method: 'POST', body: JSON.stringify(body) });
      // Refresh the relevant list + badges.
      const o = await api('/overview'); state.overview = o; setBadges();
      if (act === 'toggle-featured') {
        await loadDrafts();
      } else if (view('queue').classList.contains('active')) {
        state.selectedQueue = null; await loadQueue();
      } else {
        state.selectedDraft = null; await loadDrafts();
      }
    } catch (e) {
      btn.disabled = false;
      if (msg) msg.innerHTML = errorState(e.message);
    }
  }

  // ── init ───────────────────────────────────────────────────────────────────
  function init() {
    document.body.addEventListener('click', (ev) => {
      const nav = ev.target.closest('[data-view]');
      if (nav) { ev.preventDefault(); switchView(nav.dataset.view); return; }
      const more = ev.target.closest('[data-load-more="drafts"]');
      if (more) { ev.preventDefault(); loadMoreDrafts(); return; }
      const row = ev.target.closest('.row');
      if (row) {
        const i = Number(row.dataset.i);
        if (view('queue').classList.contains('active')) { state.selectedQueue = i; renderQueue(); }
        else { state.selectedDraft = i; renderDrafts(); }
        return;
      }
      const actBtn = ev.target.closest('[data-act]');
      if (actBtn) { ev.preventDefault(); runAction(actBtn); }
    });
    switchView('dashboard');
  }

  document.addEventListener('DOMContentLoaded', init);
}
