// Discovery Agent — TechFusion Report
// v6.0.0 — Channels sourced from Creator DB (Notion) instead of channels.json / KV
// Writes new records to Content Catalog v2 with correct schema properties
// and the Option D (Dashboard + Brand Forward) template pre-applied at creation time.

// ─── Content Type → Section/Category Mapping ────────────────────────────────
const CONTENT_TYPE_MAP = {
  '|| Tech ||':           { section: 'Technology',     category: 'Technology' },
  '|| Entertainment ||':  { section: 'Entertainment',  category: 'Entertainment' },
  'Productivity':         { section: 'Productivity',   category: 'Productivity' },
  'SmartPhone (GK)':      { section: 'Technology',     category: 'Mobile' },
  'Movies':               { section: 'Entertainment',  category: 'Movies' },
};

const DEFAULT_SECTION_CATEGORY = { section: 'Technology', category: 'Technology' };

class DiscoveryAgent {
  constructor(env) {
    this.env = env;
    this.creatorCache = null;
  }

  // ─── Load Channels from Creator DB ────────────────────────────────────────
  // Replaces the old loadConfig() / channels.json approach.
  // Queries Notion Creator DB, filters for Active = true, and maps records
  // to the channel shape used throughout the rest of the agent.
  async loadChannelsFromCreatorDB(config) {
    // Check KV cache first (5-min TTL so cron runs stay fast)
    const cached = await this.env.CONTENT_KV.get('creator_db_channels');
    if (cached) {
      const parsed = JSON.parse(cached);
      console.log(`Loaded ${parsed.length} channels from KV cache (Creator DB)`);
      return parsed;
    }

    console.log('Fetching active channels from Creator DB...');
    const channels = [];
    let cursor = undefined;
    let hasMore = true;

    const creatorDbId = config.creator_database_id || '0403b4267a54467a8bfd7dfb2cc4a7a8';

    while (hasMore) {
      const requestBody = {
        page_size: 100,
        filter: {
          property: 'Active',
          checkbox: { equals: true }
        }
      };
      if (cursor) requestBody.start_cursor = cursor;

      const response = await fetch(
        `https://api.notion.com/v1/databases/${creatorDbId}/query`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${config.notion_token}`,
            'Content-Type': 'application/json',
            'Notion-Version': '2022-06-28'
          },
          body: JSON.stringify(requestBody)
        }
      );

      if (!response.ok) {
        const err = await response.text();
        console.error('Failed to fetch Creator DB:', err);
        break;
      }

      const data = await response.json();

      for (const page of data.results) {
        const channel = this.mapCreatorPageToChannel(page);
        if (channel) channels.push(channel);
      }

      cursor = data.next_cursor;
      hasMore = data.has_more && !!cursor;
    }

    // Cache for 5 minutes so repeated cron triggers don't hammer Notion
    await this.env.CONTENT_KV.put('creator_db_channels', JSON.stringify(channels), {
      expirationTtl: 300
    });

    console.log(`Loaded ${channels.length} active channels from Creator DB`);
    return channels;
  }

  // Maps a single Notion Creator DB page to the internal channel shape
  mapCreatorPageToChannel(page) {
    const props = page.properties;

    // Channel ID — required; skip record if missing
    const channelId = props['Channel ID']?.rich_text?.[0]?.text?.content?.trim();
    if (!channelId) return null;

    // Name from title property
    const name = props['Content Creators']?.title?.[0]?.text?.content || 'Unknown';

    // Section + category from Content Type multi_select (use first value)
    const contentTypes = props['Content Type']?.multi_select?.map(t => t.name) || [];
    const primaryType = contentTypes[0] || null;
    const { section, category } = CONTENT_TYPE_MAP[primaryType] || DEFAULT_SECTION_CATEGORY;

    // Tags from Tags multi_select
    const tags = props['Tags']?.multi_select?.map(t => t.name) || [];

    // Auto-Approve lowers the min score threshold to 50 (always passes scoring)
    const autoApprove = props['Auto-Approve']?.checkbox === true;

    return {
      id: channelId,
      notionPageId: page.id,
      name,
      type: 'youtube',
      minScore: autoApprove ? 0 : 70,
      category,
      section,
      tags,
      featured: false
    };
  }

  // ─── Creator Cache (for relation linking when writing to Content Catalog) ──
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

    const creatorDbId = config.creator_database_id || '0403b4267a54467a8bfd7dfb2cc4a7a8';

    while (hasMore) {
      const requestBody = { page_size: 100 };
      if (cursor) requestBody.start_cursor = cursor;

      const response = await fetch(
        `https://api.notion.com/v1/databases/${creatorDbId}/query`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${config.notion_token}`,
            'Content-Type': 'application/json',
            'Notion-Version': '2022-06-28'
          },
          body: JSON.stringify(requestBody)
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
            name: page.properties['Content Creators']?.title?.[0]?.text?.content || 'Unknown',
            url: page.url
          });
        }
      }

      cursor = data.next_cursor;
      hasMore = data.has_more && !!cursor;
    }

    await this.env.CONTENT_KV.put('creator_cache', JSON.stringify(creators), {
      expirationTtl: 86400
    });
    this.creatorCache = creators;
    console.log(`Cached ${creators.length} creators`);
    return creators;
  }

  extractChannelId(page) {
    const properties = page.properties;

    // Primary: dedicated Channel ID field
    const channelIdProp = properties['Channel ID'];
    if (channelIdProp?.rich_text?.[0]) {
      return channelIdProp.rich_text[0].text.content.trim();
    }

    // Fallback: parse from Youtube URL field
    const youtubeProp = properties['Youtube'];
    if (youtubeProp?.url) {
      const match = youtubeProp.url.match(/channel\/(UC[\w\-]+)/);
      return match ? match[1] : youtubeProp.url;
    }

    return null;
  }

  async invalidateCreatorCache() {
    await this.env.CONTENT_KV.delete('creator_cache');
    await this.env.CONTENT_KV.delete('creator_db_channels');
    this.creatorCache = null;
    console.log('Creator cache invalidated');
  }

  // ─── Main Run ──────────────────────────────────────────────────────────────
  async run() {
    const config = JSON.parse(await this.env.CONTENT_KV.get('secrets') || '{}');

    // Load channels from Creator DB (replaces channels.json / KV channels_config)
    const channels = await this.loadChannelsFromCreatorDB(config);

    // Pre-warm creator cache for relation linking
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
        console.log(`Processing: ${channel.name} [${channel.type}] (${channel.id})`);
        switch (channel.type) {
          case 'youtube': {
            const r = await this.processYouTube(channel, config);
            results.youtube += r.processed;
            results.approved += r.approved;
            break;
          }
          case 'rss': {
            const r = await this.processRSS(channel, config);
            results.rss += r.processed;
            results.approved += r.approved;
            break;
          }
          case 'github': {
            const r = await this.processGitHub(channel, config);
            results.github += r.processed;
            results.approved += r.approved;
            break;
          }
          case 'hackernews': {
            const r = await this.processHackerNews(channel, config);
            results.hackernews += r.processed;
            results.approved += r.approved;
            break;
          }
        }
      } catch (error) {
        console.error(`Error processing ${channel.name}:`, error);
        results.errors.push({ channel: channel.name, error: error.message });
      }
    }

    await this.env.CONTENT_KV.put('last_discovery', JSON.stringify({
      timestamp: new Date().toISOString(),
      channelCount: channels.length,
      results
    }));

    return new Response(JSON.stringify(results), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // ─── Source Processors ─────────────────────────────────────────────────────
  async processYouTube(channel, config) {
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channel.id}&maxResults=10&order=date&type=video&key=${config.youtube_api_key}`;
    const response = await fetch(url);
    const data = await response.json();

    let processed = 0;
    let approved = 0;

    for (const item of data.items || []) {
      const videoId = item.id.videoId;
      const exists = await this.env.CONTENT_KV.get(`video:${videoId}`);
      if (exists) continue;

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
          thumbnail: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
          channelId: channel.id,
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
    // RSS feed processing — to be implemented
    return { processed: 0, approved: 0 };
  }

  async processGitHub(channel, config) {
    // GitHub releases processing — to be implemented
    return { processed: 0, approved: 0 };
  }

  async processHackerNews(channel, config) {
    // HackerNews processing — to be implemented
    return { processed: 0, approved: 0 };
  }

  // ─── AI Scoring ────────────────────────────────────────────────────────────
  async scoreContent(title, description, category) {
    const prompt = `Score 0-100 for ${category} tech blog relevance.
Title: "${title}"
Description: "${description?.substring(0, 500)}"
Consider: technical depth, tutorial potential, evergreen value, audience interest.
Return only the number.`;

    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${this.env.GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
        }
      );
      const data = await response.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '50';
      const match = text.match(/\d+/);
      return match ? parseInt(match[0]) : 50;
    } catch (error) {
      console.error('Scoring failed:', error);
      return 50;
    }
  }

  // ─── Template Builder ───────────────────────────────────────────────────────
  buildTemplateBlocks(video, channel, dateAdded) {
    const t = (text, bold = false, color = 'default') => ({
      type: 'text',
      text: { content: text },
      annotations: { bold, color }
    });

    return [
      // ── TFR Branded Header ────────────────────────────────────────────────
      {
        object: 'block',
        type: 'callout',
        callout: {
          rich_text: [
            t('⚡ TECHFUSION REPORT\n', true),
            t('Technology · Entertainment · Productivity\n', false, 'gray'),
            t(`${channel.category}`, false, 'blue'),
            t(` · ${channel.name} · ${dateAdded}`, false, 'gray')
          ],
          icon: { emoji: '⚡' },
          color: 'gray_background'
        }
      },
      // ── Pipeline Status Banner ────────────────────────────────────────────
      {
        object: 'block',
        type: 'callout',
        callout: {
          rich_text: [
            t('🟡 PIPELINE STATUS: ', true),
            t('🟡 Pending Review', false, 'yellow'),
            t(` · Added ${dateAdded}`, false, 'gray')
          ],
          icon: { emoji: '🟡' },
          color: 'yellow_background'
        }
      },
      { object: 'block', type: 'divider', divider: {} },
      // ── Two-Column: Embed + Record Info ───────────────────────────────────
      {
        object: 'block',
        type: 'column_list',
        column_list: {
          children: [
            {
              object: 'block',
              type: 'column',
              column: {
                children: [
                  { object: 'block', type: 'embed', embed: { url: video.url } }
                ]
              }
            },
            {
              object: 'block',
              type: 'column',
              column: {
                children: [
                  {
                    object: 'block',
                    type: 'callout',
                    callout: {
                      rich_text: [
                        t('📊 RECORD INFO\n', true),
                        t('Channel: ', true), t(`${channel.name}\n`),
                        t('Section: ', true), t(`${channel.section}\n`),
                        t('Category: ', true), t(`${channel.category}\n`),
                        t('Source: ', true), t('YouTube\n'),
                        t('Added: ', true), t(`${dateAdded}\n`),
                        t('Tags: ', true),
                        t((channel.tags || []).map(tag => `${tag}`).join(' '))
                      ],
                      icon: { emoji: '📊' },
                      color: 'blue_background'
                    }
                  }
                ]
              }
            }
          ]
        }
      },
      { object: 'block', type: 'divider', divider: {} },
      // ── Gemini AI Brief ───────────────────────────────────────────────────
      {
        object: 'block',
        type: 'callout',
        callout: {
          rich_text: [
            t('🤖 GEMINI — AI BRIEF\n', true),
            t('2–3 sentence summary populates here when the Enhancement agent runs. Key points, main takeaways, standout moments.', false, 'gray')
          ],
          icon: { emoji: '🤖' },
          color: 'purple_background'
        }
      },
      { object: 'block', type: 'divider', divider: {} },
      // ── TFR Blog Draft (toggle) ───────────────────────────────────────────
      {
        object: 'block',
        type: 'toggle',
        toggle: {
          rich_text: [t('⚡ TFR BLOG DRAFT', true)],
          children: [
            {
              object: 'block',
              type: 'paragraph',
              paragraph: {
                rich_text: [t('Full Gemini-generated blog post populates here after transcription is approved.', false, 'gray')]
              }
            }
          ]
        }
      },
      // ── Short Form (toggle) ───────────────────────────────────────────────
      {
        object: 'block',
        type: 'toggle',
        toggle: {
          rich_text: [t('✂️ SHORT FORM', true)],
          children: [
            {
              object: 'block',
              type: 'paragraph',
              paragraph: { rich_text: [t('Short-form content populates here.', false, 'gray')] }
            }
          ]
        }
      },
      // ── Social Copy Panel (toggle) ────────────────────────────────────────
      {
        object: 'block',
        type: 'toggle',
        toggle: {
          rich_text: [t('📲 SOCIAL COPY PANEL', true)],
          children: [
            {
              object: 'block',
              type: 'callout',
              callout: {
                rich_text: [
                  t('𝕏 / Twitter\n', true), t('...\n\n', false, 'gray'),
                  t('Instagram\n', true), t('...\n\n', false, 'gray'),
                  t('Reddit\n', true), t('...\n\n', false, 'gray'),
                  t('LinkedIn\n', true), t('...', false, 'gray')
                ],
                icon: { emoji: '📲' },
                color: 'green_background'
              }
            }
          ]
        }
      },
      // ── SEO & Discoverability (toggle) ────────────────────────────────────
      {
        object: 'block',
        type: 'toggle',
        toggle: {
          rich_text: [t('🔍 SEO & DISCOVERABILITY', true)],
          children: [
            {
              object: 'block',
              type: 'callout',
              callout: {
                rich_text: [
                  t('Slug: ', true), t('—\n', false, 'gray'),
                  t('Meta Description: ', true), t('...\n', false, 'gray'),
                  t('Focus Keywords: ', true), t('...\n', false, 'gray'),
                  t('Internal Links: ', true), t('Gemini-suggested internal links based on Category + Tags match.', false, 'gray')
                ],
                icon: { emoji: '🔍' },
                color: 'orange_background'
              }
            }
          ]
        }
      },
      { object: 'block', type: 'divider', divider: {} },
      // ── Pre-Publish Checklist ─────────────────────────────────────────────
      {
        object: 'block',
        type: 'callout',
        callout: {
          rich_text: [t('✅ READY TO PUBLISH?', true)],
          icon: { emoji: '✅' },
          color: 'green_background',
          children: [
            { object: 'block', type: 'to_do', to_do: { rich_text: [t('Thumbnail confirmed')], checked: false } },
            { object: 'block', type: 'to_do', to_do: { rich_text: [t('YouTube embed working')], checked: false } },
            { object: 'block', type: 'to_do', to_do: { rich_text: [t('SEO slug set')], checked: false } },
            { object: 'block', type: 'to_do', to_do: { rich_text: [t('Category & Section tagged')], checked: false } },
            { object: 'block', type: 'to_do', to_do: { rich_text: [t('Short form ready')], checked: false } },
            { object: 'block', type: 'to_do', to_do: { rich_text: [t('Blog draft reviewed & approved')], checked: false } },
            { object: 'block', type: 'to_do', to_do: { rich_text: [t('Related posts linked')], checked: false } }
          ]
        }
      }
    ];
  }

  // ─── Write to Notion ────────────────────────────────────────────────────────
  async writeToNotion(video, channel, config) {
    const creators = await this.loadCreatorCache(config);
    const creator = creators.find(c => c.channelId === channel.id);

    console.log(`Writing to Notion: ${video.title}`);
    if (creator) console.log(`Creator match: ${creator.name}`);

    const dateAdded = new Date().toISOString().split('T')[0];

    const properties = {
      'Title': { title: [{ text: { content: video.title } }] },
      '🎬 Video URL': { url: video.url },
      '🆔 Video ID': { rich_text: [{ text: { content: video.id } }] },
      '📺 Channel ID': { rich_text: [{ text: { content: channel.id } }] },
      '🖼️ Thumbnail': { url: video.thumbnail || `https://img.youtube.com/vi/${video.id}/maxresdefault.jpg` },
      'Status': { status: { name: '🟡 Pending Review' } },
      '🗂️ Category': { select: { name: channel.category } },
      '🗂️ Section': { select: { name: channel.section } },
      '🔖 Tags': { multi_select: (channel.tags || []).map(tag => ({ name: tag })) },
      'Featured': { checkbox: channel.featured || false },
      'Source': { multi_select: [{ name: 'RSS' }] },
      '📅 Date Added': { date: { start: dateAdded } }
    };

    if (creator) {
      properties['Content Creator'] = { relation: [{ id: creator.id }] };
    }

    const payload = {
      parent: {
        database_id: config.notion_database_id || '1fbbd080-de92-8043-89aa-dc02853c15c7'
      },
      properties,
      children: this.buildTemplateBlocks(video, channel, dateAdded)
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

    const page = await response.json();
    console.log(`Created Notion page: ${page.id}`);
    return page;
  }
}

export default DiscoveryAgent;
