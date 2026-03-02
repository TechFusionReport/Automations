export class AnalyticsReporter {
  constructor(env) {
    this.env = env;
  }
  
  async getDashboard() {
    const articles = await this.env.CONTENT_KV.list({ prefix: 'article:' });
    const analytics = await this.env.ANALYTICS.list();
    
    const stats = {
      totalArticles: articles.keys.length,
      byCategory: {},
      bySection: {},
      topArticles: [],
      recentViews: 0,
      affiliateClicks: 0
    };
    
    for (const key of articles.keys) {
      const article = JSON.parse(await this.env.CONTENT_KV.get(key.name));
      
      // Category breakdown
      stats.byCategory[article.category] = (stats.byCategory[article.category] || 0) + 1;
      
      // Section breakdown
      stats.bySection[article.section] = (stats.bySection[article.section] || 0) + 1;
      
      // Top by views
      if (article.views) {
        stats.topArticles.push({
          title: article.title,
          views: article.views,
          url: article.url
        });
      }
    }
    
    // Sort top articles
    stats.topArticles.sort((a, b) => b.views - a.views);
    stats.topArticles = stats.topArticles.slice(0, 10);
    
    // Get recent analytics (last 7 days)
    const weekAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
    // Query analytics engine if available
    
    return new Response(JSON.stringify(stats, null, 2), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  async trackClick(slug, type) {
    const key = `clicks:${slug}:${type}`;
    const current = parseInt(await this.env.CONTENT_KV.get(key)) || 0;
    await this.env.CONTENT_KV.put(key, (current + 1).toString());
    
    return new Response('OK');
  }
}
