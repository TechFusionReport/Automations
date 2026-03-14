// ============================================================
// TechFusion Report — Discovery Agent
// Path: src/agents/discovery.js
//
// FIXES IN THIS VERSION:
// 1. Type normalization — "YouTube Channel" in channels.json
//    now correctly maps to the 'youtube' switch case
// 2. writeToNotion — all property names now match
//    Content Catalog v2 schema exactly (emoji prefixes,
//    correct types: status vs select, multi_select for Source)
// 3. Thumbnail URL auto-populated from YouTube video ID
// 4. Video ID and Channel ID written to Notion
// 5. Creator Name property removed (doesn't exist in v2)
// 6. Status uses correct v2 value: "🟡 Pending Review"
// ============================================================

class DiscoveryAgent {
  constructor(env) {
    this.env = env;
    this.creatorCache = null;
    this.config = null;
  }

  // ── Normalize type strings from channels.json ──────────────
  // channels.json uses "YouTube Channel", "RSS Feed", etc.
  // The switch statement needs lowercase short forms.
  normalizeType(rawType = '') {
    const t = rawType.toLowerCase();
    if (t.includes('youtube'))     return 'youtube';
    if (t.includes('rss'))         return 'rss';
    if (t.includes('github'))      return 'github';
    if (t.includes('hackernews') || t.includes('hacker news')) return 'hackernews';
    return t; // pass through if already normalized
  }

  // ── Config: load channel list from KV → GitHub → fallback ──
  async loadConfig() {
    const stored = await this.env.CONTENT_KV.get('channels_config');
    if (stored) {
      const channels = JSON.parse(stored);
      console.log(`Loaded ${channels.length} channels from KV`);
      return channels;
    }

    try {
      const response = await fetch(
        'https://raw.githubusercontent.com/TechFusionReport/Automations/main/config/channels.json'
      );
      if (response.ok) {
        const channels = await response.json();
        await this.env.CONTENT_KV.put('channels_config', JSON.stringify(channels));
        console.log(`Loaded ${channels.length} channels from GitHub`);
        return channels;
      }
    } catch (e) {
      console.error('Failed to load channels from GitHub:', e);
    }

    console.warn('Using emergency fallback channel config');
    return [{
      id:       'UC_x5XG1OV2P6uZZ5FSM9Ttw',
      name:     'Google Developers',
      type:     'youtube',
      minScore: 75,
      category: 'Tech Reviews',
      section:  'Technology',
      tags:     ['cloud', 'api', 'performance'],
      featured: false
    }];
  }

  // ── Creator cache: Notion Content Creator DB → KV (24h) ────
  async loadCreatorCache() {
    if (this.creatorCache) return this.creatorCache;

    const cached = await this.env.CONTENT_KV.get('creator_cache');
    if (cached) {
      this.creatorCache = JSON.parse(cached);
      return this.creatorCache;
    }

    const creators = [];
    let cursor  = undefined;
    let hasMore = true;

    while (hasMore) {
      const body = { page_size: 100 };
      if (cursor) body.start_cursor = cursor;

      const response = await fetch(
        `https://api.notion.com/v1/databases/${this.env.CREATOR_DATABASE_ID}/query`,
        {
          method:  'POST',
          headers: {
            'Authorization':  `Bearer ${this.env.NOTION_TOKEN}`,
            'Content-Type':   'application/json',
            'Notion-Version': '2022-06-28'
          },
          body: JSON.stringify(body)
        }
      );

      if (!response.ok) {
        console.error('Failed to fetch creators:', await response.text());
        break;
      }

      const data = await response.json();

      for (const page of data.results) {
        const channelId = this.extractChannelId(page);
        if (channelId) {
          creators.push({
            id:        page.id,
            channelId: channelId,
            name:      page.properties.Name?.title?.[0]?.text?.content || 'Unknown'
          });
        }
      }

      cursor  = data.next_cursor;
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
      if (prop?.title?.[0])     return prop.title[0].text.content.trim();
    }
    return null;
  }

