// TechFusion Admin - Protected Worker
import { Router } from './router.js';

export default {
  async fetch(request, env, ctx) {
    const router = new Router();
    
    // Admin dashboard endpoints
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
      const { DiscoveryAgent } = await import('./agents/discovery.js');
      const agent = new DiscoveryAgent(env);
      await agent.invalidateCreatorCache();
      await agent.loadCreatorCache();
      return new Response(JSON.stringify({ status: 'creators refreshed' }), {
        headers: { 'Content-Type': 'application/json' }
      });
    });
    
    router.post('/batch/enhance', async (req, env) => {
      const { pageIds } = await req.json();
      // Call API worker internally or process directly
      return new Response(JSON.stringify({ processed: pageIds.length }), {
        headers: { 'Content-Type': 'application/json' }
      });
    });
    
    router.post('/batch/publish', async (req, env) => {
      const { pageIds } = await req.json();
      return new Response(JSON.stringify({ processed: pageIds.length }), {
        headers: { 'Content-Type': 'application/json' }
      });
    });
    
    router.get('/analytics/summary', async (req, env) => {
      const lastDiscovery = await env.CONTENT_KV.get('last_discovery');
      const discovery = lastDiscovery ? JSON.parse(lastDiscovery) : null;
      
      return new Response(JSON.stringify({
        lastDiscovery: discovery,
        timestamp: new Date().toISOString()
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
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
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    });
    
    router.get('/status', async (req, env) => {
      return new Response(JSON.stringify({
        status: 'operational',
        service: 'admin',
        timestamp: new Date().toISOString()
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    });
    
    return router.handle(request, env);
  }
};
