export class ContentRefresher {
  constructor(env) {
    this.env = env;
  }
  
  async identifyStale() {
    const articles = await this.env.CONTENT_KV.list({ prefix: 'article:' });
    const sixMonths = 6 * 30 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    
    const stale = [];
    
    for (const key of articles.keys) {
      const article = JSON.parse(await this.env.CONTENT_KV.get(key.name));
      const age = now - article.publishedAt;
      
      if (age > sixMonths) {
        const freshness = await this.checkFreshness(article);
        
        if (freshness.outdated.length > 0) {
          stale.push({
            slug: article.slug,
            title: article.title,
            age: Math.floor(age / (30 * 24 * 60 * 60 * 1000)), // months
            issues: freshness.outdated
          });
          
          // Queue for refresh
          await this.env.REFRESH_QUEUE.send({
            type: 'refresh',
            article,
            issues: freshness.outdated
          });
        }
      }
    }
    
    return new Response(JSON.stringify({
      staleArticles: stale.length,
      articles: stale
    }), { headers: { 'Content-Type': 'application/json' }});
  }
  
  async checkFreshness(article) {
    const prompt = `Check if this ${article.category} article needs updating:
Title: ${article.title}
Published: ${new Date(article.publishedAt).toISOString()}

Check for:
1. Outdated technology versions
2. Deprecated features or APIs
3. Newer alternatives available
4. Broken links (likely)
5. Changed best practices

Return JSON: {"outdated": ["specific issue 1", "issue 2"], "suggestions": ["update 1", "update 2"]}`;
    
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${this.env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }]
      })
    });
    
    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '{"outdated":[]}';
    
    try {
      return JSON.parse(text);
    } catch {
      return { outdated: [] };
    }
  }
  
  async refreshArticle(slug) {
    const article = JSON.parse(await this.env.CONTENT_KV.get(`article:${slug}`));
    const freshness = await this.checkFreshness(article);
    
    if (freshness.outdated.length === 0) {
      return new Response(JSON.stringify({ status: 'no-update-needed' }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Generate updated content
    const prompt = `Update this article for 2024:
Title: ${article.title}
Category: ${article.category}

Issues to address:
${freshness.outdated.join('\n')}

Suggestions:
${freshness.suggestions?.join('\n') || 'General refresh needed'}

Create updated version maintaining same structure but with current information.`;
    
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${this.env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }]
      })
    });
    
    const data = await response.json();
    const updatedContent = data.candidates?.[0]?.content?.parts?.[0]?.text;
    
    // Store as draft update
    await this.env.CONTENT_KV.put(`refresh:${slug}`, JSON.stringify({
      original: article,
      updatedContent,
      issues: freshness.outdated,
      generatedAt: Date.now()
    }));
    
    // Notify via Notion or email
    await this.createUpdateTask(article, freshness.outdated);
    
    return new Response(JSON.stringify({
      status: 'refresh-generated',
      slug,
      issues: freshness.outdated.length
    }), { headers: { 'Content-Type': 'application/json' }});
  }
  
  async createUpdateTask(article, issues) {
    // Add to Notion as "Update Review" task
    await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.env.NOTION_TOKEN}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28'
      },
      body: JSON.stringify({
        parent: { database_id: this.env.NOTION_DATABASE_ID },
        properties: {
          Name: { title: [{ text: { content: `[UPDATE] ${article.title}` } }] },
          Status: { select: { name: 'Update Review' } },
          "Original URL": { url: article.url },
          Issues: { rich_text: [{ text: { content: issues.join(', ') } }] },
          Category: { select: { name: article.category } }
        }
      })
    });
  }
  
  async processRefresh(data) {
    // Process queued refresh job
    console.log('Processing refresh for:', data.article.title);
    // Implementation for queue consumer
  }
}
