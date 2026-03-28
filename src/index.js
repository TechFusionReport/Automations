// TechFusion Report — Cloudflare Worker Entry Point
// v5.0.0 — fully poll-based, no webhook dependency

import DiscoveryAgent    from './agents/discovery.js';
import { EnhancementOrchestrator as EnhancementAgent } from './agents/enhancement.js';
import { PublishingAgent }    from './agents/publishing.js';
import { PublisherPoller }    from './agents/publisher-poller.js';
import { EnhancementPoller }  from './agents/enhancement-poller.js';

// ─── Simple Router ───────────────────────────────────────────────────────────

class Router {
  constructor() { this.routes = new Map(); }
  get(path, h)    { this.routes.set(`GET:${path}`, h); }
  post(path, h)   { this.routes.set(`POST:${path}`, h); }
  delete(path, h) { this.routes.set(`DELETE:${path}`, h); }

  async handle(request, env) {
    const url = new URL(request.url);
    const handler = this.routes.get(`${request.method}:${url.pathname}`);
    if (!handler) return new Response('Not Found', { status: 404 });
    try {
      return await handler(request, env);
    } catch (error) {
      console.error('Router error:', error);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500, headers: { 'Content-Type': 'application/json' }
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
    status, headers: { 'Content-Type': 'application/json' }
  });
}

// ─── Main Export ─────────────────────────────────────────────────────────────

