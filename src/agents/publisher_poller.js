// Publisher Poller — TechFusion Report
// Runs on a cron schedule AND via manual trigger.
// Queries Content Catalog v2 for records where:
//   🚀 Publish to GitHub = true AND ✅ Published To Github = false
// For each match, reads the blog draft and fires the PublishingAgent.
//
// runSingle(pageId) — for manual trigger via /admin/publish-single endpoint
// run()             — called by the 30-min cron sweep

import { PublishingAgent } from './publishing.js';

export class PublisherPoller {
  constructor(env) {
    this.env = env;
  }

  async getSecrets() {
    const raw = await this.env.CONTENT_KV.get('secrets');
    return raw ? JSON.parse(raw) : {};
  }

  // ─── Run a single page by ID ─────────────────────────────────────────────

  async runSingle(pageId) {
    const secrets = await this.getSecrets();
    const token   = secrets.notion_token || this.env.NOTION_TOKEN;

    const pageRes = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Notion-Version': '2022-06-28'
      }
    });

    if (!pageRes.ok) {
      const err = await pageRes.text();
      throw new Error(`Failed to fetch page ${pageId}: ${err}`);
    }

    const page = await pageRes.json();
    return await this.publishPage(page, token, secrets);
  }

  // ─── Sweep all unpublished records ──────────────────────────────────────

  async run() {
    const secrets     = await this.getSecrets();
    const token       = secrets.notion_token || this.env.NOTION_TOKEN;
    const databaseId  = secrets.notion_database_id || '1fbbd080-de92-8043-89aa-dc02853c15c7';

    console.log('Publisher Poller: checking for records ready to publish...');

    const response = await fetch(
      `https://api.notion.com/v1/databases/${databaseId}/query`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Notion-Version': '2022-06-28'
        },
        body: JSON.stringify({
          page_size: 10,
          filter: {
            and: [
              { property: '🚀 Publish to GitHub', checkbox: { equals: true } },
              { property: '✅ Published To Github', checkbox: { equals: false } }
            ]
          }
        })
      }
    );

    if (!response.ok) {
      console.error('Publisher Poller: Notion query failed:', await response.text());
      return { processed: 0, errors: [] };
    }

    const data    = await response.json();
    const records = data.results || [];

    console.log(`Publisher Poller: found ${records.length} records ready to publish`);

    if (records.length === 0) {
      await this.env.CONTENT_KV.put('last_publish_poll', JSON.stringify({
        timestamp: new Date().toISOString(),
        found: 0,
        processed: 0,
        errors: []
      }));
      return { processed: 0, errors: [] };
    }

    const results = { processed: 0, errors: [] };

    for (const record of records) {
      try {
        await this.publishPage(record, token, secrets);
        results.processed++;
      } catch (error) {
        const title = record.properties?.Title?.title?.[0]?.text?.content || record.id;
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

  // ─── Core publish logic for a single page ───────────────────────────────

  async publishPage(page, token, secrets) {
    const pageId  = page.id;
    const props   = page.properties || {};
    const title   = props?.Title?.title?.[0]?.text?.content || 'Untitled';

    console.log(`Publisher Poller: publishing "${title}" (${pageId})`);

    const content = await this.readBlogDraft(pageId, token);

    if (!content) {
      throw new Error('No blog draft content found — run Enhancement agent first');
    }

    const category  = props['🗂️ Category']?.select?.name  || 'General';
    const section   = props['🗂️ Section']?.select?.name   || 'Technology';
    const tags      = props['🔖 Tags']?.multi_select?.map(t => t.name) || [];
    const featured  = props.Featured?.checkbox             || false;
    const videoUrl  = props['🎬 Video URL']?.url           || null;
    const thumbnail = props['🖼️ Thumbnail']?.url          || null;

    const agent = new PublishingAgent(this.env);
    const result = await agent.publish({
      notionPageId: pageId,
      title,
      content,
      category,
      section,
      tags,
      featured,
      videoUrl,
      thumbnail
    });

    console.log(`Publisher Poller: ✅ published "${title}"`);
    return result;
  }

  // ─── Read Blog Draft from Page Blocks ───────────────────────────────────
  // Tries the ⚡ TFR BLOG DRAFT toggle first, falls back to 📝 Blog Draft property.

  async readBlogDraft(pageId, token) {
    // 1. Try the template toggle block
    const blocksRes = await fetch(
      `https://api.notion.com/v1/blocks/${pageId}/children?page_size=50`,
      { headers: { 'Authorization': `Bearer ${token}`, 'Notion-Version': '2022-06-28' } }
    );

    if (blocksRes.ok) {
      const blocks = await blocksRes.json();

      for (const block of blocks.results || []) {
        if (block.type === 'toggle') {
          const label = block.toggle?.rich_text?.[0]?.text?.content || '';
          if (label.includes('TFR BLOG DRAFT') || label.includes('BLOG DRAFT')) {

            const childRes = await fetch(
              `https://api.notion.com/v1/blocks/${block.id}/children`,
              { headers: { 'Authorization': `Bearer ${token}`, 'Notion-Version': '2022-06-28' } }
            );

            if (childRes.ok) {
              const children = await childRes.json();
              const content = (children.results || [])
                .filter(b => b.type === 'paragraph')
                .map(b => b.paragraph?.rich_text?.map(r => r.text?.content || '').join('') || '')
                .join('\n\n')
                .trim();

              if (content) return content;
            }
          }
        }
      }
    }

    // 2. Fallback: read from 📝 Blog Draft property
    const pageRes = await fetch(
      `https://api.notion.com/v1/pages/${pageId}`,
      { headers: { 'Authorization': `Bearer ${token}`, 'Notion-Version': '2022-06-28' } }
    );

    if (pageRes.ok) {
      const page = await pageRes.json();
      const draft = page.properties?.['📝 Blog Draft']?.rich_text
        ?.map(r => r.text?.content || '').join('').trim();
      if (draft) return draft;
    }

    return null;
  }

  // ─── Write error back to Notion record ──────────────────────────────────

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
          'Status':        { status: { name: '❌ Publish Failed' } },
          '⚠️ Last Error': { rich_text: [{ text: { content: errorMessage.substring(0, 2000) } }] }
        }
      })
    });
  }
}
