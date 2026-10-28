# /ops readiness audit — 2026-10-04 UTC

## Release target

One item authorized through /ops, processed by n8n, reviewed, published once,
and verified live, with its history visible in /ops. No production mutations
or test publications were made during this initial audit.

## Verified evidence

- Automations #57 (private/no-store JSON responses) merged September 15.
- Automations #58 (checkbox approvals separate from Status) merged September 16.
- Audited Automations main: e1057a245376820d9353679d32bf86ac30b3ae3a.
- Cloudflare techfusion-api active version: 2722c553-f5d0-4071-8fdc-78b4a7a19db2,
  deployed September 28 at 15:56 UTC, serving 100% of traffic.
- Cloudflare website active version: 85aa5331-c80b-44e5-955b-0f9b32788022,
  deployed September 27 at 23:05 UTC, serving 100% of traffic.
- Deployment metadata does not establish the exact source commit or prove runtime behavior.
- n8n /healthz and extractor /healthz returned HTTP 200 from this environment.
  These checks establish reachability, not workflow or extraction correctness.
- Worker health, Worker ops overview, and public status URL returned HTTP 403.
  Authenticated behavior and response headers remain unverified; the 403 responses
  cannot be attributed to application authorization without further evidence.
- The production /ops page request timed out from this environment.

## Prioritized gaps

| Priority | Finding | Completion evidence |
| --- | --- | --- |
| P0 | Current source still invokes Worker PublisherPoller on the live configured 30-minute cron; intended Publisher owner is n8n. | Verify active n8n Publisher, inspect deployed Worker source, then retire duplicate Worker publishing routes/queue processing and the publishing-only cron while retaining unrelated jobs. |
| P0 | No n8n connector available in this session. | Read active workflow versions and recent executions through authorized access; verify approvals, retry cap, extraction context, publishing idempotency, and live-site verification. |
| P1 | Overview reads last_enhance_poll and other Worker heartbeat keys after enhancement retirement. Missing/stale heartbeats can still aggregate to healthy. | Use actual n8n execution telemetry; expose unknown/stale states and test unavailable telemetry. |
| P1 | Monthly publication KPI counts only the five recent articles. | This branch queries the complete month with pagination; retain the five-item recent list separately. |
| P1 | Authenticated /ops rendering and API behavior not verified. | Exercise overview, review, actions, mobile layouts, progress, and stale/error states in an authorized session. |
| P1 | Deployment versions are not mapped to source commits. | Record source revision in deployment metadata and establish parity with production assets and API behavior. |

## Next release gates

1. Establish authenticated production visibility and active n8n workflow evidence.
2. Resolve publishing ownership and replace legacy health telemetry.
3. Trace a controlled production item through both authorization gates.
4. Verify extraction fallback, quality rejection, capped recovery, terminal rejection,
   duplicate prevention, and live article verification.
5. Finish progress, review, mobile, and failure-state UI against observed API contracts.
6. Confirm backup restoration and rollback procedures, then observe a limited batch
   for seven days before declaring readiness.

## Scope of this branch

Audit findings plus the monthly KPI correction. Production schedules, workflows,
credentials, and deployed code were not changed. All additional source findings
require runtime validation before being described as production behavior.
