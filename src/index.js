// TechFusion Agents - Complete Worker
// File: src/index.js
// Supports 87+ channels with KV storage

// ========== ROUTER ==========
class Router {
  constructor() {
    this.routes = new Map();
  }
  
  get(path, handler) {
    this.routes.set(`GET:${path}`, handler);
  }
  
  post(path, handler) {
    this.routes.set(`POST:${path}`, handler);
  }
  
  delete(path, handler) {
    this.routes.set(`DELETE:${path}`, handler);
  }
  
  async handle(request, env) {
    const url = new URL(request.url);
    const key = `${request.method}:${url.pathname}`;
    const handler = this.routes.get(key);
    
    if (!handler) {
      return new Response('Not Found', { status: 404 });
    }
    
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

// ========== DISCOVERY AGENT ==========
class DiscoveryAgent {
  constructor(env) {
    this.env = env;
    this.creatorCache = null;
    this.config = null;
  }

  async loadConfig() {
    // Primary: Load from KV (fast, updatable)
    const stored = await this.env.CONTENT_KV.get('channels_config');
    if (stored) {
      const channels = JSON.parse(stored);
      console.log(`Loaded ${channels.length} channels from KV`);
      return channels;
    }
    
    // Fallback: Fetch from GitHub raw URL
    try {
      const response = await fetch('https://raw.githubusercontent.com/TechFusionReport/Automations/main/config/channels.json');
      if (response.ok) {
        const channels = await response.json();
        // Cache in KV for next time
        await this.env.CONTENT_KV.put('channels_config', JSON.stringify(channels));
        console.log(`Loaded ${channels.length} channels from GitHub`);
        return channels;
      }
    } catch (e) {
      console.error('Failed to load from GitHub:', e);
    }
    
    // Emergency fallback
    console.warn('Using emergency fallback config');
    return [{
      id: "UC_x5XG1OV2P6uZZ5FSM9Ttw",
      name: "Google Developers",
      type: "youtube",
      minScore: 75,
      category: "Web Development",
      section: "engineering",
      tags: ["cloud", "api", "performance"],
      featured: false
    }];
  }

  async loadCreatorCache() {
    if (this.creatorCache) return this.creatorCache;
    
    const cached = await this.env.CONTENT_KV.get('creator_cache');
    if (cached) {
      this.creatorCache = JSON.parse(cached);
      return this.creatorCache;
    }
    
    const creators = [];
    let cursor = undefined;
    let hasMore = true;
    
    while (hasMore) {
      const requestBody = { page_size: 100 };
      if (cursor) requestBody.start_cursor = cursor;
      
      const response = await fetch(`https://api.notion.com/v1/databases/${this.env.CREATOR_DATABASE_ID}/query`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.env.NOTION_TOKEN}`,
          'Content-Type': 'application/json',
          'Notion-Version': '2022-06-28'
        },
        body: JSON.stringify(requestBody)
      });
      
      if (!response.ok) {
        console.error('Failed to fetch creators:', await response.text());
        break;
      }
      
      const data = await response.json();
      
      for (const page of data.results) {
        const channelId = this.extractChannelId(page);
        if (channelId) {
          creators.push({
            id: page.id,
            channelId: channelId,
            name: page.properties.Name?.title?.[0]?.text?.content || 'Unknown'
          });
        }
      }
      
      cursor = data.next_cursor;
      hasMore = data.has_more && cursor;
    }
    
    await this.env.CONTENT_KV.put('creator_cache', JSON.stringify(creators), {
      expirationTtl: 86400
    });
    
    this.creatorCache = creators;
    console.log(`Cached ${creators.length} creators`);
    return creators;
  }

  extractChannelId(page) {
    const props = page.properties;
    const names = ['Channel ID', 'channel_id', 'ChannelID', 'YouTube ID', 'YouTube', 'ID'];
    
    for (const name of names) {
      const prop = props[name];
      if (prop?.rich_text?.[0]) return prop.rich_text[0].text.content.trim();
      if (prop?.title?.[0]) return prop.title[0].text.content.trim();
    }
    return null;
  }

  async invalidateCreatorCache() {
    await this.env.CONTENT_KV.delete('creator_cache');
    this.creatorCache = null;
  }

  async run() {
    this.config = {
      notion_token: this.env.NOTION_TOKEN,
      notion_database_id: this.env.NOTION_DATABASE_ID,
      creator_database_id: this.env.CREATOR_DATABASE_ID,
      youtube_api_key: this.env.YOUTUBE_API_KEY,
      gemini_api_key: this.env.GEMINI_API_KEY
    };
    
    const channels = await this.loadConfig();
    await this.loadCreatorCache();
    
    const results = { 
      total: channels.length,
      processed: 0,
      approved: 0,
      byType: {},
      errors: []
    };

    for (const channel of channels) {
      try {
        console.log(`Processing: ${channel.name} [${channel.type}]`);
        
        let channelResult = { processed: 0, approved: 0 };
        
        switch (channel.type) {
          case 'youtube':
            channelResult = await this.processYouTube(channel);
            break;
          case 'rss':
            channelResult = await this.processRSS(channel);
            break;
          case 'github':
            channelResult = await this.processGitHub(channel);
            break;
          case 'hackernews':
            channelResult = await this.processHackerNews(channel);
            break;
        }
        
        results.processed += channelResult.processed;
        results.approved += channelResult.approved;
        results.byType[channel.type] = (results.byType[channel.type] || 0) + channelResult.processed;
        
      } catch (error) {
        console.error(`Error: ${channel.name}:`, error);
        results.errors.push({ channel: channel.name, error: error.message });
      }
    }

    await this.env.CONTENT_KV.put('last_discovery', JSON.stringify({
      timestamp: new Date().toISOString(),
      results
    }));

    return new Response(JSON.stringify(results), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  async processYouTube(channel) {
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channel.id}&maxResults=5&order=date&type=video&key=${this.config.youtube_api_key}`;
    const response = await fetch(url);
    const data = await response.json();
    
    let processed = 0;
    let approved = 0;

    for (const item of data.items || []) {
      const videoId = item.id.videoId;
      if (await this.env.CONTENT_KV.get(`video:${videoId}`)) continue;

      const score = await this.scoreContent(
        item.snippet.title, 
        item.snippet.description, 
        channel.category
      );

      await this.env.CONTENT_KV.put(`video:${videoId}`, JSON.stringify({
        title: item.snippet.title, 
        channel: channel.name,
        score, 
        processedAt: Date.now()
      }), { expirationTtl: 2592000 });

      processed++;

      if (score > (channel.minScore || 70)) {
        await this.writeToNotion({
          id: videoId,
          title: item.snippet.title,
          description: item.snippet.description,
          url: `https://youtube.com/watch?v=${videoId}`,
          channelTitle: item.snippet.channelTitle,
          publishedAt: item.snippet.publishedAt,
          score
        }, channel);
        approved++;
      }
    }

    return { processed, approved };
  }

  async processRSS(channel) {
    // TODO: Implement RSS processing
    return { processed: 0, approved: 0 };
  }

  async processGitHub(channel) {
    // TODO: Implement GitHub releases processing
    return { processed: 0, approved: 0 };
  }

  async processHackerNews(channel) {
    // TODO: Implement HN processing
    return { processed: 0, approved: 0 };
  }

  async scoreContent(title, description, category) {
    const prompt = `Score 0-100 for ${category} tech blog relevance.
Title: "${title}"
Description: "${description?.substring(0, 500)}"
Return only the number.`;

    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${this.config.gemini_api_key}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
      });

      const data = await response.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '50';
      const match = text.match(/\d+/);
      return match ? parseInt(match[0]) : 50;
    } catch (error) {
      console.error('Scoring failed:', error);
      return 50;
    }
  }

