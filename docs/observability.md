# Observability integration

Prometheus is the authoritative metric store and stays behind Cloudflare Access. Grafana is the detailed operator visualization layer and is also Access-protected.

## Runtime flow

- `GET /ops/api/observability` is authenticated by the existing `/ops` Cloudflare Access application.
- The Worker queries `PROMETHEUS_BASE_URL` using a Cloudflare Access service token read from the existing `CONTENT_KV["secrets"]` object.
- The frontend receives normalized target health, firing alert count, and CPU/memory/disk series.
- Grafana is linked as the authoritative detailed dashboard; it is never embedded because Grafana sends `X-Frame-Options: deny`.

## Configuration

Non-secret Worker variables:

- `PROMETHEUS_BASE_URL=https://prometheus.techfusionreport.com`
- `PROMETHEUS_TIMEOUT_MS=5000`
- `GRAFANA_BASE_URL=https://grafana.techfusionreport.com`

Secret fields in `CONTENT_KV["secrets"]`:

- `prometheus_access_client_id`
- `prometheus_access_client_secret`

Never expose the service token, raw Prometheus labels, scrape URLs, or query responses to the public Status application. Public Status uses a separate sanitized collector contract containing only aggregate target and alert counts plus freshness.