export default {

  async fetch(request, env, ctx) {
    const router = new Router();

    // ── Core pipeline endpoints ────────────────────────────────────────────
    router.post('/discover', async (req, env) => {
      return await new DiscoveryAgent(env).run();
    });

    router.post('/enhance', async (req, env) => {
      const data = await req.json();
      return await new EnhancementAgent(env).start(data);
    });

    router.post('/publish', async (req, env) => {
      const data = await req.json();
      return await new PublishingAgent(env).publish(data);
    });

    // ── Manual poll triggers (for testing without waiting for cron) ────────
    router.post('/admin/enhance-poll', async (req, env) => {
      const result = await new EnhancementPoller(env).run();
      return json(result);
    });

    router.post('/admin/publish-poll', async (req, env) => {
      const result = await new PublisherPoller(env).run();
      return json(result);
    });

    // Single record triggers (for manual testing a specific page)
    router.post('/admin/enhance-single', async (req, env) => {
      const { pageId } = await req.json();
      if (!pageId) return json({ error: 'pageId required' }, 400);
      const result = await new EnhancementPoller(env).runSingle(pageId);
      return json(result);
    });

    router.post('/admin/publish-single', async (req, env) => {
      const { pageId } = await req.json();
      if (!pageId) return json({ error: 'pageId required' }, 400);
      const result = await new PublisherPoller(env).runSingle(pageId);
      return json(result);
    });

    // ── Channel management ─────────────────────────────────────────────────
    router.get('/admin/channels', async (req, env) => {
      const channels = await env.CONTENT_KV.get('channels_config');
      return new Response(channels || '[]', { headers: { 'Content-Type': 'application/json' } });
    });

    router.post('/admin/channels', async (req, env) => {
      const channels = await req.json();
      if (!Array.isArray(channels)) return json({ error: 'Must be an array' }, 400);
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

    // ── Channel score leaderboard ──────────────────────────────────────────
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

    // ── Revenue tracking ───────────────────────────────────────────────────
    router.post('/analytics/revenue', async (req, env) => {
      const { slug, views, estimatedAdRevenue, affiliateClicks, sponsorName, revenueType } =
        await req.json();
      const key = `article:${slug}`;
      const existing = await env.CONTENT_KV.get(key);
      if (!existing) return json({ error: 'Article not found' }, 404);
      const article = JSON.parse(existing);
      await env.CONTENT_KV.put(key, JSON.stringify({
        ...article,
        views:              views              ?? article.views,
        estimatedAdRevenue: estimatedAdRevenue ?? article.estimatedAdRevenue,
        affiliateClicks:    affiliateClicks    ?? article.affiliateClicks,
        sponsorName:        sponsorName        ?? article.sponsorName,
        revenueType:        revenueType        ?? article.revenueType,
        lastRevenueUpdate:  new Date().toISOString()
      }));
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
        byCategory: {}, byRevenueType: {},
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

    // ── Temporary: list available Gemini models ────────────────────────────
    router.get('/admin/gemini-models', async (req, env) => {
      const config = JSON.parse(await env.CONTENT_KV.get('secrets') || '{}');
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${config.gemini_api_key}`);
      const data = await res.json();
      const names = (data.models || []).map(m => m.name);
      return json({ count: names.length, models: names });
    });

    // ── Status & health ────────────────────────────────────────────────────
    router.get('/status', async (req, env) => {
      const [lastDiscovery, lastEnhancePoll, lastPublishPoll, channels, creators] =
        await Promise.all([
          env.CONTENT_KV.get('last_discovery'),
          env.CONTENT_KV.get('last_enhance_poll'),
          env.CONTENT_KV.get('last_publish_poll'),
          env.CONTENT_KV.get('channels_config'),
          env.CONTENT_KV.get('creator_cache'),
        ]);
      return json({
        status:          'operational',
        version:         '5.0.0',
        mode:            'poll-based (no webhooks)',
        lastDiscovery:   lastDiscovery   ? JSON.parse(lastDiscovery)   : null,
        lastEnhancePoll: lastEnhancePoll ? JSON.parse(lastEnhancePoll) : null,
        lastPublishPoll: lastPublishPoll ? JSON.parse(lastPublishPoll) : null,
        channelsLoaded:  channels ? JSON.parse(channels).length : 0,
        creatorsCached:  creators ? JSON.parse(creators).length : 0,
        timestamp:       new Date().toISOString()
      });
    });

    router.get('/health', async () =>
      json({ status: 'healthy', version: '5.0.0', uptime: Date.now() })
    );

    // ── GitHub webhook (kept — free on GitHub side) ────────────────────────
    router.post('/webhook/github', async (req, env) => {
      const payload = await req.json();
      if (payload.ref === 'refs/heads/main' && payload.commits) {
        for (const commit of payload.commits) {
          if (commit.message.includes('[refresh-channels]')) {
            await new DiscoveryAgent(env).loadConfig();
            console.log('Channels refreshed via GitHub webhook');
          }
        }
      }
      return new Response('OK', { status: 200 });
    });

    // ── Batch operations ───────────────────────────────────────────────────
    router.post('/batch/enhance', async (req, env) => {
      const { pageIds } = await req.json();
      const results = [];
      const poller  = new EnhancementPoller(env);
      for (const pageId of pageIds) {
        try {
          await poller.runSingle(pageId);
          results.push({ pageId, status: 'queued' });
        } catch (error) {
          results.push({ pageId, status: 'error', error: error.message });
        }
      }
      return json({ processed: results.length, results });
    });

    router.post('/batch/publish', async (req, env) => {
      const { pageIds } = await req.json();
      const results = [];
      const poller  = new PublisherPoller(env);
      for (const pageId of pageIds) {
        try {
          await poller.runSingle(pageId);
          results.push({ pageId, status: 'published' });
        } catch (error) {
          results.push({ pageId, status: 'error', error: error.message });
        }
      }
      return json({ processed: results.length, results });
    });

    // ── Analytics summary ──────────────────────────────────────────────────
    router.get('/analytics/summary', async (req, env) => {
      const lastDiscovery  = await env.CONTENT_KV.get('last_discovery');
      const keys           = await env.CONTENT_KV.list({ prefix: 'video:' });
      const thirtyDaysAgo  = Date.now() - 30 * 24 * 60 * 60 * 1000;
      let recentVideos = 0;
      for (const key of keys.keys) {
        const video = await env.CONTENT_KV.get(key.name);
        if (video && JSON.parse(video).processedAt > thirtyDaysAgo) recentVideos++;
      }
      return json({
        lastDiscovery:         lastDiscovery ? JSON.parse(lastDiscovery) : null,
        recentVideosProcessed: recentVideos,
        totalVideosInCache:    keys.keys.length,
        period:                '30 days'
      });
    });

    // ── Cache management ───────────────────────────────────────────────────
    router.post('/cache/clear', async (req, env) => {
      const { pattern } = await req.json();
      const list = await env.CONTENT_KV.list({ prefix: pattern || '' });
      let deleted = 0;
      for (const key of list.keys) { await env.CONTENT_KV.delete(key.name); deleted++; }
      return json({ cleared: deleted, pattern: pattern || 'all' });
    });

    // ── Social preview ─────────────────────────────────────────────────────
    router.get('/social/preview/:id', async (req, env) => {
      const id   = new URL(req.url).pathname.split('/').pop();
      const data = await env.CONTENT_KV.get(`social:${id}`);
      if (!data) return new Response('Not found', { status: 404 });
      return new Response(data, { headers: { 'Content-Type': 'application/json' } });
    });

    return router.handle(request, env);
  },

  // ── Queue consumer ──────────────────────────────────────────────────────────

  async queue(batch, env, ctx) {
    for (const message of batch.messages) {
      const { type, ...data } = message.body;
      try {
        switch (type) {
          case 'discover':
            await new DiscoveryAgent(env).run(); break;
          case 'enhance':
            await new EnhancementPoller(env).runSingle(data.notionPageId); break;
          case 'research': case 'structure': case 'factcheck': case 'finalize':
            await new EnhancementAgent(env).processMessage({ type, ...data }); break;
          case 'publish':
            await new PublisherPoller(env).runSingle(data.notionPageId); break;
          case 'crosspost':
            await new PublishingAgent(env).crossPost(data.articleId, data.platforms); break;
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

  // ── Cron scheduler ─────────────────────────────────────────────────────────

  async scheduled(event, env, ctx) {
    console.log('Cron fired:', event.cron);

    switch (event.cron) {

      // Every 6 hours — discover new content from all 88 channels
      case '0 */6 * * *':
        await new DiscoveryAgent(env).run();
        break;

      // Every 30 minutes — poll for records to enhance AND publish
      case '*/30 * * * *': {
        // Run enhancement first, then publishing
        const enhanceResult = await new EnhancementPoller(env).run();
        const publishResult = await new PublisherPoller(env).run();
        console.log(
          `Poll complete — Enhanced: ${enhanceResult.processed}, ` +
          `Published: ${publishResult.processed}, ` +
          `Errors: ${enhanceResult.errors.length + publishResult.errors.length}`
        );
        break;
      }

      // Monday 9am — clear creator cache for weekly refresh
      case '0 9 * * 1':
        await env.CONTENT_KV.delete('creator_cache');
        console.log('Creator cache cleared');
        break;

      // 1st of month 2am — monthly analytics snapshot
      case '0 2 1 * *': {
        const list = await env.CONTENT_KV.list({ prefix: 'article:' });
        console.log(`Monthly snapshot: ${list.keys.length} articles in KV`);
        break;
      }
    }
  }
};
