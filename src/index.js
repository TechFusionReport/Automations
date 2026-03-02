import { Router } from './router.js';
import { DiscoveryAgent } from './agents/discovery.js';
import { EnhancementOrchestrator } from './agents/enhancement.js';
import { PublishingAgent } from './agents/publishing.js';
import { NewsletterGenerator } from './utils/newsletter.js';
import { ContentRefresher } from './utils/refresh.js';
import { AnalyticsReporter } from './utils/analytics.js';

export default {
  async fetch(request, env, ctx) {
    const router = new Router();
    
    // Discovery endpoints
    router.post('/discover', async (req, env) => {
      const agent = new DiscoveryAgent(env);
      return await agent.run();
    });
    
    router.post('/discover/:source', async (req, env) => {
      const { source } = req.params;
      const agent = new DiscoveryAgent(env);
      return await agent.runSource(source);
    });
    
    // Enhancement
    router.post('/enhance', async (req, env) => {
      const data = await req.json();
      const orchestrator = new EnhancementOrchestrator(env);
      return await orchestrator.start(data);
    });
    
    // Publishing
    router.post('/publish', async (req, env) => {
      const data = await req.json();
      const agent = new PublishingAgent(env);
      return await agent.publish(data);
    });
    
    // Cross-posting
    router.post('/crosspost', async (req, env) => {
      const { articleId, platforms } = await req.json();
      const agent = new PublishingAgent(env);
      return await agent.crossPost(articleId, platforms);
    });
    
    // Newsletter
    router.post('/newsletter/send', async (req, env) => {
      const generator = new NewsletterGenerator(env);
      return await generator.sendWeekly();
    });
    
    router.post('/newsletter/preview', async (req, env) => {
      const generator = new NewsletterGenerator(env);
      return await generator.generatePreview();
    });
    
    // Content refresh
    router.post('/refresh', async (req, env) => {
      const refresher = new ContentRefresher(env);
      return await refresher.identifyStale();
    });
    
    router.post('/refresh/:articleId', async (req, env) => {
      const { articleId } = req.params;
      const refresher = new ContentRefresher(env);
      return await refresher.refreshArticle(articleId);
    });
    
    // Analytics
    router.get('/analytics/dashboard', async (req, env) => {
      const reporter = new AnalyticsReporter(env);
      return await reporter.getDashboard();
    });
    
    router.post('/analytics/track', async (req, env) => {
      const { slug, metric } = await req.json();
      await env.ANALYTICS.writeDataPoint({
        blobs: [slug, metric],
        doubles: [1],
        indexes: [Date.now()]
      });
      return new Response('OK');
    });
    
    // A/B Testing
    router.post('/ab/test', async (req, env) => {
      const { articleId, variants } = await req.json();
      const agent = new PublishingAgent(env);
      return await agent.createABTest(articleId, variants);
    });
    
    // Status
    router.get('/status', async (req, env) => {
      const discovery = await env.CONTENT_KV.get('last_discovery');
      const enhancementSize = await env.ENHANCEMENT_QUEUE.size();
      const publishingSize = await env.PUBLISHING_QUEUE.size();
      const articleCount = (await env.CONTENT_KV.list({ prefix: 'article:' })).keys.length;
      
      return new Response(JSON.stringify({
        lastDiscovery: discovery ? JSON.parse(discovery) : null,
        queues: {
          enhancement: enhancementSize,
          publishing: publishingSize
        },
        totalArticles: articleCount,
        timestamp: new Date().toISOString()
      }), { headers: { 'Content-Type': 'application/json' }});
    });
    
    // Config management
    router.get('/config/channels', async (req, env) => {
      const config = await env.CONTENT_KV.get('channels_config');
      return new Response(config || '[]', { headers: { 'Content-Type': 'application/json' }});
    });
    
    router.post('/config/channels', async (req, env) => {
      const config = await req.json();
      await env.CONTENT_KV.put('channels_config', JSON.stringify(config));
      return new Response('Config updated', { status: 201 });
    });
    
    return router.handle(request, env);
  },
  
  async scheduled(event, env, ctx) {
    switch (event.cron) {
      case '0 */6 * * *':
        // Discovery
        const discovery = new DiscoveryAgent(env);
        await discovery.run();
        break;
        
      case '0 9 * * 1':
        // Weekly newsletter
        const newsletter = new NewsletterGenerator(env);
        await newsletter.sendWeekly();
        break;
        
      case '0 2 1 * *':
        // Monthly content refresh
        const refresher = new ContentRefresher(env);
        await refresher.identifyStale();
        break;
    }
  },
  
  async queue(batch, env, ctx) {
    for (const message of batch.messages) {
      const { type, ...data } = message.body;
      
      try {
        switch (type) {
          case 'research':
          case 'structure':
          case 'factcheck':
          case 'finalize':
            const orchestrator = new EnhancementOrchestrator(env);
            await orchestrator.processStep(type, data);
            break;
            
          case 'publish':
            const publisher = new PublishingAgent(env);
            await publisher.publish(data);
            break;
            
          case 'refresh':
            const refresher = new ContentRefresher(env);
            await refresher.processRefresh(data);
            break;
            
          case 'crosspost':
            const crossposter = new PublishingAgent(env);
            await crossposter.processCrossPost(data);
            break;
        }
        
        await message.ack();
      } catch (error) {
        console.error(`Queue error: ${type}`, error);
        await message.retry({ delaySeconds: 60 });
      }
    }
  }
};
