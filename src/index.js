// TechFusion Report — Cloudflare Worker Entry Point
// Imports agents from separate files rather than inlining them.
// All business logic lives in src/agents/ and src/utils/.

import DiscoveryAgent from './agents/discovery.js';
import { EnhancementOrchestrator as EnhancementAgent } from './agents/enhancement.js';
import { PublishingAgent } from './agents/publishing.js';

// ─── Simple Router ───────────────────────────────────────────────────────────

class Router {
  constructor() {
    this.routes = new Map();
  }

  get(path, handler)    { this.routes.set(`GET:${path}`, handler); }
  post(path, handler)   { this.routes.set(`POST:${path}`, handler); }
  delete(path, handler) { this.routes.set(`DELETE:${path}`, handler); }

  async handle(request, env) {
    const url = new URL(request.url);
    const key = `${request.method}:${url.pathname}`;
    const handler = this.routes.get(key);

    if (!handler) return new Response('Not Found', { status: 404 });

    try {
      return await handler(request, env);
    } catch (error) {
      console.error('Router error:', error);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function getSecrets(env) {
  const raw = await env.CONTENT_KV.get('secrets');
  return raw ? JSON.parse(raw) : {};
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

// ─── Main Export ─────────────────────────────────────────────────────────────

export default {

  // ── HTTP Handler ────────────────────────────────────────────────────────────

  async fetch(request, env, ctx) {
    const router = new Router();

    // ── Discovery ──────────────────────────────────────────────────────────
    router.post('/discover', async (req, env) => {
      const agent = new DiscoveryAgent(env);
      return await agent.run();
    });

    // ── Enhancement ────────────────────────────────────────────────────────
    router.post('/enhance', async (req, env) => {
      const data = await req.json();
      const agent = new EnhancementAgent(env);
      return await agent.start(data);
    });

    // ── Publishing ─────────────────────────────────────────────────────────
    router.post('/publish', async (req, env) => {
      const data = await req.json();
      const agent = new PublishingAgent(env);
      return await agent.publish(data);
    });

    // ── Admin: Channel Management ──────────────────────────────────────────
    router.get('/admin/channels', async (req, env) => {
      const channels = await env.CONTENT_KV.get('channels_config');
      return new Response(channels || '[]', {
        headers: { 'Content-Type': 'application/json' }
      });
    });

    router.post('/admin/channels', async (req, env) => {
      const channels = await req.json();
      if (!Array.isArray(channels)) {
        return json({ error: 'Must be an array' }, 400);
      }
      await env.CONTENT_KV.put('channels_config', JSON.stringify(channels));
      return json({ status: 'saved', count: channels.length });
    });

    router.post('/admin/channels/refresh', async (req, env) => {
      try {
        const response = await fetch(
          'https://raw.githubusercontent.com/TechFusionReport/Automations/main/config/channels.json'
        );
        const channels = await response.json();
        await env.CONTENT_KV.put('channels_config', JSON.stringify(channels));
        return json({ status: 'refreshed', count: channels.length });
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    });

    router.post('/admin/creators/refresh', async (req, env) => {
      const agent = new DiscoveryAgent(env);
      await agent.invalidateCreatorCache();
      await agent.loadCreatorCache({});
      return json({ status: 'creators refreshed' });
    });

    // ── Admin: Channel Score Leaderboard ───────────────────────────────────
    router.get('/admin/channel-scores', async (req, env) => {
      const list = await env.CONTENT_KV.list({ prefix: 'channel-score:' });
      const scores = await Promise.all(
        list.keys.map(async k => {
          const raw = await env.CONTENT_KV.get(k.name);
          const data = raw ? JSON.parse(raw) : {};
          return { channelId: k.name.replace('channel-score:', ''), ...data };
        })
      );
      scores.sort((a, b) => (b.publishCount || 0) - (a.publishCount || 0));
      return json(scores);
    });

    // ── Revenue Tracking ───────────────────────────────────────────────────
    router.post('/analytics/revenue', async (req, env) => {
      const { slug, views, estimatedAdRevenue, affiliateClicks, sponsorName, revenueType } =
        await req.json();

      const key = `article:${slug}`;
      const existing = await env.CONTENT_KV.get(key);
      if (!existing) return json({ error: 'Article not found' }, 404);

      const article = JSON.parse(existing);
      const updated = {
        ...article,
        views:               views               ?? article.views,
        estimatedAdRevenue:  estimatedAdRevenue  ?? article.estimatedAdRevenue,
        affiliateClicks:     affiliateClicks     ?? article.affiliateClicks,
        sponsorName:         sponsorName         ?? article.sponsorName,
        revenueType:         revenueType         ?? article.revenueType,
        lastRevenueUpdate:   new Date().toISOString()
      };

      await env.CONTENT_KV.put(key, JSON.stringify(updated));
      return json({ status: 'updated', slug });
    });

    router.get('/analytics/revenue', async (req, env) => {
      const list = await env.CONTENT_KV.list({ prefix: 'article:' });
      const articles = (
        await Promise.all(list.keys.map(async k => {
          const raw = await env.CONTENT_KV.get(k.name);
          return raw ? JSON.parse(raw) : null;
        }))
      ).filter(Boolean);

      const summary = {
        totalArticles:        articles.length,
        totalViews:           articles.reduce((s, a) => s + (a.views || 0), 0),
        totalAdRevenue:       articles.reduce((s, a) => s + (a.estimatedAdRevenue || 0), 0),
        totalAffiliateClicks: articles.reduce((s, a) => s + (a.affiliateClicks || 0), 0),
        byCategory:    {},
        byRevenueType: {},
        topByViews: [...articles]
          .sort((a, b) => (b.views || 0) - (a.views || 0))
          .slice(0, 10)
          .map(a => ({ slug: a.slug, title: a.title, views: a.views, revenue: a.estimatedAdRevenue }))
      };

      for (const a of articles) {
        const cat = a.category || 'Unknown';
        if (!summary.byCategory[cat]) summary.byCategory[cat] = { articles: 0, views: 0, revenue: 0 };
        summary.byCategory[cat].articles++;
        summary.byCategory[cat].views   += a.views || 0;
        summary.byCategory[cat].revenue += a.estimatedAdRevenue || 0;

        const rt = a.revenueType || 'none';
        summary.byRevenueType[rt] = (summary.byRevenueType[rt] || 0) + 1;
      }

      return json(summary);
    });

    // ── Status & Health ────────────────────────────────────────────────────
    router.get('/status', async (req, env) => {
      const lastDiscovery = await env.CONTENT_KV.get('last_discovery');
      const channels      = await env.CONTENT_KV.get('channels_config');
      const creators      = await env.CONTENT_KV.get('creator_cache');

      return json({
        status:         'operational',
        lastDiscovery:  lastDiscovery ? JSON.parse(lastDiscovery) : null,
        channelsLoaded: channels  ? JSON.parse(channels).length  : 0,
        creatorsCached: creators  ? JSON.parse(creators).length  : 0,
        timestamp:      new Date().toISOString()
      });
    });

    router.get('/health', async () => {
      return json({ status: 'healthy', version: '4.0.0', uptime: Date.now() });
    });

    // ── Webhooks ───────────────────────────────────────────────────────────
    router.post('/webhook/notion', async (req, env) => {
      const payload = await req.json();

      if (payload.type === 'page.updated') {
        const pageId = payload.page.id;
        const status = payload.page.properties?.Status?.status?.name
                    || payload.page.properties?.Status?.select?.name;

        if (status === 'Ready to Enhance') {
          const agent = new EnhancementAgent(env);
          return await agent.start({
            notionPageId: pageId,
            videoUrl:  payload.page.properties?.['🎬 Video URL']?.url,
            category:  payload.page.properties?.['🗂️ Category']?.select?.name,
            section:   payload.page.properties?.['🗂️ Section']?.select?.name,
            tags:      payload.page.properties?.['🔖 Tags']?.multi_select?.map(t => t.name) || []
          });
        }

        if (status === 'Ready to Publish') {
          const agent = new PublishingAgent(env);
          return await agent.publish({
            notionPageId: pageId,
            title:    payload.page.properties?.Title?.title?.[0]?.text?.content,
            category: payload.page.properties?.['🗂️ Category']?.select?.name,
            section:  payload.page.properties?.['🗂️ Section']?.select?.name,
            tags:     payload.page.properties?.['🔖 Tags']?.multi_select?.map(t => t.name) || [],
            featured: payload.page.properties?.Featured?.checkbox || false
          });
        }
      }

      return new Response('Webhook processed', { status: 200 });
    });

    router.post('/webhook/github', async (req, env) => {
      const payload = await req.json();
      if (payload.ref === 'refs/heads/main' && payload.commits) {
        for (const commit of payload.commits) {
          if (commit.message.includes('[refresh-channels]')) {
            const agent = new DiscoveryAgent(env);
            await agent.loadConfig();
            console.log('Channels refreshed via GitHub webhook');
          }
        }
      }
      return new Response('GitHub webhook processed', { status: 200 });
    });

    // ── Batch Operations ───────────────────────────────────────────────────
    router.post('/batch/enhance', async (req, env) => {
      const { pageIds } = await req.json();
      const secrets = await getSecrets(env);
      const token = secrets.notion_token || env.NOTION_TOKEN;
      const results = [];

      for (const pageId of pageIds) {
        try {
          const notionRes = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
            headers: {
              'Authorization': `Bearer ${token}`,
              'Notion-Version': '2022-06-28'
            }
          });
          if (!notionRes.ok) continue;

          const page = await notionRes.json();
          const agent = new EnhancementAgent(env);
          await agent.start({
            notionPageId: pageId,
            videoUrl:  page.properties?.['🎬 Video URL']?.url,
            category:  page.properties?.['🗂️ Category']?.select?.name,
            section:   page.properties?.['🗂️ Section']?.select?.name,
            tags:      page.properties?.['🔖 Tags']?.multi_select?.map(t => t.name) || []
          });

          results.push({ pageId, status: 'queued' });
        } catch (error) {
          results.push({ pageId, status: 'error', error: error.message });
        }
      }

      return json({ processed: results.length, results });
    });

    router.post('/batch/publish', async (req, env) => {
      const { pageIds } = await req.json();
      const secrets = await getSecrets(env);
      const token = secrets.notion_token || env.NOTION_TOKEN;
      const results = [];

      for (const pageId of pageIds) {
        try {
          const notionRes = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
            headers: {
              'Authorization': `Bearer ${token}`,
              'Notion-Version': '2022-06-28'
            }
          });
          if (!notionRes.ok) continue;

          const page = await notionRes.json();
          const agent = new PublishingAgent(env);
          await agent.publish({
            notionPageId: pageId,
            title:    page.properties?.Title?.title?.[0]?.text?.content,
            category: page.properties?.['🗂️ Category']?.select?.name,
            section:  page.properties?.['🗂️ Section']?.select?.name,
            tags:     page.properties?.['🔖 Tags']?.multi_select?.map(t => t.name) || [],
            featured: page.properties?.Featured?.checkbox || false
          });

          results.push({ pageId, status: 'published' });
        } catch (error) {
          results.push({ pageId, status: 'error', error: error.message });
        }
      }

      return json({ processed: results.length, results });
    });

    // ── Analytics Summary ──────────────────────────────────────────────────
    router.get('/analytics/summary', async (req, env) => {
      const lastDiscovery = await env.CONTENT_KV.get('last_discovery');
      const keys = await env.CONTENT_KV.list({ prefix: 'video:' });
      const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
      let recentVideos = 0;

      for (const key of keys.keys) {
        const video = await env.CONTENT_KV.get(key.name);
        if (video && JSON.parse(video).processedAt > thirtyDaysAgo) recentVideos++;
      }

      return json({
        lastDiscovery:        lastDiscovery ? JSON.parse(lastDiscovery) : null,
        recentVideosProcessed: recentVideos,
        totalVideosInCache:   keys.keys.length,
        period:               '30 days'
      });
    });

    // ── Cache Management ───────────────────────────────────────────────────
    router.post('/cache/clear', async (req, env) => {
      const { pattern } = await req.json();
      const list = await env.CONTENT_KV.list({ prefix: pattern || '' });
      let deleted = 0;
      for (const key of list.keys) {
        await env.CONTENT_KV.delete(key.name);
        deleted++;
      }
      return json({ cleared: deleted, pattern: pattern || 'all' });
    });

    // ── Social Preview ─────────────────────────────────────────────────────
    router.get('/social/preview/:id', async (req, env) => {
      const url = new URL(req.url);
      const id = url.pathname.split('/').pop();
      const data = await env.CONTENT_KV.get(`social:${id}`);
      if (!data) return new Response('Not found', { status: 404 });
      return new Response(data, { headers: { 'Content-Type': 'application/json' } });
    });

    return router.handle(request, env);
  },

  // ── Queue Consumer ─────────────────────────────────────────────────────────

  async queue(batch, env, ctx) {
    for (const message of batch.messages) {
      const { type, ...data } = message.body;

      try {
        switch (type) {
          case 'discover':
            await new DiscoveryAgent(env).run();
            break;
          case 'research':
          case 'structure':
          case 'factcheck':
          case 'finalize':
            await new EnhancementAgent(env).processMessage({ type, ...data });
            break;
          case 'publish':
            await new PublishingAgent(env).publish(data);
            break;
          case 'crosspost':
            await new PublishingAgent(env).crossPost(data.articleId, data.platforms);
            break;
          default:
            console.error(`Unknown queue message type: ${type}`);
        }

        message.ack();
      } catch (error) {
        console.error(`Queue error [${type}]:`, error);
        message.retry();
      }
    }
  },

  // ── Cron Scheduler ─────────────────────────────────────────────────────────

  async scheduled(event, env, ctx) {
    console.log('Scheduled event:', event.cron);

    switch (event.cron) {
      // Every 6 hours — run discovery
      case '0 */6 * * *':
        await new DiscoveryAgent(env).run();
        break;

      // Monday 9am — clear creator cache for weekly refresh
      case '0 9 * * 1':
        await env.CONTENT_KV.delete('creator_cache');
        console.log('Creator cache cleared for weekly refresh');
        break;

      // 1st of month 2am — analytics snapshot
      case '0 2 1 * *':
        const list = await env.CONTENT_KV.list({ prefix: 'article:' });
        console.log(`Monthly snapshot: ${list.keys.length} articles in KV`);
        break;
    }
  }
};
