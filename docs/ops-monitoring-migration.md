# Monitoring migration — implementation and rollout

## Objective
Move WireGuard, Nodes, n8n, and LAN Watchtower into the Access-protected /ops Infrastructure view, then retire status and status-api without losing monitoring.

## Architecture
Oracle's existing collector runs internal WireGuard/Docker probes, generates status.json, and POSTs a snapshot every **5 minutes** to /ops/api/monitoring/ingest. A **separate, exact-path Cloudflare Access application** must protect ingestion with a dedicated Service Auth policy and token. The Worker additionally validates a distinct bearer secret, timestamp and payload, strips identifying addresses and peer metadata, then stores a sanitized snapshot in CONTENT_KV. The browser only GETs /ops/api/legacy-monitoring through the existing interactive Access application. **Stale = older than 15 minutes**; stale snapshots remain visible as last-known data.

## Checklist and gates
- [x] Add Worker KV snapshot ingest/read code in Automations preview.
- [x] Add /ops frontend panels and stale-state indicator in Website preview.
- [ ] Verify current Workers plan and KV quota. Free allows 1,000 writes/day; 5-minute cadence = 288 writes/day plus other existing KV writes.
- [ ] Create **separate** Access application for exact /ops/api/monitoring/ingest path with Service Auth only; verify precedence, 401/403 without token, and POST succeeds only with Access token AND distinct bearer secret.
- [ ] Provision unique ingest service token and Worker MONITORING_INGEST_SECRET via secret management; store credentials in Oracle protected environment, never Git.
- [ ] Update Oracle collect.py probes to use WireGuard IPs/Docker service names and require semantic health responses (not merely HTTP <500); remove defunct LibreChat probe. Keep peer-key map, IPs, webhook URL and secrets outside public repositories.
- [ ] Authenticate LAN Watchtower webhook (separate credential) or make it internal; reject anonymous/fake submissions.
- [ ] Set Oracle cron to send only fresh snapshots at 5-minute cadence; implement retries with bounded backoff, no secret logging.
- [ ] Test malformed payload, old/future timestamps, duplicate/out-of-order snapshots, missing sections, unauthorized requests, KV errors, XSS-safe rendering, Oracle outage >15 minutes, and restoration.
- [ ] Verify no remaining runtime callers of public status-api URL (including Cloudflare env, Oracle cron, n8n and any website JS).
- [ ] Review both PRs and CI, deploy behind Access, observe a complete reporting cycle and outage simulation.
- [ ] Only after verification, remove status DNS/Pages and public status-api tunnel/DNS, and archive or privatize command-center repo. Preserve any internal collector required for push.
- [ ] Separately revisit Public sites Access application for www and cookbook.

## Safety
Do not merge or retire infrastructure until security controls, Oracle probes, and live data flow are verified. No secrets, peer keys, internal/public IPs, or webhook URLs belong in the public repositories.
