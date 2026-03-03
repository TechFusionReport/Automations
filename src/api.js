// TechFusion API - Public Worker
import { Router } from './router.js'; // Extract Router to shared module

export default {
  async fetch(request, env, ctx) {
    const router = new Router();
    
    // Public endpoints only
    router.get('/health', async () => {
      return new Response(JSON.stringify({
        status: 'healthy',
        version: '2.1.0',
        service: 'api'
      }), { headers: { 'Content-Type': 'application/json' }});
    });
    
    router.post('/discover', async (req, env) => {
      const { DiscoveryAgent } = await import('./agents/discovery.js');
      const agent = new DiscoveryAgent(env);
      return await agent.run();
    });
    
    router.post('/enhance', async (req, env) => {
      const { EnhancementAgent } = await import('./agents/enhancement.js');
      const data = await req.json();
      const agent = new EnhancementAgent(env);
      return await agent.start(data);
    });
    
    router.post('/publish', async (req, env) => {
      const { PublishingAgent } = await import('./agents/publishing.js');
      const data = await req.json();
      const agent = new PublishingAgent(env);
      return await agent.publish(data);
    });
    
    router.post('/webhook/notion', async (req, env) => {
      // Webhook handlers
      const payload = await req.json();
      // ... handle notion webhook
      return new Response('OK');
    });
    
    router.post('/webhook/github', async (req, env) => {
      const payload = await req.json();
      // ... handle github webhook
      return new Response('OK');
    });
    
    return router.handle(request, env);
  },
  
  async queue(batch, env, ctx) {
    // Queue consumer for background jobs
    for (const message of batch.messages) {
      message.ack();
    }
  },
  
  async scheduled(event, env, ctx) {
    // Cron trigger for discovery
    const { DiscoveryAgent } = await import('./agents/discovery.js');
    const agent = new DiscoveryAgent(env);
    await agent.run();
  }
};