  async invalidateCreatorCache() {
    await this.env.CONTENT_KV.delete('creator_cache');
    this.creatorCache = null;
    console.log('Creator cache invalidated');
  }

  // ── Main run loop ───────────────────────────────────────────
  async run() {
    this.config = {
      notion_token:        this.env.NOTION_TOKEN,
      notion_database_id:  this.env.NOTION_DATABASE_ID,
      creator_database_id: this.env.CREATOR_DATABASE_ID,
      youtube_api_key:     this.env.YOUTUBE_API_KEY,
      gemini_api_key:      this.env.GEMINI_API_KEY
    };

    const channels = await this.loadConfig();
    await this.loadCreatorCache();

    const results = {
      total:     channels.length,
      processed: 0,
      approved:  0,
      byType:    {},
      errors:    []
    };

    for (const channel of channels) {
      try {
        // ✅ Normalize type so "YouTube Channel" hits the right case
        const type = this.normalizeType(channel.type);
        console.log(`Processing: ${channel.name} [${type}]`);

        let channelResult = { processed: 0, approved: 0 };

        switch (type) {
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
          default:
            console.warn(`Unknown channel type "${type}" for ${channel.name} — skipping`);
        }

        results.processed               += channelResult.processed;
        results.approved                += channelResult.approved;
        results.byType[type]             = (results.byType[type] || 0) + channelResult.processed;

      } catch (error) {
        console.error(`Error processing ${channel.name}:`, error);
        results.errors.push({ channel: channel.name, error: error.message });
      }
    }

    await this.env.CONTENT_KV.put('last_discovery', JSON.stringify({
      timestamp: new Date().toISOString(),
      results
    }));

    return new Response(JSON.stringify(results, null, 2), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // ── YouTube processor ───────────────────────────────────────
  async processYouTube(channel) {
    const url =
      `https://www.googleapis.com/youtube/v3/search` +
      `?part=snippet` +
      `&channelId=${channel.id}` +
      `&maxResults=5` +
      `&order=date` +
      `&type=video` +
      `&key=${this.config.youtube_api_key}`;

    const response = await fetch(url);
    const data     = await response.json();

    if (data.error) {
      throw new Error(`YouTube API error: ${data.error.message}`);
    }

    let processed = 0;
    let approved  = 0;

    for (const item of data.items || []) {
      const videoId = item.id.videoId;

      // Skip if already in KV cache (processed in last 30 days)
      const exists = await this.env.CONTENT_KV.get(`video:${videoId}`);
      if (exists) continue;

      const score = await this.scoreContent(
        item.snippet.title,
        item.snippet.description,
        channel.category
      );

      // Mark as processed to avoid duplicates
      await this.env.CONTENT_KV.put(`video:${videoId}`, JSON.stringify({
        title:       item.snippet.title,
        channel:     channel.name,
        score,
        processedAt: Date.now()
      }), { expirationTtl: 2592000 }); // 30 days

      processed++;

      if (score >= (channel.minScore || 70)) {
        await this.writeToNotion({
          id:           videoId,
          title:        item.snippet.title,
          description:  item.snippet.description,
          url:          `https://youtube.com/watch?v=${videoId}`,
          // ✅ Thumbnail from YouTube's CDN — no extra API call needed
          thumbnail:    `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
          channelId:    channel.id,
          channelTitle: item.snippet.channelTitle,
          publishedAt:  item.snippet.publishedAt,
          score
        }, channel);
        approved++;
      }
    }

    return { processed, approved };
  }

  // ── RSS processor (stub — ready to implement) ───────────────
  async processRSS(channel) {
    // TODO: fetch channel.url, parse XML, score, writeToNotion
    console.log(`RSS not yet implemented for: ${channel.name}`);
    return { processed: 0, approved: 0 };
  }

  // ── GitHub releases processor (stub) ───────────────────────
  async processGitHub(channel) {
    // TODO: fetch https://api.github.com/repos/{owner}/{repo}/releases
    console.log(`GitHub not yet implemented for: ${channel.name}`);
    return { processed: 0, approved: 0 };
  }

  // ── Hacker News processor (stub) ───────────────────────────
  async processHackerNews(channel) {
    // TODO: fetch https://hacker-news.firebaseio.com/v0/topstories.json
    console.log(`HackerNews not yet implemented for: ${channel.name}`);
    return { processed: 0, approved: 0 };
  }

  // ── Gemini scoring ──────────────────────────────────────────
  async scoreContent(title, description, category) {
    const prompt =
      `Score this YouTube video 0-100 for relevance to a "${category}" tech blog.\n` +
      `Title: "${title}"\n` +
      `Description: "${(description || '').substring(0, 500)}"\n\n` +
      `Consider: technical depth, tutorial value, evergreen appeal, audience interest.\n` +
      `Return only the number, nothing else.`;

    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent` +
        `?key=${this.config.gemini_api_key}`,
        {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
        }
      );
      const data  = await response.json();
      const text  = data.candidates?.[0]?.content?.parts?.[0]?.text || '50';
      const match = text.match(/\d+/);
      return match ? parseInt(match[0]) : 50;
    } catch (error) {
      console.error('Scoring failed:', error);
      return 50;
    }
  }

  // ── Write to Content Catalog v2 ─────────────────────────────
  // ✅ All property names and types match Content Catalog v2 schema
  async writeToNotion(video, channel) {
    const creator = this.creatorCache?.find(c => c.channelId === channel.id);

    // Map channel.section to the exact Notion select option values
    // v2 Section options: "Entertainment" | "Productivity" | "Technology"
    const sectionMap = {
      'technology':   'Technology',
      'productivity': 'Productivity',
      'entertainment':'Entertainment'
    };
    const section = sectionMap[(channel.section || '').toLowerCase()] || 'Technology';

    // Published date — strip time component for Notion date field
    const publishedDate = video.publishedAt
      ? video.publishedAt.split('T')[0]
      : new Date().toISOString().split('T')[0];

    const properties = {
      // ── Title (title type) ──────────────────────────────────
      'Title': {
        title: [{ text: { content: video.title } }]
      },

      // ── Core video fields ───────────────────────────────────
      '🎬 Video URL': {
        url: video.url
      },
      '🆔 Video ID': {
        rich_text: [{ text: { content: video.id } }]
      },
      '🖼️ Thumbnail': {
        url: video.thumbnail
      },
      '📺 Channel ID': {
        rich_text: [{ text: { content: video.channelId } }]
      },
      '📅 Published Date': {
        date: { start: publishedDate }
      },

      // ── Status (status type, not select) ───────────────────
      // v2 value: "🟡 Pending Review"
      'Status': {
        status: { name: '🟡 Pending Review' }
      },

      // ── Categorization ──────────────────────────────────────
      '🗂️ Section': {
        select: { name: section }
      },

      // ── Source (multi_select in v2, not select) ─────────────
      'Source': {
        multi_select: [{ name: 'YouTube' }]
      },

      // ── Tags (multi_select) ─────────────────────────────────
      '🔖 Tags': {
        multi_select: (channel.tags || []).map(tag => ({ name: tag }))
      },

      // ── Featured (checkbox) ─────────────────────────────────
      'Featured': {
        checkbox: channel.featured === true
      }
    };

    // ── Content Creator relation (if found in cache) ──────────
    if (creator) {
      properties['Content Creator'] = {
        relation: [{ id: creator.id }]
      };
    }

    const payload = {
      parent:     { database_id: this.config.notion_database_id },
      properties: properties
    };

    const response = await fetch('https://api.notion.com/v1/pages', {
      method:  'POST',
      headers: {
        'Authorization':  `Bearer ${this.config.notion_token}`,
        'Content-Type':   'application/json',
        'Notion-Version': '2022-06-28'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Notion API error: ${error}`);
    }

    const result = await response.json();
    console.log(`✅ Written to Notion: "${video.title}" (${creator ? creator.name : 'no creator match'})`);
    return result;
  }
}

export { DiscoveryAgent };
