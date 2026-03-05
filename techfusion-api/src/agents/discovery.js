// Discovery Agent with Content Creator Caching
export class DiscoveryAgent {
  constructor(env) {
    this.env = env;
    this.creatorCache = null;
  }

  async loadConfig() {
    const stored = await this.env.CONTENT_KV.get('channels_config');
    if (stored) return JSON.parse(stored);
    
    return [
      {
        id: "UC_x5XG1OV2P6uZZ5FSM9Ttw",
        name: "Google Developers",
        type: "youtube",
        minScore: 75,
        category: "Web Development",
        section: "engineering",
        tags: ["cloud", "api", "performance"],
        featured: false
      }
    ];
  }

  async loadCreatorCache(config) {
    // Check memory cache first (within same request)
    if (this.creatorCache) {
      return this.creatorCache;
    }
    
    // Check KV cache
    const cached = await this.env.CONTENT_KV.get('creator_cache');
    if (cached) {
      this.creatorCache = JSON.parse(cached);
      return this.creatorCache;
    }
    
    // Fetch all creators from Notion
    console.log('Fetching creator cache from Notion...');
    const creators = [];
    let cursor = undefined;
    let hasMore = true;
    
    while (hasMore) {
      const requestBody = {
        page_size: 100
      };
      
      if (cursor) {
        requestBody.start_cursor = cursor;
      }
      
      const response = await fetch(`https://api.notion.com/v1/databases/${config.creator_database_id}/query`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.notion_token}`,
          'Content-Type': 'application/json',
          'Notion-Version': '2022-06-28'
        },
        body: JSON.stringify(requestBody)
      });
      
      if (!response.ok) {
        const error = await response.text();
        console.error('Failed to fetch creators:', error);
        break;
      }
      
      const data = await response.json();
      
      for (const page of data.results) {
        // Try multiple property names for channel ID
        const channelId = this.extractChannelId(page);
        
        if (channelId) {
          creators.push({
            id: page.id,
            channelId: channelId,
            name: page.properties.Name?.title?.[0]?.text?.content || 'Unknown',
            url: page.url
          });
        }
      }
      
      cursor = data.next_cursor;
      hasMore = data.has_more && cursor;
    }
    
    // Cache in KV for 24 hours
    await this.env.CONTENT_KV.put('creator_cache', JSON.stringify(creators), {
      expirationTtl: 86400
    });
    
    // Also cache in memory for this request
    this.creatorCache = creators;
    
    console.log(`Cached ${creators.length} creators`);
    return creators;
  }

  extractChannelId(page) {
    const properties = page.properties;
    
    // Try common property names for channel ID
    const possibleNames = ['Channel ID', 'channel_id', 'ChannelID', 'YouTube ID', 'YouTube', 'ID'];
    
    for (const name of possibleNames) {
      const prop = properties[name];
      
      if (prop) {
        // Handle different property types
        if (prop.rich_text && prop.rich_text[0]) {
          return prop.rich_text[0].text.content.trim();
        }
        if (prop.title && prop.title[0]) {
          return prop.title[0].text.content.trim();
        }
        if (prop.url) {
          // Extract from URL
          const match = prop.url.match(/channel\/(UC[\w-]+)/);
          return match ? match[1] : prop.url;
        }
      }
    }
    
    return null;
  }

  async invalidateCreatorCache() {
    await this.env.CONTENT_KV.delete('creator_cache');
    this.creatorCache = null;
    console.log('Creator cache invalidated');
  }

  async run() {
    const config = JSON.parse(await this.env.CONTENT_KV.get('secrets') || '{}');
    const channels = await this.loadConfig();
    
    // Pre-load creator cache
    await this.loadCreatorCache(config);
    
    const results = {
      youtube: 0,
      rss: 0,
      github: 0,
      hackernews: 0,
      approved: 0,
      errors: []
    };

    for (const channel of channels) {
      try {
        console.log(`Processing: ${channel.name} [${channel.type}]`);
        
        switch (channel.type) {
          case 'youtube':
            const ytResult = await this.processYouTube(channel, config);
            results.youtube += ytResult.processed;
            results.approved += ytResult.approved;
            break;
          case 'rss':
            const rssResult = await this.processRSS(channel, config);
            results.rss += rssResult.processed;
            results.approved += rssResult.approved;
            break;
          case 'github':
            const ghResult = await this.processGitHub(channel, config);
            results.github += ghResult.processed;
            results.approved += ghResult.approved;
            break;
          case 'hackernews':
            const hnResult = await this.processHackerNews(channel, config);
            results.hackernews += hnResult.processed;
            results.approved += hnResult.approved;
            break;
        }
      } catch (error) {
        console.error(`Error processing ${channel.name}:`, error);
        results.errors.push({ channel: channel.name, error: error.message });
      }
    }

    // Log results
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
      
      // Check if already processed
      const exists = await this.env.CONTENT_KV.get(`video:${videoId}`);
      if (exists) continue;

      // Score content
      const score = await this.scoreContent(
        item.snippet.title,
        item.snippet.description,
        channel.category
      );

      // Mark as processed
      await this.env.CONTENT_KV.put(`video:${videoId}`, JSON.stringify({
        title: item.snippet.title,
        channel: channel.name,
        score,
        processedAt: Date.now()
      }), { expirationTtl: 2592000 });

      processed++;

      // Write to Notion if score passes threshold
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

  async processRSS(channel, config) {
    // Similar structure for RSS feeds
    return { processed: 0, approved: 0 };
  }

  async processGitHub(channel, config) {
    // Similar structure for GitHub releases
    return { processed: 0, approved: 0 };
  }

  async processHackerNews(channel, config) {
    // Similar structure for HN
    return { processed: 0, approved: 0 };
  }

  async scoreContent(title, description, category) {
    const prompt = `Score 0-100 for ${category} tech blog relevance.
Title: "${title}"
Description: "${description?.substring(0, 500)}"

Consider: technical depth, tutorial potential, evergreen value, audience interest.
Return only the number.`;

    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${this.env.GEMINI_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }]
        })
      });

      const data = await response.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '50';
      const match = text.match(/\d+/);
      return match ? parseInt(match[0]) : 50;
    } catch (error) {
      console.error('Scoring failed:', error);
      return 50; // Default score on error
    }
  }

  async writeToNotion(video, channel, config) {
    // Find matching creator from cache
    const creators = await this.loadCreatorCache(config);
    const creator = creators.find(c => c.channelId === channel.id);
    
    console.log(`Writing to Notion: ${video.title}`);
    console.log(`Creator match: ${creator ? creator.name : 'None found'}`);

    // Build properties
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

    // Add Content Creator relation if found
    if (creator) {
      properties["Content Creator"] = {
        relation: [{ id: creator.id }]
      };
      
      // Also store creator name for easy reference
      properties["Creator Name"] = {
        rich_text: [{ text: { content: creator.name } }]
      };
    } else {
      // Fallback: store channel name from config
      properties["Creator Name"] = {
        rich_text: [{ text: { content: channel.name } }]
      };
    }

    const payload = {
      parent: { database_id: config.notion_database_id },
      properties: properties
    };

    const response = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.notion_token}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Notion API error: ${error}`);
    }

    return await response.json();
  }
}
