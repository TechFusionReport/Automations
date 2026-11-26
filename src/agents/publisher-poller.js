import { computeSeoScore, readSeoFields } from '../utils/seo-score.js';
import { PublishingAgent } from './publishing.js';
import { CATALOG_PROPERTIES as P, CATALOG_STATUS as S } from '../utils/content-catalog.js';
import { notionClient, statusPatchBody, richTextPatchBody, numberPatchBody } from '../ops/notion.js';
import { verifyRecordReceipt } from '../ops/receipts.js';
import { hasReceiptKey, normalizePageId } from '../utils/ops-receipts.js';
import { describeError } from '../utils/safe-error.js';

const SEO_PASS_SCORE = 85;
const ELIGIBLE_STATUSES = [S.draftGenerated, S.draftReview, S.draftApproval];
const statusOf = page => page.properties?.[P.status]?.status?.name;
const isPublished = page => page.properties?.[P.publishedToGithub]?.checkbox === true || statusOf(page) === S.publishedToGithub;
const isCandidate = page => !isPublished(page) && page.properties?.[P.publishToGithub]?.checkbox === true
  && ELIGIBLE_STATUSES.includes(statusOf(page));

export class PublisherPoller {
  constructor(env) {
    this.env = env;
  }

  async getSecrets() {
    const raw = await this.env.CONTENT_KV.get('secrets');
    return raw ? JSON.parse(raw) : {};
  }

  configured() {
    return hasReceiptKey(this.env.OPS_RECEIPT_KEY) && typeof this.env.AGENT_STATE?.get === 'function';
  }

  async seoGate(client, page, body) {
    const props = page.properties || {};
    const fields = readSeoFields(props, body);
    const { seoTitle, seoSlug, seoMeta, focusKeyword, schemaType } = fields;
    const { score } = computeSeoScore(fields);
    if (props[P.seoScore]?.number !== score) {
      await client.patch(page.id, numberPatchBody(P.seoScore, score));
    }

    const missing = [];
    if (!seoTitle) missing.push('SEO title');
    if (!seoSlug) missing.push('SEO slug');
    if (!seoMeta) missing.push('meta description');
    if (!focusKeyword) missing.push('focus keyword');
    if (!schemaType) missing.push('schema type');

    return {
      passed: score >= SEO_PASS_SCORE && missing.length === 0,
      score,
      missing
    };
  }

  skip(reason) {
    console.warn(`Publisher Poller: skipped — ${reason}`);
    return { skipped: true, reason };
  }

  async recordFailure(client, pageId, error) {
    const message = `Publisher Poller: could not finish record: ${describeError(error)}`;
    console.error(message);
    if (!client || !normalizePageId(pageId)) return;
    try {
      await client.patch(pageId, richTextPatchBody(P.lastError, message));
    } catch {
      console.warn('Publisher Poller: could not write Last Error');
    }
  }

  async runSingle(pageId) {
    if (!this.configured()) return this.skip('unavailable');
    if (!normalizePageId(pageId)) return { skipped: true, reason: 'invalid_page' };
    let client;
    try {
      const secrets = await this.getSecrets();
      client = notionClient(secrets.notion_token || this.env.NOTION_TOKEN);
      return await this.publishPage(await client.retrieve(pageId), client, new PublishingAgent(this.env), secrets);
    } catch (error) {
      await this.recordFailure(client, pageId, error);
      throw new Error('Publisher could not finish record');
    }
  }

