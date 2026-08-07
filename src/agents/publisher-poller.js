// Publisher Poller — TechFusion Report
// Publishes only records explicitly approved for publishing AND still passing
// the SEO gate. Manual status changes cannot bypass missing/low-quality SEO.

import { PublishingAgent } from './publishing.js';
import { CATALOG_PROPERTIES, CATALOG_STATUS } from '../utils/content-catalog.js';

const SEO_PASS_SCORE = 85;

export class PublisherPoller {
  constructor(env) {
    this.env = env;
  }

  async getSecrets() {
    const raw = await this.env.CONTENT_KV.get('secrets');
    return raw ? JSON.parse(raw) : {};
  }

  readRichText(property) {
    return property?.rich_text?.map(r => r.plain_text || r.text?.content || '').join('').trim() || '';
  }

  seoGate(props) {
    const score = Number(props[CATALOG_PROPERTIES.seoScore]?.number || 0);
    const seoTitle = this.readRichText(props[CATALOG_PROPERTIES.seoTitle]);
    const seoSlug = this.readRichText(props[CATALOG_PROPERTIES.seoSlug]);
    const seoMeta = this.readRichText(props[CATALOG_PROPERTIES.seoMeta]);
    const focusKeyword = this.readRichText(props[CATALOG_PROPERTIES.focusKeyword]);
    const schemaType = props[CATALOG_PROPERTIES.schemaType]?.select?.name || '';

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

  async runSingle(pageId) {
    const secrets = await this.getSecrets();
    const token = secrets.notion_token || this.env.NOTION_TOKEN;

    const pageRes = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      headers: { 'Authorization': `Bearer ${token}`, 'Notion-Version': '2022-06-28' }
    });

    if (!pageRes.ok) throw new Error(`Failed to fetch page ${pageId}: ${await pageRes.text()}`);

