// Discovery Agent — RSS-based, no YouTube API quota
export class DiscoveryAgent {
  constructor(env) {
    this.env = env;
    this.creatorCache = null;
  }

  // ── Channel config ────────────────────────────────────────────
  async loadConfig() {
    const stored = await this.env.CONTENT_KV.get('channels_config');
    if (stored) return JSON.parse(stored);
    // Fallback default — replace with your real channels_config in KV
    return [
      {
        id: "UC_x5XG1OV2P6uZZ5FSM9Ttw",
        name: "Google Developers",
        type: "youtube",
        section: "Technology",
        tags: ["Cloud", "api"],
        featured: false
      }
    ];
  }

  // ── Creator cache (Notion Content Creators DB) ────────────────
  async loadCreatorCache(config) {
    if (this.creatorCache) return this.creatorCache;

    const cached = await this.env.CONTENT_KV.get('creator_cache');
    if (cached) {
      this.creatorCache = JSON.parse(cached);
      return this.creatorCache;
    }

    console.log('Fetching creator cache from Notion...');
    const creators = [];
    let cursor = undefined;
    let hasMore = true;

    while (hasMore) {
      const body = { page_size: 100 };
      if (cursor) body.start_cursor = cursor;

      const response = await fetch(
        `https://api.notion.com/v1/databases/${config.creator_database_id}/query`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${config.notion_token}`,
            'Content-Type': 'application/json',
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
            id: page.id,
            channelId,
            name: page.properties.Name?.title?.[0]?.text?.content || 'Unknown'
          });
        }
      }

      cursor = data.next_cursor;
      hasMore = data.has_more && !!cursor;
    }

    await this.env.CONTENT_KV.put('creator_cache', JSON.stringify(creators), {
      expirationTtl: 86400 // 24 hours
    });
    this.creatorCache = creators;
    console.log(`Cached ${creators.length} creators`);
    return creators;
  }

  extractChannelId(page) {
    const props = page.properties;
    const candidates = ['Channel ID', '📺 Channel ID', 'channel_id', 'ChannelID', 'YouTube ID', 'ID'];
    for (const name of candidates) {
      const prop = props[name];
      if (!prop) continue;
      if (prop.rich_text?.[0]) return prop.rich_text[0].text.content.trim();
      if (prop.title?.[0])     return prop.title[0].text.content.trim();
    }
    return null;
  }

  async invalidateCreatorCache() {
    await this.env.CONTENT_KV.delete('creator_cache');
    this.creatorCache = null;
    console.log('Creator cache invalidated');
  }

  // ── Main run ──────────────────────────────────────────────────
  async run() {
    const config   = JSON.parse(await this.env.CONTENT_KV.get('secrets') || '{}');
    const channels = await this.loadConfig();

    await this.loadCreatorCache(config);

    const results = { processed: 0, added: 0, skipped: 0, errors: [] };

    for (const channel of channels) {
      try {
        console.log(`Processing: ${channel.name} [${channel.type}]`);
        const result = await this.processYouTubeRSS(channel, config);
        results.processed += result.processed;
        results.added     += result.added;
        results.skipped   += result.skipped;
      } catch (err) {
        console.error(`Error processing ${channel.name}:`, err.message);
        results.errors.push({ channel: channel.name, error: err.message });
      }
    }

    await this.env.CONTENT_KV.put('last_discovery', JSON.stringify({
      timestamp: new Date().toISOString(),
      results
    }));

    console.log(`Discovery complete — processed: ${results.processed}, added: ${results.added}, skipped: ${results.skipped}, errors: ${results.errors.length}`);

    return new Response(JSON.stringify(results), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // ── YouTube RSS (zero quota) ───────────────────────────────────
  async processYouTubeRSS(channel, config) {
    const rssUrl  = `https://www.youtube.com/feeds/videos.xml?channel_id=${channel.id}`;
    const response = await fetch(rssUrl);

    if (!response.ok) {
      throw new Error(`RSS fetch failed for ${channel.name}: ${response.status}`);
    }

    const xml = await response.text();
    const entries = this.parseRSSEntries(xml);

    let processed = 0, added = 0, skipped = 0;

    for (const entry of entries) {
      processed++;

      // Dedup check — skip if already seen
      const key = `video:${entry.videoId}`;
      const exists = await this.env.CONTENT_KV.get(key);
      if (exists) { skipped++; continue; }

      // Mark as seen (30 day TTL)
      await this.env.CONTENT_KV.put(key, '1', { expirationTtl: 2592000 });

      // Write to Notion
      await this.writeToNotion(entry, channel, config);
      added++;

      console.log(`Added: ${entry.title}`);
    }

    return { processed, added, skipped };
  }

  // ── RSS parser (regex-based, no DOM needed in Workers) ────────
  parseRSSEntries(xml) {
    const entries = [];
    const entryBlocks = xml.match(/<entry>[\s\S]*?<\/entry>/g) || [];

    for (const block of entryBlocks) {
      const videoId    = this.extractTag(block, 'yt:videoId');
      const title      = this.decodeXml(this.extractTag(block, 'title'));
      const published  = this.extractTag(block, 'published');
      const thumbnail  = this.extractAttr(block, 'media:thumbnail', 'url');
      const description = this.decodeXml(this.extractTag(block, 'media:description') || '');

      if (!videoId || !title) continue;

      entries.push({
        videoId,
        title,
        published: published || new Date().toISOString(),
        videoUrl: `https://youtube.com/watch?v=${videoId}`,
        thumbnail: thumbnail || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        description: description.substring(0, 500)
      });
    }

    return entries;
  }

  extractTag(xml, tag) {
    const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
    return match ? match[1].trim() : null;
  }

  extractAttr(xml, tag, attr) {
    const match = xml.match(new RegExp(`<${tag}[^>]*${attr}="([^"]*)"[^>]*>`));
    return match ? match[1] : null;
  }

  decodeXml(str) {
    if (!str) return '';
    return str
      .replace(/&amp;/g,  '&')
      .replace(/&lt;/g,   '<')
      .replace(/&gt;/g,   '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g,  "'")
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  }

  // ── Write to Notion Content Catalog v2 ────────────────────────
  async writeToNotion(video, channel, config) {
    const creators = await this.loadCreatorCache(config);
    const creator  = creators.find(c => c.channelId === channel.id);

    if (creator) {
      console.log(`Matched creator: ${creator.name}`);
    } else {
      console.log(`No creator match for channel: ${channel.id}`);
    }

    const properties = {
      // Title
      "Title": {
        title: [{ text: { content: video.title } }]
      },
      // Video URL
      "🎬 Video URL": { url: video.videoUrl },
      // Video ID
      "🆔 Video ID": {
        rich_text: [{ text: { content: video.videoId } }]
      },
      // Channel ID
      "📺 Channel ID": {
        rich_text: [{ text: { content: channel.id } }]
      },
      // Thumbnail
      "🖼️ Thumbnail": { url: video.thumbnail },
      // Section (Technology / Entertainment / Productivity)
      "🗂️ Section": {
        select: { name: channel.section || "Technology" }
      },
      // Status — pending human review
      "Status": {
        status: { name: "🟡 Pending Review" }
      },
      // Source
      "Source": {
        multi_select: [{ name: "RSS" }]
      },
      // Date Added
      "📅 Date Added": {
        date: { start: video.published.split('T')[0] }
      },
      // Tags
      "🔖 Tags": {
        multi_select: (channel.tags || []).map(t => ({ name: t }))
      },
      // Featured
      "Featured": { checkbox: channel.featured || false },
      // Checkboxes default to false
      "Approved for Transcription?": { checkbox: false },
      "🚀 Publish to GitHub":         { checkbox: false },
      "✅ Published To Github":        { checkbox: false }
    };

    // Content Creator relation
    if (creator) {
      properties["Content Creator"] = {
        relation: [{ id: creator.id }]
      };
    }

    const payload = {
      parent: { database_id: "1fbbd080de92804389aadc02853c15c7" },
      properties
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
      const err = await response.text();
      throw new Error(`Notion write failed: ${err}`);
    }

    return await response.json();
  }
}