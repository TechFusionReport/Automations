// Access-gated monitoring panels. All external values are escaped.
import { escapeHtml, timeAgo } from './ops.js';
const esc = escapeHtml;
const badge = (ok) => `<span class="badge ${ok ? 'ok' : 'down'}">${ok ? 'Online' : 'Offline'}</span>`;
const table = (head, rows, cols) => `<div class="monitor-scroll"><table class="tbl"><thead><tr>${head.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.length ? rows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${cols}" class="muted">No data reported</td></tr>`}</tbody></table></div>`;
const panel = (title, body) => `<section class="panel monitor-panel"><div class="section-head"><h2>${title}</h2></div>${body}</section>`;
export function renderMonitoring(data) {
  if (!['ok', 'stale'].includes(data?.status)) return panel('Network & automation monitoring', `<p class="muted">Unavailable: ${esc(data?.reason || 'No collector data')}</p>`);
  const nodes = Array.isArray(data.nodes) ? data.nodes : [];
  const peers = Array.isArray(data.wireguard?.peers) ? data.wireguard.peers : [];
  const workflows = Array.isArray(data.n8n?.workflows) ? data.n8n.workflows : [];
  const checks = Array.isArray(data.lan_watchtower?.checks) ? data.lan_watchtower.checks : [];
  return `<div class="monitor-heading"><h2>Network & automation</h2><span class="mono muted">${data.status === 'stale' ? 'STALE · LAST KNOWN STATE · ' : 'Fresh · '}Collector: ${esc(timeAgo(data.generatedAt))} ago</span></div>
  ${panel('WireGuard · ' + esc(data.wireguard?.hub || 'Hub unavailable'), table(['Peer','Connected','Latest handshake','Received','Sent'], peers.map(p => [esc(p.node_id),badge(p.connected),esc(p.latest_handshake || '—'),esc(p.transfer_rx_bytes ?? '—') + ' B',esc(p.transfer_tx_bytes ?? '—') + ' B']),5))}
  ${panel('Nodes', table(['Node','Role','Reachable','Services'],nodes.map(n=>[esc(n.label || n.id),esc(n.role),badge(n.reachable),(n.services || []).map(s=>`${esc(s.name)}: ${esc(s.status)} (${esc(s.latency_ms ?? '—')}ms)`).join('<div></div>') || '—']),4))}
  ${panel('n8n · ' + esc(data.n8n?.host || 'Host unavailable'), `<p>Host: ${badge(data.n8n?.reachable)}</p>` + table(['Workflow','Active'],workflows.map(w=>[esc(w.name),badge(w.active)]),2))}
  ${panel('LAN Watchtower', `<p>Probe: ${badge(data.lan_watchtower?.probe_online)} · Health: ${badge(data.lan_watchtower?.healthy)} · Incident: ${data.lan_watchtower?.incident_open ? 'OPEN' : 'None reported'} · Failures: ${esc(data.lan_watchtower?.failure_count ?? '—')} · Wi-Fi: ${esc(data.lan_watchtower?.wifi_signal_dbm ?? '—')} dBm · Last seen: ${esc(data.lan_watchtower?.last_seen || '—')}</p>` + table(['Check','OK','Required','Latency','Loss'],checks.map(c=>[esc(c.name),badge(c.ok),c.required?'Yes':'No',esc(c.latency_avg_ms ?? '—')+' ms',esc(c.packet_loss_pct ?? '—')+'%']),5))}`;
}
