import { Router } from './router.js';

export default {
  async fetch(request, env, ctx) {
    const router = new Router();
    
    router.get('/health', async () => {
      return new Response(JSON.stringify({
        status: 'healthy',
        service: 'admin'
      }), { headers: { 'Content-Type': 'application/json' }});
    });
    
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
      }), { headers: { 'Content-Type': 'application/json' }});
    });
    
    router.post('/admin/channels/refresh', async (req, env) => {
      try {
        const response = await fetch('https://raw.githubusercontent.com/TechFusionReport/Automations/main/config/channels.json');
        const channels = await response.json();
        await env.CONTENT_KV.put('channels_config', JSON.stringify(channels));
        return new Response(JSON.stringify({ 
          status: 'refreshed', 
          count: channels.length 
        }), { headers: { 'Content-Type': 'application/json' }});
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
      }
    });
    
    router.post('/admin/creators/refresh', async (req, env) => {
      await env.CONTENT_KV.delete('creator_cache');
      return new Response(JSON.stringify({ status: 'creators cache cleared' }), {
        headers: { 'Content-Type': 'application/json' }
      });
    });
    
    router.get('/analytics/summary', async (req, env) => {
      const lastDiscovery = await env.CONTENT_KV.get('last_discovery');
      const discovery = lastDiscovery ? JSON.parse(lastDiscovery) : null;
      
      const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
      const keys = await env.CONTENT_KV.list({ prefix: 'video:' });
      let recentVideos = 0;
      
      for (const key of keys.keys) {
 const video = await env.CONTENT_KV.get(key.name);
        if (video) {
          const data = JSON.parse(video);
          if (data.processedAt > thirtyDaysAgo) recentVideos++;
        }
      }
      
      return new Response(JSON.stringify({
        lastDiscovery: discovery,
        recentVideosProcessed: recentVideos,
        totalVideosInCache: keys.keys.length,
        period: '30 days'
      }), { headers: { 'Content-Type': 'application/json' }});
    });
    
    router.post('/cache/clear', async (req, env) => {
      const { pattern } = await req.json();
      const list = await env.CONTENT_KV.list({ prefix: pattern || '' });
      let deleted = 0;
      
      for (const key of list.keys) {
        await env.CONTENT_KV.delete(key.name);
        deleted++;
      }
      
      return new Response(JSON.stringify({ 
        cleared: deleted,
        pattern: pattern || 'all'
      }), { headers: { 'Content-Type': 'application/json' }});
    });
    
    return router.handle(request, env);
  }
};
