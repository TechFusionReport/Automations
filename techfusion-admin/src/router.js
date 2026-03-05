export class Router {
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

export default {
  async fetch(request, env, ctx) {
    const router = new Router();

    // DISCOVERY
    router.post('/discover', async (req, env) => {
      const agent = new DiscoveryAgent(env);
      return await agent.run();
    });

    // CHANNEL MANAGEMENT
    router.get('/admin/channels', async (req, env) => {
      const channels = await env.CONTENT_KV.get('channels_config');
      return new Response(channels || '[]', {
        headers: { 'Content-Type': 'application/json' }
      });
    });

    router.post('/admin/channels', async (req, env) => {
      const channels = await req.json();
      if (!Array.isArray(channels)) {
        return new Response('Invalid: must be array', { status: 400 });
      }
      await env.CONTENT_KV.put('channels_config', JSON.stringify(channels));
      return new Response(JSON.stringify({
        status: 'saved',
        count: channels.length
      }), { headers: { 'Content-Type': 'application/json' } });
    });

    router.post('/admin/channels/refresh', async (req, env) => {
      try {
        const response = await fetch('https://raw.githubusercontent.com/TechFusionReport/Automations/main/config/channels.json');
        const channels = await response.json();
        await env.CONTENT_KV.put('channels_config', JSON.stringify(channels));
        return new Response(JSON.stringify({
          status: 'refreshed',
          count: channels.length
        }), { headers: { 'Content-Type': 'application/json' } });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
      }
    });

    // ENHANCEMENT
    router.post('/enhance', async (req, env) => {
      const data  = await req.json();
      const agent = new EnhancementAgent(env);
      return await agent.start(data);
    });

    // PUBLISHING
    router.post('/publish', async (req, env) => {
      const data  = await req.json();
      const agent = new PublishingAgent(env);
      return await agent.publish(data);
    });

    // STATUS
    router.get('/status', async (req, env) => {
      const lastDiscovery = await env.CONTENT_KV.get('last_discovery');
      const channels      = await env.CONTENT_KV.get('channels_config');
      const creators      = await env.CONTENT_KV.get('creator_cache');
      return new Response(JSON.stringify({
        status:        'running',
        channels:      channels ? JSON.parse(channels).length : 0,
        creators:      creators ? JSON.parse(creators).length : 0,
        lastDiscovery: lastDiscovery ? JSON.parse(lastDiscovery) : null,
        timestamp:     new Date().toISOString()
      }), { headers: { 'Content-Type': 'application/json' } });
    });

    return router.handle(request, env);
  },

  async scheduled(event, env, ctx) {
    if (event.cron === '0 */6 * * *') {
      const agent = new DiscoveryAgent(env);
      await agent.run();
    }
  }
};
