// Enhancement Poller — TechFusion Report
// Queries Content Catalog v2 every 30 min for records where:
//   Status = "🟡 Pending Review"
// Marks as "In Progress" immediately to prevent double-processing,
// then fires the EnhancementAgent. On completion sets "Draft Generated".

import { EnhancementOrchestrator as EnhancementAgent } from './enhancement.js';

export class EnhancementPoller {
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
      headers: { 'Authorization': `Bearer ${token}`, 'Notion-Version': '2022-06-28' }
    });

    if (!pageRes.ok) throw new Error(`Failed to fetch page ${pageId}: ${await pageRes.text()}`);

    const page = await pageRes.json();
    return await this.enhancePage(page, token);
  }

  // ─── Sweep all records pending enhancement ───────────────────────────────

  async run() {
    const secrets    = await this.getSecrets();
    const token      = secrets.notion_token || this.env.NOTION_TOKEN;
    const databaseId = secrets.notion_database_id || '1fbbd080-de92-8043-89aa-dc02853c15c7';

    console.log('Enhancement Poller: checking for records ready to enhance...');

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
          page_size: 5, // small batches — enhancement is Gemini-heavy
          filter: {
            property: 'Status',
            status: { equals: '🟡 Pending Review' }
          }
        })
      }
    );

    if (!response.ok) {
      console.error('Enhancement Poller: Notion query failed:', await response.text());
      return { processed: 0, errors: [] };
    }

    const data    = await response.json();
    const records = data.results || [];

    console.log(`Enhancement Poller: found ${records.length} records to enhance`);

    if (records.length === 0) {
      await this.env.CONTENT_KV.put('last_enhance_poll', JSON.stringify({
        timestamp: new Date().toISOString(), found: 0, processed: 0, errors: []
      }));
      return { processed: 0, errors: [] };
    }

    const results = { processed: 0, errors: [] };

    for (const record of records) {
      const pageId = record.id;
      const title  = record.properties?.Title?.title?.[0]?.text?.content || pageId;

      try {
        console.log(`Enhancement Poller: enhancing "${title}"`);

        // Mark In Progress immediately to prevent double-processing on next poll
        await this.setStatus(pageId, 'In progress', token);

        await this.enhancePage(record, token);
        results.processed++;
        console.log(`Enhancement Poller: ✅ enhanced "${title}"`);

      } catch (error) {
        console.error(`Enhancement Poller: error on "${title}":`, error);
        results.errors.push({ pageId, title, error: error.message });
        await this.writeError(pageId, error.message, token);
      }
    }

    await this.env.CONTENT_KV.put('last_enhance_poll', JSON.stringify({
      timestamp: new Date().toISOString(),
      found: records.length,
      ...results
    }));

    return results;
  }

  // ─── Core enhance logic ──────────────────────────────────────────────────

  async enhancePage(page, token) {
    const pageId = page.id;
    const props  = page.properties || {};

    const agent = new EnhancementAgent(this.env);
    const result = await agent.start({
      notionPageId: pageId,
      videoUrl: props['🎬 Video URL']?.url,
      category: props['🗂️ Category']?.select?.name,
      section:  props['🗂️ Section']?.select?.name,
      tags:     props['🔖 Tags']?.multi_select?.map(t => t.name) || []
    });

    // Mark as Draft Generated on success
    await this.setStatus(pageId, 'Draft Generated', token);
    return result;
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  async setStatus(pageId, statusName, token) {
    await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28'
      },
      body: JSON.stringify({
        properties: { 'Status': { status: { name: statusName } } }
      })
    });
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
          'Status':        { status: { name: '❌ Errors' } },
          '⚠️ Last Error': { rich_text: [{ text: { content: errorMessage.substring(0, 2000) } }] }
        }
      })
    });
  }
}
