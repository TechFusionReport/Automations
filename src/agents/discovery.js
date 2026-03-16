// Discovery Agent — TechFusion Report
// Writes new records to Content Catalog v2 with correct schema properties
// and the Option D (Dashboard + Brand Forward) template pre-applied at creation time.

class DiscoveryAgent {
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
        category: "AI Tools",
        section: "Technology",
        tags: ["Cloud", "api", "Back End"],
        featured: false
      }
    ];
  }

  // ─── Creator Cache ──────────────────────────────────────────────────────────

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
      const requestBody = { page_size: 100 };
      if (cursor) requestBody.start_cursor = cursor;

      const response = await fetch(
        `https://api.notion.com/v1/databases/${config.creator_database_id}/query`,
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
            name: page.properties.Name?.title?.[0]?.text?.content || 'Unknown',
            url: page.url
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
    const properties = page.properties;
    const possibleNames = ['Channel ID', 'channel_id', 'ChannelID', 'YouTube ID', 'YouTube', 'ID'];

    for (const name of possibleNames) {
      const prop = properties[name];
      if (!prop) continue;
      if (prop.rich_text?.[0]) return prop.rich_text[0].text.content.trim();
      if (prop.title?.[0]) return prop.title[0].text.content.trim();
      if (prop.url) {
        const match = prop.url.match(/channel\/(UC[\w-]+)/);
        return match ? match[1] : prop.url;
      }
    }
    return null;
  }

  async invalidateCreatorCache() {
    await this.env.CONTENT_KV.delete('creator_cache');
    this.creatorCache = null;
    console.log('Creator cache invalidated');
  }

  // ─── Main Run ───────────────────────────────────────────────────────────────

  async run() {
    const config = JSON.parse(await this.env.CONTENT_KV.get('secrets') || '{}');
    const channels = await this.loadConfig();

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
      results
    }));

    return new Response(JSON.stringify(results), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // ─── Source Processors ──────────────────────────────────────────────────────

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

  // ─── AI Scoring ─────────────────────────────────────────────────────────────

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

  // ─── Template Builder ────────────────────────────────────────────────────────
  // Builds the Option D (Dashboard + Brand Forward) block structure.
  // These blocks are passed as `children` in the page creation call so every
  // new record lands pre-formatted — no separate stamper step required.

  buildTemplateBlocks(video, channel, dateAdded) {
    const t = (text, bold = false, color = 'default') => ({
      type: 'text',
      text: { content: text },
      annotations: { bold, color }
    });

    return [
      // ── TFR Branded Header ──────────────────────────────────────────────────
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

      // ── Pipeline Status Banner ──────────────────────────────────────────────
      {
        object: 'block',
        type: 'callout',
        callout: {
          rich_text: [
            t('🟡 PIPELINE STATUS: ', true),
            t('🟡 Pending Review', false, 'yellow'),
            t(`   ·   Added ${dateAdded}`, false, 'gray')
          ],
          icon: { emoji: '🟡' },
          color: 'yellow_background'
        }
      },

      { object: 'block', type: 'divider', divider: {} },

      // ── Two-Column: Embed + Record Info ─────────────────────────────────────
      {
        object: 'block',
        type: 'column_list',
        column_list: {
          children: [
            // Left: YouTube embed
            {
              object: 'block',
              type: 'column',
              column: {
                children: [
                  {
                    object: 'block',
                    type: 'embed',
                    embed: { url: video.url }
                  }
                ]
              }
            },
            // Right: Record info callout
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
                        t((channel.tags || []).map(tag => `${tag}`).join('  '))
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

      // ── Gemini AI Brief ─────────────────────────────────────────────────────
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

      // ── TFR Blog Draft (toggle) ─────────────────────────────────────────────
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

      // ── Short Form (toggle) ─────────────────────────────────────────────────
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

      // ── Social Copy Panel (toggle) ──────────────────────────────────────────
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
                  t('𝕏 / Twitter\n', true),
                  t('...\n\n', false, 'gray'),
                  t('Instagram\n', true),
                  t('...\n\n', false, 'gray'),
                  t('Reddit\n', true),
                  t('...\n\n', false, 'gray'),
                  t('LinkedIn\n', true),
                  t('...', false, 'gray')
                ],
                icon: { emoji: '📲' },
                color: 'green_background'
              }
            }
          ]
        }
      },

      // ── SEO & Discoverability (toggle) ──────────────────────────────────────
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

      // ── Pre-Publish Checklist ───────────────────────────────────────────────
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

  // ─── Write to Notion ─────────────────────────────────────────────────────────
  // Uses correct Content Catalog v2 property names from the actual schema.
  // Template blocks are passed as `children` — no separate apply step needed.

  async writeToNotion(video, channel, config) {
    const creators = await this.loadCreatorCache(config);
    const creator = creators.find(c => c.channelId === channel.id);

    console.log(`Writing to Notion: ${video.title}`);
    if (creator) console.log(`Creator match: ${creator.name}`);

    const dateAdded = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

    // ── Properties (matching v2 schema exactly) ──────────────────────────────
    const properties = {
      // Title (title property)
      'Title': {
        title: [{ text: { content: video.title } }]
      },
      // Video URL
      '🎬 Video URL': { url: video.url },
      // Video ID
      '🆔 Video ID': {
        rich_text: [{ text: { content: video.id } }]
      },
      // Channel ID
      '📺 Channel ID': {
        rich_text: [{ text: { content: channel.id } }]
      },
      // Thumbnail
      '🖼️ Thumbnail': {
        url: video.thumbnail || `https://img.youtube.com/vi/${video.id}/maxresdefault.jpg`
      },
      // Status (status type — not select)
      'Status': {
        status: { name: '🟡 Pending Review' }
      },
      // Category (select)
      '🗂️ Category': {
        select: { name: channel.category }
      },
      // Section (select)
      '🗂️ Section': {
        select: { name: channel.section }
      },
      // Tags (multi_select)
      '🔖 Tags': {
        multi_select: (channel.tags || []).map(tag => ({ name: tag }))
      },
      // Featured (checkbox)
      'Featured': {
        checkbox: channel.featured || false
      },
      // Source (multi_select — not select)
      'Source': {
        multi_select: [{ name: 'RSS' }]
      },
      // Date Added
      '📅 Date Added': {
        date: { start: dateAdded }
      }
    };

    // Content Creator relation
    if (creator) {
      properties['Content Creator'] = {
        relation: [{ id: creator.id }]
      };
    }

    // ── Page Creation with Template Blocks ───────────────────────────────────
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
