import { Router } from './router.js';
import { DiscoveryAgent } from './agents/discovery.js';
import { EnhancementOrchestrator } from './agents/enhancement.js';
import { PublishingAgent } from './agents/publishing.js';

export default {
  async fetch(request, env, ctx) {
    const router = new Router();
    
    router.get('/health', async () => {
      return new Response(JSON.stringify({
        status: 'healthy',
        version: '2.1.0',
        service: 'api'
      }), { headers: { 'Content-Type': 'application/json' }});
    });
    
    router.get('/status', async (req, env) => {
      const lastDiscovery = await env.CONTENT_KV.get('last_discovery');
      return new Response(JSON.stringify({
        status: 'operational',
        lastDiscovery: lastDiscovery ? JSON.parse(lastDiscovery) : null,
        timestamp: new Date().toISOString()
      }), { headers: { 'Content-Type': 'application/json' }});
    });
    
    router.post('/discover', async (req, env) => {
      const agent = new DiscoveryAgent(env);
      return await agent.run();
    });
    
    router.post('/enhance', async (req, env) => {
      const data = await req.json();
      const agent = new EnhancementOrchestrator(env);
      return await agent.start(data);
    });
    
    router.post('/publish', async (req, env) => {
      const data = await req.json();
      const agent = new PublishingAgent(env);
      return await agent.publish(data);
    });
    
    router.post('/webhook/notion', async (req, env) => {
      const payload = await req.json();
      return new Response('OK');
    });
    
    router.post('/webhook/github', async (req, env) => {
      const payload = await req.json();
      return new Response('OK');
    });
    
    return router.handle(request, env);
  },
  
  async scheduled(event, env, ctx) {
    const agent = new DiscoveryAgent(env);
    await agent.run();
  }
};