    const page = await pageRes.json();
    return await this.publishPage(page, token, secrets);
  }

  async run() {
    const secrets = await this.getSecrets();
    const token = secrets.notion_token || this.env.NOTION_TOKEN;
    const databaseId = secrets.notion_database_id || '1fbbd080-de92-8043-89aa-dc02853c15c7';

    console.log('Publisher Poller: checking for records approved to publish...');

    const response = await fetch(`https://api.notion.com/v1/databases/${databaseId}/query`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28'
      },
      body: JSON.stringify({
        page_size: 10,
        filter: {
          property: CATALOG_PROPERTIES.status,
          status: { equals: CATALOG_STATUS.publishApproved }
        }
      })
    });

    if (!response.ok) {
      console.error('Publisher Poller: Notion query failed:', await response.text());
      return { processed: 0, blocked: 0, errors: [] };
    }

    const data = await response.json();
    const records = data.results || [];
    console.log(`Publisher Poller: found ${records.length} records to publish`);

    if (records.length === 0) {
      await this.env.CONTENT_KV.put('last_publish_poll', JSON.stringify({
        timestamp: new Date().toISOString(), found: 0, processed: 0, blocked: 0, errors: []
      }));
      return { processed: 0, blocked: 0, errors: [] };
    }

    const results = { processed: 0, blocked: 0, errors: [] };

    for (const record of records) {
      try {
        const result = await this.publishPage(record, token, secrets);
        if (result?.blocked) results.blocked++;
        else results.processed++;
      } catch (error) {
        const title = record.properties?.[CATALOG_PROPERTIES.title]?.title?.[0]?.text?.content || record.id;
        console.error(`Publisher Poller: error publishing "${title}":`, error);
        results.errors.push({ pageId: record.id, title, error: error.message });
        await this.writeError(record.id, error.message, token);
      }
    }

    await this.env.CONTENT_KV.put('last_publish_poll', JSON.stringify({
      timestamp: new Date().toISOString(),
      found: records.length,
      ...results
    }));

    return results;
  }

  async publishPage(page, token, secrets) {
    const pageId = page.id;
    const props = page.properties || {};
    const title = props[CATALOG_PROPERTIES.title]?.title?.[0]?.text?.content || 'Untitled';
    const gate = this.seoGate(props);

    if (!gate.passed) {
      const reason = `Publishing blocked by SEO gate: score ${gate.score}/${SEO_PASS_SCORE}` +
        (gate.missing.length ? `; missing ${gate.missing.join(', ')}` : '');
      console.warn(`Publisher Poller: ${reason} for "${title}"`);
      await this.writeSeoReview(pageId, reason, token);
      return { blocked: true, reason, score: gate.score, missing: gate.missing };
    }

    console.log(`Publisher Poller: publishing "${title}" (${pageId}), SEO score ${gate.score}`);

    const content = await this.readBlogDraft(pageId, token);
    if (!content) throw new Error('No blog draft found — run Enhancement agent first');

    const agent = new PublishingAgent(this.env);
    const result = await agent.publish({
      notionPageId: pageId,
      title,
      content,
      category: props[CATALOG_PROPERTIES.category]?.select?.name || 'General',
      section: props[CATALOG_PROPERTIES.subcategory]?.select?.name || 'Technology',
      tags: props[CATALOG_PROPERTIES.tags]?.multi_select?.map(t => t.name) || [],
      featured: props[CATALOG_PROPERTIES.featured]?.checkbox || false,
      seoTitle: this.readRichText(props[CATALOG_PROPERTIES.seoTitle]) || title,
      seoSlug: this.readRichText(props[CATALOG_PROPERTIES.seoSlug]) || null,
      seoMeta: this.readRichText(props[CATALOG_PROPERTIES.seoMeta]) || null,
      schemaType: props[CATALOG_PROPERTIES.schemaType]?.select?.name || 'Article',
      jsonLd: this.readRichText(props[CATALOG_PROPERTIES.jsonLd]) || null,
      internalLinks: this.readRichText(props[CATALOG_PROPERTIES.internalLinks]) || null,
      focusKeyword: this.readRichText(props[CATALOG_PROPERTIES.focusKeyword]) || null,
      imageAltText: this.readRichText(props[CATALOG_PROPERTIES.imageAltText]) || null
    });

    console.log(`Publisher Poller: ✅ published "${title}"`);
    return result;
  }

  async readBlogDraft(pageId, token) {
    const blocksRes = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children?page_size=50`, {
      headers: { 'Authorization': `Bearer ${token}`, 'Notion-Version': '2022-06-28' }
    });

    if (blocksRes.ok) {
      const blocks = await blocksRes.json();
      for (const block of blocks.results || []) {
        if (block.type === 'toggle') {
          const label = block.toggle?.rich_text?.[0]?.text?.content || '';
          if (label.includes('TFR BLOG DRAFT') || label.includes('BLOG DRAFT')) {
            const childRes = await fetch(`https://api.notion.com/v1/blocks/${block.id}/children`, {
              headers: { 'Authorization': `Bearer ${token}`, 'Notion-Version': '2022-06-28' }
            });
            if (childRes.ok) {
              const children = await childRes.json();
              const blockContent = (children.results || [])
                .filter(b => b.type === 'paragraph')
                .map(b => b.paragraph?.rich_text?.map(r => r.text?.content || '').join('') || '')
                .join('\n\n').trim();
              if (blockContent && blockContent.length > 200 && !blockContent.includes('populates here after enhancement')) return blockContent;
            }
          }
        }
      }
    }

    const pageRes = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      headers: { 'Authorization': `Bearer ${token}`, 'Notion-Version': '2022-06-28' }
    });
    if (pageRes.ok) {
      const page = await pageRes.json();
      const draft = this.readRichText(page.properties?.[CATALOG_PROPERTIES.blogDraft]);
      if (draft) return draft;
    }

    return null;
  }

  async writeSeoReview(pageId, reason, token) {
    const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28'
      },
      body: JSON.stringify({
        properties: {
          [CATALOG_PROPERTIES.status]: { status: { name: CATALOG_STATUS.draftReview } },
          [CATALOG_PROPERTIES.lastError]: { rich_text: [{ text: { content: reason.substring(0, 2000) } }] }
        }
      })
    });
    if (!res.ok) console.warn(`Publisher Poller: could not move ${pageId} to SEO review: ${await res.text()}`);
  }

  async writeError(pageId, errorMessage, token) {
    await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28'
      },
      body: JSON.stringify({
        properties: {
          [CATALOG_PROPERTIES.status]: { status: { name: CATALOG_STATUS.errors } },
          [CATALOG_PROPERTIES.lastError]: { rich_text: [{ text: { content: errorMessage.substring(0, 2000) } }] }
        }
      })
    });
  }
}