  async writeToNotion(video, channel) {
    const creator = this.creatorCache?.find(c => c.channelId === channel.id);
    
    const properties = {
      Name: { title: [{ text: { content: video.title } }] },
      "Video URL": { url: video.url },
      Score: { number: video.score },
      Status: { select: { name: "Pending Review" } },
      Category: { select: { name: channel.category } },
      Section: { select: { name: channel.section } },
      Tags: { multi_select: channel.tags.map(tag => ({ name: tag })) },
      Featured: { checkbox: channel.featured },
      Source: { select: { name: channel.type } },
      "Published Date": { date: { start: video.publishedAt } }
    };

    if (creator) {
      properties["Content Creator"] = { relation: [{ id: creator.id }] };
      properties["Creator Name"] = { rich_text: [{ text: { content: creator.name } }] };
    } else {
      properties["Creator Name"] = { rich_text: [{ text: { content: channel.name } }] };
    }

    const response = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.config.notion_token}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28'
      },
      body: JSON.stringify({
        parent: { database_id: this.config.notion_database_id },
        properties: properties
      })
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Notion error: ${error}`);
    }

    return await response.json();
  }
}

// ========== ENHANCEMENT AGENT ==========
class EnhancementAgent {
  constructor(env) {
    this.env = env;
  }
  
  async start(data) {
    const { notionPageId, videoUrl, category, section, tags } = data;
    
    const prompt = `Write a comprehensive ${category} blog post about this video: ${videoUrl}

