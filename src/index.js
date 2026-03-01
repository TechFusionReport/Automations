import { Router } from './router.js';
import { DiscoveryAgent } from './agents/discovery.js';
import { EnhancementOrchestrator } from './agents/enhancement.js';
import { PublishingAgent } from './agents/publishing.js';
import { NewsletterGenerator } from './utils/newsletter.js';
import { ContentRefresher } from './utils/refresh.js';

export default {
  async fetch(request, env, ctx) {
    const router = new Router();
    
    router.post('/discover', async (req, env) => {
      const agent = new DiscoveryAgent(env);
      return await agent.run();
    });
    
    router.post('/enhance', async (req, env) => {
      const data = await req.json();
      const orchestrator = new EnhancementOrchestrator(env);
      return await orchestrator.start(data);
    });
    
    router.post('/publish', async (req, env) => {
      const data = await req.json();
      const agent = new PublishingAgent(env);
      return await agent.publish(data);
    });
    
    router.get('/status', async (req, env) => {
      const discovery = await env.CONTENT_KV.get('last_discovery');
      return new Response(JSON.stringify({
        lastDiscovery: discovery ? JSON.parse(discovery) : null,
        timestamp: new Date().toISOString()
      }), { headers: { 'Content-Type': 'application/json' }});
    });
    
    return router.handle(request, env);
  },
  
  async scheduled(event, env, ctx) {
    if (event.cron === '0 */6 * * *') {
      const discovery = new DiscoveryAgent(env);
      await discovery.run();
    }
  },
  
  async queue(batch, env, ctx) {
    for (const message of batch.messages) {
      await message.ack();
    }
  }
};
