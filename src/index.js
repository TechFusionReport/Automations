// TechFusion Agents - Complete Worker
// File: src/index.js

// Router
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
      return new Response(JSON.stringify({ error: error.message }), { 
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
}

// Discovery Agent with Creator Caching
class DiscoveryAgent {
  constructor(env) {
    this.env = env;
    this.creatorCache = null;
  }

  async loadConfig() {
  // Primary: Load from KV (fast, updatable)
  const stored = await this.env.CONTENT_KV.get('channels_config');
  if (stored) {
    return JSON.parse(stored);
  }
  
  // Fallback: Fetch from GitHub raw URL
  try {
    const response = await fetch('https://raw.githubusercontent.com/TechFusionReport/Automations/main/config/channels.json');
    if (response.ok) {
      const channels = await response.json();
      // Cache in KV for next time
      await this.env.CONTENT_KV.put('channels_config', JSON.stringify(channels));
      return channels;
    }
  } catch (e) {
    console.error('Failed to load channels:', e);
  }
  
  // Emergency fallback: minimal config
  return [{
    id: "UC_x5XG1OV2P6uZZ5FSM9Ttw",
    name: "Google Developers",
    type: "youtube",
    minScore: 75,
    category: "Web Development",
    section: "engineering",
    tags: ["cloud"],
    featured: false
  }];
}


  async loadCreatorCache(config) {
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
      
      const response = await fetch(`https://api.notion.com/v1/databases/${config.creator_database_id}/query`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.notion_token}`,
          'Content-Type': 'application/json',
          'Notion-Version': '2022-06-28'
        },
        body: JSON.stringify(requestBody)
      });
      
      if (!response.ok) break;
      
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
    const config = {
      notion_token: this.env.NOTION_TOKEN,
      notion_database_id: this.env.NOTION_DATABASE_ID,
      creator_database_id: this.env.CREATOR_DATABASE_ID,
      youtube_api_key: this.env.YOUTUBE_API_KEY,
      gemini_api_key: this.env.GEMINI_API_KEY
    };
    
    const channels = await this.loadConfig();
    await this.loadCreatorCache(config);
    
    const results = { youtube: 0, approved: 0, errors: [] };

    for (const channel of channels) {
      try {
        if (channel.type === 'youtube') {
          const yt = await this.processYouTube(channel, config);
          results.youtube += yt.processed;
          results.approved += yt.approved;
        }
      } catch (error) {
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

  async processYouTube(channel, config) {
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channel.id}&maxResults=10&order=date&type=video&key=${config.youtube_api_key}`;
    const response = await fetch(url);
    const data = await response.json();
    
    let processed = 0;
    let approved = 0;

    for (const item of data.items || []) {
      const videoId = item.id.videoId;
      if (await this.env.CONTENT_KV.get(`video:${videoId}`)) continue;

      const score = await this.scoreContent(item.snippet.title, item.snippet.description, channel.category, config.gemini_api_key);

      await this.env.CONTENT_KV.put(`video:${videoId}`, JSON.stringify({
        title: item.snippet.title, score, processedAt: Date.now()
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
        }, channel, config);
        approved++;
      }
    }

    return { processed, approved };
  }

  async scoreContent(title, description, category, apiKey) {
    const prompt = `Score 0-100 for ${category} tech blog relevance. Title: "${title}" Description: "${description?.substring(0, 500)}". Return only the number.`;

    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
      });

      const data = await response.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '50';
      const match = text.match(/\d+/);
      return match ? parseInt(match[0]) : 50;
    } catch {
      return 50;
    }
  }

  async writeToNotion(video, channel, config) {
    const creators = await this.loadCreatorCache(config);
    const creator = creators.find(c => c.channelId === channel.id);
    
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

    await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.notion_token}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-