Requirements:
- 1500-2000 words
- Technical but accessible tone
- Include practical code examples
- TL;DR summary at top
- Clear conclusion with next steps
- Format in markdown

Structure:
1. Introduction (hook + what reader will learn)
2. TL;DR (3-4 bullet summary)
3. Main content (3-5 sections with H2)
4. Code examples (marked as [CODE_BLOCK: description])
5. Conclusion
6. Call to action`;

    const draft = await this.callGemini(prompt);
    
    // Update Notion with draft
    await fetch(`https://api.notion.com/v1/blocks/${notionPageId}/children`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${this.env.NOTION_TOKEN}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28'
      },
      body: JSON.stringify({
        children: [
          {
            object: 'block',
            type: 'paragraph',
            paragraph: {
              rich_text: [{ text: { content: `🤖 AI Draft Generated [${category}]` } }]
            }
          },
          {
            object: 'block',
            type: 'divider',
            divider: {}
          },
          {
            object: 'block',
            type: 'code',
            code: {
              language: 'markdown',
              rich_text: [{ text: { content: draft } }]
            }
          }
        ]
      })
    });
    
    // Update status
    await fetch(`https://api.notion.com/v1/pages/${notionPageId}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${this.env.NOTION_TOKEN}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28'
      },
      body: JSON.stringify({
        properties: { Status: { select: { name: "Draft Review" } } }
      })
    });
    
    return new Response(JSON.stringify({ 
      status: 'enhanced', 
      notionPageId,
      wordCount: draft.split(/\s+/).length 
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  async callGemini(prompt) {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${this.env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 2048 }
      })
    });
    
    const data = await response.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || 'Draft generation failed';
  }
}

// ========== PUBLISHING AGENT ==========
class PublishingAgent {
  constructor(env) {
    this.env = env;
  }
  
  async publish(data) {
    const { notionPageId, title, content, category, section, tags, featured = false } = data;
    
    const metadata = {
      title,
      description: this.generateMetaDescription(content),
      date: new Date().toISOString().split('T')[0],
      slug: this.createSlug(title),
      category: category || 'General',
      section: section || 'general',
      tags: tags || [],
      featured
    };

    const contentWithAffiliates = this.insertAffiliateLinks(content);
    const html = this.convertToHTML(contentWithAffiliates, metadata);
    
    const categoryPath = metadata.category.toLowerCase().replace(/\s+/g, '-');
    const filePath = `${metadata.section}/${categoryPath}/${metadata.slug}.html`;
    
    await this.commitToGitHub(filePath, html, metadata);
    
    const url = `https://techfusionreport.com/${filePath}`;
    
    await this.updateNotionStatus(notionPageId, 'Published', url);
    
    const socialContent = await this.generateSocialContent(metadata, content);
    await this.env.CONTENT_KV.put(`social:${notionPageId}`, JSON.stringify(socialContent));
    
    if (metadata.featured) {
      await this.env.PUBLISHING_QUEUE?.send({
        type: 'crosspost',
        notionPageId,
        platforms: ['medium', 'devto']
      });
    }
    
    return new Response(JSON.stringify({ 
      status: 'published', 
      url,
      social: socialContent 
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  createSlug(title) {
    return title.toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 60);
  }

  generateMetaDescription(content) {
    const firstPara = content.split('\n\n')[0] || '';
    const plainText = firstPara
      .replace(/[#*`[\]]/g, '')
      .replace(/\n/g, ' ')
      .trim();
    
    return plainText.length > 155 
      ? plainText.substring(0, 152) + '...'
      : plainText;
  }

  insertAffiliateLinks(content) {
    const affiliates = {
      'cloudflare': 'https://www.cloudflare.com',
      'vercel': 'https://vercel.com',
      'notion': 'https://notion.so',
      'github': 'https://github.com',
      'linear': 'https://linear.app'
    };
    
    let result = content;
    
    result = result.replace(/\[AFFILIATE: (\w+)\]/g, (match, tool) => {
      const url = affiliates[tool.toLowerCase()];
      return url ? `[${tool}](${url}?ref=techfusion)` : tool;
    });
    
    return result;
  }

  convertToHTML(markdown, metadata) {
    let contentHtml = markdown
      .replace(/^# (.*$)/gim, '<h1>$1</h1>')
      .replace(/^## (.*$)/gim, '<h2 id="$1">$1</h2>')
      .replace(/^### (.*$)/gim, '<h3>$1</h3>')
      .replace(/\*\*(.*)\*\*/gim, '<strong>$1</strong>')
      .replace(/\*(.*)\*/gim, '<em>$1</em>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/gim, '<a href="$2" rel="nofollow noopener">$1</a>')
      .replace(/```([\s\S]*?)```/gim, '<pre><code>$1</code></pre>')
      .replace(/`([^`]+)`/gim, '<code>$1</code>')
      .replace(/\[CODE_BLOCK: ([^\]]+)\]/gim, '<div class="code-placeholder"><p>Code: $1</p></div>')
      .replace(/\n/gim, '<br>');

    const canonicalUrl = `https://techfusionreport.com/${metadata.section}/${metadata.category.toLowerCase().replace(/\s+/g, '-')}/${metadata.slug}.html`;
    
    const schemaMarkup = {
      "@context": "https://schema.org",
      "@type": "TechArticle",
      "headline": metadata.title,
      "description": metadata.description,
      "datePublished": metadata.date,
      "author": { "@type": "Organization", "name": "TechFusion Report" },
      "publisher": { 
        "@type": "Organization", 
        "name": "TechFusion Report",
        "logo": { "@type": "ImageObject", "url": "https://techfusionreport.com/logo.png" }
      },
      "articleSection": metadata.category,
      "keywords": metadata.tags.join(', ')
    };

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${metadata.title} | TechFusion Report</title>
  <meta name="description" content="${metadata.description}">
  <link rel="canonical" href="${canonicalUrl}">
  
  <meta property="og:title" content="${metadata.title}">
  <meta property="og:description" content="${metadata.description}">
  <meta property="og:type" content="article">
  <meta property="og:url" content="${canonicalUrl}">
  
  <meta name="twitter:card" content="summary">
  <meta name="twitter:title" content="${metadata.title}">
  <meta name="twitter:description" content="${metadata.description}">
  
  <script type="application/ld+json">
  ${JSON.stringify(schemaMarkup)}
  </script>
  
  <link rel="stylesheet" href="/assets/style.css">
</head>
<body>
  <article>
    <header>
      <span class="category">${metadata.category}</span>
      ${metadata.featured ? '<span class="featured">Featured</span>' : ''}
      <h1>${metadata.title}</h1>
      <time datetime="${metadata.date}">${new Date(metadata.date).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</time>
      <div class="tags">${metadata.tags.map(tag => `<span class="tag">${tag}</span>`).join('')}</div>
    </header>
    <div class="content">
      <div class="tldr"><strong>TL;DR:</strong> ${metadata.description}</div>
      ${contentHtml}
    </div>
  </article>
</body>
</html>`;
  }

  async commitToGitHub(path, content, metadata) {
    const base64Content = btoa(unescape(encodeURIComponent(content)));
    
    const checkRes = await fetch(`https://api.github.com/repos/TechFusionReport/Website/contents/${path}`, {
      headers: {
        'Authorization': `token ${this.env.GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json'
      }
    });
    
    const sha = checkRes.ok ? (await checkRes.json()).sha : undefined;
    
    const commitRes = await fetch(`https://api.github.com/repos/TechFusionReport/Website/contents/${path}`, {
      method: 'PUT',
      headers: {
        'Authorization': `token ${this.env.GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        message: `Add: ${metadata.title} [${metadata.category}]`,
        content: base64Content,
        sha,
        committer: { name: 'TechFusion Bot', email: 'bot@techfusionreport.com' }
      })
    });
    
    if (!commitRes.ok) {
      throw new Error(`GitHub commit failed: ${await commitRes.text()}`);
    }
    
    return (await commitRes.json()).content.html_url;
  }

  async updateNotionStatus(pageId, status, url) {
    await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${this.env.NOTION_TOKEN}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28'
      },
      body: JSON.stringify({
        properties: { 
          Status: { select: { name: status } },
          "Published URL": { url }
        }
      })
    });
  }

  async generateSocialContent(metadata, content) {
    const prompt = `Create social posts for "${metadata.title}" [${metadata.category}]:

1. Twitter thread (3-5 tweets)
2. LinkedIn post (professional)

Format with clear headers.`;

    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${this.env.GEMINI_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
      });
      
      const data = await response.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      
      return {
        twitter: this.extractSection(text, 'Twitter') || `🚀 ${metadata.title}`,
        linkedin: this.extractSection(text, 'LinkedIn') || `Just published: ${metadata.title}`,
        devto: { title: metadata.title, tags: metadata.tags.slice(0, 4) }
      };
    } catch {
      return {
        twitter: `🚀 ${metadata.title}\n\n#${metadata.category.replace(/\s+/g, '')}`,
        linkedin: `Just published: ${metadata.title}`,
        devto: { title: metadata.title, tags: metadata.tags.slice(0, 4) }
      };
    }
  }

  extractSection(text, header) {
    const match = text?.match(new RegExp(`${header}:?[\\s]*\\n([\\s\\S]*?)(?=\\n\\w+:|$)`, 'i'));
    return match ? match[1].trim() : null;
  }
}

// ========== MAIN EXPORT ==========
export default {
  async fetch(request, env, ctx) {
    const router = new Router();
    
    // DISCOVERY
    router.post('/discover', async (req, env) => {
      const agent = new DiscoveryAgent(env);
      return await agent.run();
    });
    
    // ADMIN - CHANNEL MANAGEMENT
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
      const agent = new DiscoveryAgent(env);
      await agent.invalidateCreatorCache();
      await agent.loadCreatorCache();
      return new Response(JSON.stringify({ status: 'creators refreshed' }), {
        headers: { 'Content-Type': 'application/json' }
      });
    });
    
    // ENHANCEMENT
    router.post('/enhance', async (req, env) => {
      const data = await req.json();
      const agent = new EnhancementAgent(env);
      return await agent.start(data);
    });
    
    // PUBLISHING
    router.post('/publish', async (req, env) => {
      const data = await req.json();
      const agent = new PublishingAgent(env);
      return await agent.publish(data);
    });
    
    // STATUS
    router.get('/status', async (req, env) => {
      const lastDiscovery = await env.CONTENT_KV.get('last_discovery');
      const channels = await env.CONTENT_KV.get('channels_config');
      const creators = await env.CONTENT_KV.get('creator_cache');
      
      return new Response(JSON.stringify({
                status: 'operational',
        lastDiscovery: lastDiscovery ? JSON.parse(lastDiscovery) : null,
        channelsLoaded: channels ? JSON.parse(channels).length : 0,
        creatorsCached: creators ? JSON.parse(creators).length : 0,
        timestamp: new Date().toISOString()
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    });
    
    // HEALTH CHECK
    router.get('/health', async (req, env) => {
      return new Response(JSON.stringify({
        status: 'healthy',
        version: '2.1.0',
        uptime: Date.now()
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    });
    
    // QUEUE HANDLER (for background processing)
    router.post('/queue/process', async (req, env) => {
      const { type, data } = await req.json();
      
      switch(type) {
        case 'crosspost':
          return await handleCrosspost(data, env);
        case 'notify':
          return await handleNotification(data, env);
        case 'index':
          return await handleIndexing(data, env);
        default:
          return new Response('Unknown queue type', { status: 400 });
      }
    });
    
    // WEBHOOK HANDLERS
    router.post('/webhook/notion', async (req, env) => {
      const payload = await req.json();
      
      if (payload.type === 'page.updated') {
        const pageId = payload.page.id;
        const status = payload.page.properties?.Status?.select?.name;
        
        if (status === 'Ready to Enhance') {
          const agent = new EnhancementAgent(env);
          return await agent.start({
            notionPageId: pageId,
            videoUrl: payload.page.properties?.['Video URL']?.url,
            category: payload.page.properties?.Category?.select?.name,
            section: payload.page.properties?.Section?.select?.name,
            tags: payload.page.properties?.Tags?.multi_select?.map(t => t.name) || []
          });
        }
        
        if (status === 'Ready to Publish') {
          const content = payload.page.properties?.['Content']?.rich_text?.[0]?.text?.content;
          const agent = new PublishingAgent(env);
          return await agent.publish({
            notionPageId: pageId,
            title: payload.page.properties?.Name?.title?.[0]?.text?.content,
            content: content,
            category: payload.page.properties?.Category?.select?.name,
            section: payload.page.properties?.Section?.select?.name,
            tags: payload.page.properties?.Tags?.multi_select?.map(t => t.name) || [],
            featured: payload.page.properties?.Featured?.checkbox || false
          });
        }
      }
      
      return new Response('Webhook processed', { status: 200 });
    });
    
    router.post('/webhook/github', async (req, env) => {
      const payload = await req.json();
      
      if (payload.ref === 'refs/heads/main' && payload.commits) {
        for (const commit of payload.commits) {
          if (commit.message.includes('[refresh-channels]')) {
            const agent = new DiscoveryAgent(env);
            await agent.loadConfig(); // Force refresh
            console.log('Channels refreshed via GitHub webhook');
          }
        }
      }
      
      return new Response('GitHub webhook processed', { status: 200 });
    });
    
    // BATCH OPERATIONS
    router.post('/batch/enhance', async (req, env) => {
      const { pageIds } = await req.json();
      const results = [];
      
      for (const pageId of pageIds) {
        try {
          const notionRes = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
            headers: {
              'Authorization': `Bearer ${env.NOTION_TOKEN}`,
              'Notion-Version': '2022-06-28'
            }
          });
          
          if (!notionRes.ok) continue;
          
          const page = await notionRes.json();
          const agent = new EnhancementAgent(env);
          
          const result = await agent.start({
            notionPageId: pageId,
            videoUrl: page.properties?.['Video URL']?.url,
            category: page.properties?.Category?.select?.name,
            section: page.properties?.Section?.select?.name,
            tags: page.properties?.Tags?.multi_select?.map(t => t.name) || []
          });
          
          results.push({ pageId, status: 'enhanced' });
        } catch (error) {
          results.push({ pageId, status: 'error', error: error.message });
        }
      }
      
      return new Response(JSON.stringify({ processed: results.length, results }), {
        headers: { 'Content-Type': 'application/json' }
      });
    });
    
    router.post('/batch/publish', async (req, env) => {
      const { pageIds } = await req.json();
      const results = [];
      
      for (const pageId of pageIds) {
        try {
          const notionRes = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
            headers: {
              'Authorization': `Bearer ${env.NOTION_TOKEN}`,
              'Notion-Version': '2022-06-28'
            }
          });
          
          if (!notionRes.ok) continue;
          
          const page = await notionRes.json();
          const contentBlock = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children`, {
            headers: {
              'Authorization': `Bearer ${env.NOTION_TOKEN}`,
              'Notion-Version': '2022-06-28'
            }
          });
          
          const blocks = await contentBlock.json();
          let content = '';
          
          for (const block of blocks.results) {
            if (block.type === 'code' && block.code?.language === 'markdown') {
              content = block.code.rich_text.map(t => t.text.content).join('');
              break;
            }
          }
          
          const agent = new PublishingAgent(env);
          const result = await agent.publish({
            notionPageId: pageId,
            title: page.properties?.Name?.title?.[0]?.text?.content,
            content: content,
            category: page.properties?.Category?.select?.name,
            section: page.properties?.Section?.select?.name,
            tags: page.properties?.Tags?.multi_select?.map(t => t.name) || [],
            featured: page.properties?.Featured?.checkbox || false
          });
          
          results.push({ pageId, status: 'published', url: result.url });
        } catch (error) {
          results.push({ pageId, status: 'error', error: error.message });
        }
      }
      
      return new Response(JSON.stringify({ processed: results.length, results }), {
        headers: { 'Content-Type': 'application/json' }
      });
    });
    
    // ANALYTICS & REPORTING
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
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    });
    
    // CACHE MANAGEMENT
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
    
    // SOCIAL MEDIA PREVIEW
    router.get('/social/preview/:id', async (req, env, ctx) => {
      const { id } = ctx.params;
      const socialData = await env.CONTENT_KV.get(`social:${id}`);
      
      if (!socialData) {
        return new Response('Social content not found', { status: 404 });
      }
      
      return new Response(socialData, {
        headers: { 'Content-Type': 'application/json' }
      });
    });
    
    // Handle the request
    return router.handle(request, env);
  },
  
  // QUEUE CONSUMER (for Cloudflare Queue integration)
  async queue(batch, env, ctx) {
    for (const message of batch.messages) {
      const { type, data } = message.body;
      
      try {
        switch(type) {
          case 'crosspost':
            await handleCrosspost(data, env);
            break;
          case 'enhance':
            const enhanceAgent = new EnhancementAgent(env);
            await enhanceAgent.start(data);
            break;
          case 'publish':
            const publishAgent = new PublishingAgent(env);
            await publishAgent.publish(data);
            break;
          case 'discover':
            const discoverAgent = new DiscoveryAgent(env);
            await discoverAgent.run();
            break;
        }
        message.ack();
      } catch (error) {
        console.error(`Queue processing error [${type}]:`, error);
        message.retry();
      }
    }
  },
  
  // SCHEDULED TRIGGER (for cron jobs)
  async scheduled(event, env, ctx) {
    console.log('Scheduled event:', event.cron);
    
    switch(event.cron) {
      case '0 */6 * * *': // Every 6 hours
        const agent = new DiscoveryAgent(env);
        await agent.run();
        break;
      case '0 9 * * 1': // Weekly on Monday 9am
        await env.CONTENT_KV.delete('creator_cache');
        console.log('Creator cache cleared for weekly refresh');
        break;
    }
  }
};

// ========== HELPER FUNCTIONS ==========

async function handleCrosspost(data, env) {
  const { notionPageId, platforms } = data;
  
  const socialData = await env.CONTENT_KV.get(`social:${notionPageId}`);
  if (!socialData) return new Response('No social content found', { status: 404 });
  
  const social = JSON.parse(socialData);
  const results = {};
  
  for (const platform of platforms) {
    try {
      switch(platform) {
        case 'medium':
          results.medium = await postToMedium(social, env);
          break;
        case 'devto':
          results.devto = await postToDevTo(social, env);
          break;
        case 'twitter':
          results.twitter = await postToTwitter(social.twitter, env);
          break;
        case 'linkedin':
          results.linkedin = await postToLinkedIn(social.linkedin, env);
          break;
      }
    } catch (error) {
      results[platform] = { error: error.message };
    }
  }
  
  return new Response(JSON.stringify(results), {
    headers: { 'Content-Type': 'application/json' }
  });
}

async function postToMedium(social, env) {
  // Medium API integration placeholder
  return { status: 'not_implemented' };
}

async function postToDevTo(social, env) {
  const response = await fetch('https://dev.to/api/articles', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': env.DEVTO_API_KEY
    },
    body: JSON.stringify({
      article: {
        title: social.devto?.title || social.title,
        body_markdown: social.content || '',
        tags: social.devto?.tags || [],
        published: false
      }
    })
  });
  
  if (!response.ok) {
    throw new Error(`Dev.to error: ${await response.text()}`);
  }
  
  const data = await response.json();
  return { url: data.url, id: data.id };
}

async function postToTwitter(thread, env) {
  // Twitter/X API v2 integration placeholder
  return { status: 'not_implemented', tweets: thread.split('\n\n').length };
}

async function postToLinkedIn(content, env) {
  // LinkedIn API integration placeholder
  return { status: 'not_implemented' };
}

async function handleNotification(data, env) {
  // Send email/Slack notification
  if (env.SLACK_WEBHOOK_URL) {
    await fetch(env.SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `📢 ${data.message}\n${data.url || ''}`
      })
    });
  }
  
  return new Response('Notification sent', { status: 200 });
}

async function handleIndexing(data, env) {
  // Submit to search engines
  if (data.url && env.BING_API_KEY) {
    await fetch('https://ssl.bing.com/webmaster/api.svc/json/SubmitUrlbatch?apikey=' + env.BING_API_KEY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        siteUrl: 'https://techfusionreport.com',
        urlList: [data.url]
      })
    });
  }
  
  return new Response('Indexing requested', { status: 200 });
}