  async run() {
    const results = { processed: 0, blocked: 0, awaitingMerge: 0, skipped: 0, errors: 0 };
    if (!this.configured()) {
      this.skip('unavailable');
      return results;
    }

    let secrets;
    try {
      secrets = await this.getSecrets();
    } catch {
      console.error('Publisher Poller: configuration unavailable');
      results.errors++;
      return results;
    }
    const client = notionClient(secrets.notion_token || this.env.NOTION_TOKEN);
    const agent = new PublishingAgent(this.env);
    const databaseId = this.env.NOTION_DATABASE_ID || secrets.notion_database_id || '1fbbd080-de92-8043-89aa-dc02853c15c7';
    const filters = [
      { property: P.status, status: { equals: S.publishPrOpen } },
      { and: [
        { property: P.publishToGithub, checkbox: { equals: true } },
        { property: P.publishedToGithub, checkbox: { equals: false } },
        { or: ELIGIBLE_STATUSES.map(status => ({ property: P.status, status: { equals: status } })) },
      ] },
    ];
    let found = 0;
    for (const filter of filters) {
      let cursor;
      do {
        let data;
        try {
          data = await client.query(databaseId, { filter, page_size: 10, ...(cursor ? { start_cursor: cursor } : {}) });
        } catch {
          console.error('Publisher Poller: candidate query failed');
          results.errors++;
          break;
        }
        for (const page of data.results || []) {
          found++;
          try {
            const result = await this.publishPage(page, client, agent, secrets);
            if (result.processed) results.processed++;
            else if (result.blocked) results.blocked++;
            else if (result.awaitingMerge) results.awaitingMerge++;
            else if (result.errored) results.errors++;
            else results.skipped++;
          } catch (error) {
            results.errors++;
            await this.recordFailure(client, page.id, error);
          }
        }
        cursor = data.has_more ? data.next_cursor : null;
      } while (cursor);
    }

    await this.env.CONTENT_KV.put('last_publish_poll', JSON.stringify({
      timestamp: new Date().toISOString(), found, ...results,
    })).catch(() => console.warn('Publisher Poller: could not record poll summary'));
    return results;
  }

  async publishPage(page, client, agent, secrets) {
    if (isPublished(page)) return { skipped: true, reason: 'already_published' };
    const pageId = page.id;
    const props = page.properties || {};
    const pending = statusOf(page) === S.publishPrOpen || (isCandidate(page) && !!props[P.publishPrUrl]?.url);
    if (!pending && !isCandidate(page)) return { skipped: true, reason: 'ineligible' };

    async function verify(expectedHash, allowPending = false) {
      const proof = await verifyRecordReceipt(agent.env, client, pageId, 2, { snapshot: true });
      if (!proof.valid) return proof;
      const live = proof.page;
      const pendingIsEligible = allowPending && statusOf(live) === S.publishPrOpen
        && live.properties?.[P.publishToGithub]?.checkbox === true && !isPublished(live);
      if (!isCandidate(live) && !pendingIsEligible) return { valid: false, reason: 'ineligible' };
      return expectedHash && proof.hash !== expectedHash ? { valid: false, reason: 'content_changed' } : proof;
    }

    const guard = async (expectedHash, allowPending) => {
      const live = await verify(expectedHash, allowPending);
      if (live.valid && !(await this.seoGate(client, live.page, live.payload.content)).passed) return { valid: false, reason: 'seo_gate' };
      return live;
    };

    if (pending) {
      const number = agent.extractPRNumber(props[P.publishPrUrl]?.url);
      return agent.completePublishPR(pageId, number && await agent.getPRState(number, secrets), secrets, guard);
    }

    const proof = await verify();
    if (!proof.valid) return this.skip(proof.reason);

    const gate = await this.seoGate(client, proof.page, proof.payload.content);
    if (!gate.passed) {
      const reason = `Publishing blocked by SEO gate: score ${gate.score}/${SEO_PASS_SCORE}`
        + (gate.missing.length ? `; missing ${gate.missing.join(', ')}` : '');
      await client.patch(pageId, { ...statusPatchBody(S.draftReview), ...richTextPatchBody(P.lastError, reason) });
      return { blocked: true, reason, score: gate.score, missing: gate.missing };
    }

    return agent.publish({ ...proof.payload, notionPageId: pageId }, { secrets, hash: proof.hash, verify: guard });
  }
}
