// Discovery Agent — TechFusion Report
// v6.1.0 — RSS processor implemented
//           HackerNews trending discovery added (free, no API key)
//           Source Type detection: YouTube (Channel ID) | RSS (Website field)

const CONTENT_TYPE_MAP = {
  '|| Tech ||':          { section: 'Technology',    category: 'Technology' },
  '|| Entertainment ||': { section: 'Entertainment', category: 'Entertainment' },
  'Productivity':        { section: 'Productivity',  category: 'Productivity' },
  'SmartPhone (GK)':    { section: 'Technology',    category: 'Mobile' },
  'Movies':             { section: 'Entertainment', category: 'Movies' },
};
const DEFAULT_SECTION_CATEGORY = { section: 'Technology', category: 'Technology' };

// ─── RSS XML Parser ──────────────────────────────────────────────────────────
// Handles RSS 2.0 and Atom without any dependencies.
function parseRSS(xml) {
  const items = [];
  const itemRegex = /<(?:item|entry)[\s>]([\s\S]*?)<\/(?:item|entry)>/gi;
  let match;

  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];

    const get = (tag) => {
      const r = new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))</${tag}>`, 'i');
      const m = r.exec(block);
      return m ? (m[1] || m[2] || '').trim() : '';
    };
    const getAttr = (tag, attr) => {
      const r = new RegExp(`<${tag}[^>]*${attr}="([^"]*)"`, 'i');
      const m = r.exec(block);
      return m ? m[1].trim() : '';
    };

    let link = get('link') || getAttr('link', 'href');
    const title = get('title');
    const description = get('description') || get('summary') || get('content');
    const pubDate = get('pubDate') || get('published') || get('updated');
    const guid = get('guid') || get('id') || link;

    if (title && link) items.push({ title, link, description, pubDate, guid });
  }
  return items;
}

// ─── HackerNews API ──────────────────────────────────────────────────────────
async function fetchHackerNewsTop(minScore = 150, limit = 15) {
  const topRes = await fetch('https://hacker-news.firebaseio.com/v0/topstories.json');
  const ids = (await topRes.json()).slice(0, 20);

  const stories = await Promise.all(
    ids.map(async (id) => {
      try {
        const res = await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`);
        const story = await res.json();
        return story?.score >= minScore && story?.url ? story : null;
      } catch { return null; }
    })
  );

  return stories.filter(Boolean).sort((a, b) => b.score - a.score).slice(0, limit);
}

class DiscoveryAgent {
  constructor(env) {
    this.env = env;
    this.creatorCache = null;
  }

  // ─── Load Channels from Creator DB ─────────────────────────────────────────
  async loadChannelsFromCreatorDB(config) {
    const cached = await this.env.CONTENT_KV.get('creator_db_channels');
    if (cached) {
      const parsed = JSON.parse(cached);
      console.log(`Loaded ${parsed.length} channels from KV cache`);
      return parsed;
    }

    console.log('Fetching active channels from Creator DB...');
    const channels = [];
    let cursor, hasMore = true;
    const creatorDbId = config.creator_database_id || '0403b4267a54467a8bfd7dfb2cc4a7a8';

    while (hasMore) {
      const body = { page_size: 100, filter: { property: 'Active', checkbox: { equals: true } } };
      if (cursor) body.start_cursor = cursor;

      const res = await fetch(`https://api.notion.com/v1/databases/${creatorDbId}/query`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.notion_token}`,
          'Content-Type': 'application/json',
          'Notion-Version': '2022-06-28'
        },
        body: JSON.stringify(body)
      });

      if (!res.ok) { console.error('Creator DB fetch failed:', await res.text()); break; }
      const data = await res.json();
      for (const page of data.results) {
        const ch = this.mapCreatorPageToChannel(page);
        if (ch) channels.push(ch);
      }
      cursor = data.next_cursor;
      hasMore = data.has_more && !!cursor;
    }

    await this.env.CONTENT_KV.put('creator_db_channels', JSON.stringify(channels), { expirationTtl: 300 });
    console.log(`Loaded ${channels.length} active channels from Creator DB`);
    return channels;
  }

  mapCreatorPageToChannel(page) {
    const props = page.properties;
    const channelId  = props['Channel ID']?.rich_text?.[0]?.text?.content?.trim();
    const websiteUrl = props['Website']?.url?.trim() || props['Website']?.rich_text?.[0]?.text?.content?.trim();
    const name = props['Content Creators']?.title?.[0]?.text?.content || 'Unknown';
    const contentTypes = props['Content Type']?.multi_select?.map(t => t.name) || [];
    const { section, category } = CONTENT_TYPE_MAP[contentTypes[0]] || DEFAULT_SECTION_CATEGORY;
    const tags = props['Tags']?.multi_select?.map(t => t.name) || [];
    const minScore = props['Auto-Approve']?.checkbox ? 0 : 70;
    const base = { notionPageId: page.id, name, section, category, tags, featured: false, minScore };

    if (channelId)  return { ...base, type: 'youtube', id: channelId };
    if (websiteUrl) return { ...base, type: 'rss', id: page.id, feedUrl: websiteUrl };
    return null;
  }

  // ─── Creator Cache ──────────────────────────────────────────────────────────
  async loadCreatorCache(config) {
    if (this.creatorCache) return this.creatorCache;
    const cached = await this.env.CONTENT_KV.get('creator_cache');
    if (cached) { this.creatorCache = JSON.parse(cached); return this.creatorCache; }

    const creators = [];
    let cursor, hasMore = true;
    const creatorDbId = config.creator_database_id || '0403b4267a54467a8bfd7dfb2cc4a7a8';

    while (hasMore) {
      const body = { page_size: 100 };
      if (cursor) body.start_cursor = cursor;
      const res = await fetch(`https://api.notion.com/v1/databases/${creatorDbId}/query`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${config.notion_token}`, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' },
        body: JSON.stringify(body)
      });
      if (!res.ok) break;
      const data = await res.json();
      for (const page of data.results) {
        const channelId = this.extractChannelId(page);
        if (channelId) creators.push({ id: page.id, channelId, name: page.properties['Content Creators']?.title?.[0]?.text?.content || 'Unknown' });
      }
      cursor = data.next_cursor;
      hasMore = data.has_more && !!cursor;
    }

    await this.env.CONTENT_KV.put('creator_cache', JSON.stringify(creators), { expirationTtl: 86400 });
    this.creatorCache = creators;
    return creators;
  }

  extractChannelId(page) {
    const props = page.properties;
    if (props['Channel ID']?.rich_text?.[0]) return props['Channel ID'].rich_text[0].text.content.trim();
    const ytUrl = props['Youtube']?.url;
    if (ytUrl) { const m = ytUrl.match(/channel\/(UC[\w\-]+)/); return m ? m[1] : ytUrl; }
    return null;
  }

  async invalidateCreatorCache() {
    await this.env.CONTENT_KV.delete('creator_cache');
    await this.env.CONTENT_KV.delete('creator_db_channels');
    this.creatorCache = null;
  }

  // ─── Main Run ───────────────────────────────────────────────────────────────
  async run(batchSize = 5) {
    const config = JSON.parse(await this.env.CONTENT_KV.get('secrets') || '{}');
    const allChannels = await this.loadChannelsFromCreatorDB(config);
    await this.loadCreatorCache(config);

    // Rotate through channels across cron runs to stay within subrequest limits
    const offsetRaw = await this.env.CONTENT_KV.get('discovery_offset');
    const offset = offsetRaw ? parseInt(offsetRaw) : 0;
    const channels = allChannels.slice(offset, offset + batchSize);
    const nextOffset = (offset + batchSize) >= allChannels.length ? 0 : offset + batchSize;
    await this.env.CONTENT_KV.put('discovery_offset', String(nextOffset));

    const results = { youtube: 0, rss: 0, hackernews: 0, approved: 0, errors: [], batchOffset: offset, totalChannels: allChannels.length };

    // HackerNews runs unconditionally — free trending signal layer
    try {
      const hn = await this.processHackerNews(config);
      results.hackernews += hn.processed;
      results.approved += hn.approved;
    } catch (e) { results.errors.push({ channel: 'HackerNews', error: e.message }); }

    for (const channel of channels) {
      try {
        console.log(`Processing: ${channel.name} [${channel.type}]`);
        if (channel.type === 'youtube') {
          const r = await this.processYouTube(channel, config);
          results.youtube += r.processed; results.approved += r.approved;
        } else if (channel.type === 'rss') {
          const r = await this.processRSS(channel, config);
          results.rss += r.processed; results.approved += r.approved;
        }
      } catch (e) {
        console.error(`Error: ${channel.name}:`, e);
        results.errors.push({ channel: channel.name, error: e.message });
      }
    }

    await this.env.CONTENT_KV.put('last_discovery', JSON.stringify({ timestamp: new Date().toISOString(), channelCount: allChannels.length, batchOffset: offset, batchSize: channels.length, results }));
    return new Response(JSON.stringify(results), { headers: { 'Content-Type': 'application/json' } });
  }

  // ─── YouTube Processor ──────────────────────────────────────────────────────
  async processYouTube(channel, config) {
    const res = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channel.id}&maxResults=10&order=date&type=video&key=${config.youtube_api_key}`);
    const data = await res.json();
    let processed = 0, approved = 0;

    for (const item of data.items || []) {
      const videoId = item.id.videoId;
      if (await this.env.CONTENT_KV.get(`video:${videoId}`)) continue;
      const score = await this.scoreContent(item.snippet.title, item.snippet.description, channel.category);
      await this.env.CONTENT_KV.put(`video:${videoId}`, JSON.stringify({ title: item.snippet.title, score, processedAt: Date.now() }), { expirationTtl: 2592000 });
      processed++;
      if (score > channel.minScore && approved < 3) {
        await this.writeToNotion({ id: videoId, title: item.snippet.title, description: item.snippet.description, url: `https://youtube.com/watch?v=${videoId}`, thumbnail: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`, channelId: channel.id, publishedAt: item.snippet.publishedAt, score, sourceType: 'YouTube' }, channel, config);
        approved++;
      }
    }
    return { processed, approved };
  }

  // ─── RSS Processor ──────────────────────────────────────────────────────────
  async processRSS(channel, config) {
    console.log(`RSS: fetching ${channel.name} — ${channel.feedUrl}`);
    let xml;
    try {
      const res = await fetch(channel.feedUrl, { headers: { 'User-Agent': 'TechFusionReport/1.0 RSS Reader' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      xml = await res.text();
    } catch (e) { console.error(`RSS fetch failed for ${channel.name}:`, e.message); return { processed: 0, approved: 0 }; }

    const items = parseRSS(xml);
    console.log(`RSS: ${items.length} items from ${channel.name}`);
    let processed = 0, approved = 0;

    for (const item of items) {
      const keyRaw = (item.guid || item.link).slice(-40);
      const key = `rss:${btoa(keyRaw).replace(/[^a-zA-Z0-9]/g, '').slice(0, 32)}`;
      if (await this.env.CONTENT_KV.get(key)) continue;

      const score = await this.scoreContent(item.title, item.description, channel.category);
      await this.env.CONTENT_KV.put(key, JSON.stringify({ title: item.title, score, processedAt: Date.now() }), { expirationTtl: 2592000 });
      processed++;

      if (score > channel.minScore && approved < 3) {
        const thumbnail = (item.description?.match(/<img[^>]+src=["']([^"']+)["']/i) || [])[1]
          || 'https://techfusionreport.github.io/graphics/tech_nb.png';

        await this.writeToNotion({
          id: key.replace('rss:', ''),
          title: item.title,
          description: (item.description || '').replace(/<[^>]+>/g, '').slice(0, 500),
          url: item.link,
          thumbnail,
          channelId: channel.notionPageId,
          publishedAt: item.pubDate || new Date().toISOString(),
          score,
          sourceType: 'RSS'
        }, channel, config);
        approved++;
      }
    }
    return { processed, approved };
  }

  // ─── HackerNews Processor ───────────────────────────────────────────────────
  async processHackerNews(config) {
    const stories = await fetchHackerNewsTop(150, 15);
    let processed = 0, approved = 0;

    for (const story of stories) {
      const key = `hn:${story.id}`;
      if (await this.env.CONTENT_KV.get(key)) continue;
      const category = this.inferCategory(story.title);
      const score = await this.scoreContent(story.title, story.text || '', category);
      await this.env.CONTENT_KV.put(key, JSON.stringify({ title: story.title, score, processedAt: Date.now() }), { expirationTtl: 604800 });
      processed++;

      if (score > 65) {
        const channel = { id: 'hackernews', notionPageId: null, name: 'Hacker News', section: 'Technology', category, tags: ['Trending', 'HackerNews'], featured: false, minScore: 65 };
        await this.writeToNotion({ id: `hn-${story.id}`, title: story.title, description: `HN Score: ${story.score} | ${story.descendants || 0} comments`, url: story.url, thumbnail: 'https://techfusionreport.github.io/graphics/tech_nb.png', channelId: null, publishedAt: new Date(story.time * 1000).toISOString(), score, sourceType: 'HackerNews' }, channel, config);
        approved++;
      }
    }
    return { processed, approved };
  }

  inferCategory(title = '') {
    if (/movie|film|show|netflix|disney|series|stream/i.test(title)) return 'Entertainment';
    if (/productivity|notion|obsidian|workflow|automation/i.test(title)) return 'Productivity';
    return 'Technology';
  }

  // ─── AI Scoring ─────────────────────────────────────────────────────────────
  async scoreContent(title, description, category) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${this.env.GEMINI_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: `Score 0-100 for ${category} tech blog relevance.\nTitle: "${title}"\nDescription: "${(description||'').slice(0,500)}"\nReturn only the number.` }] }] })
      });
      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '50';
      const m = text.match(/\d+/);
      return m ? parseInt(m[0]) : 50;
    } catch { return 50; }
  }

  // ─── Template Builder ────────────────────────────────────────────────────────
  buildTemplateBlocks(video, channel, dateAdded) {
    const t = (text, bold = false, color = 'default') => ({ type: 'text', text: { content: text }, annotations: { bold, color } });
    return [
      { object: 'block', type: 'callout', callout: { rich_text: [t('⚡ TECHFUSION REPORT\n', true), t('Technology · Entertainment · Productivity\n', false, 'gray'), t(`${channel.category}`, false, 'blue'), t(` · ${channel.name} · ${dateAdded}`, false, 'gray')], icon: { emoji: '⚡' }, color: 'gray_background' } },
      { object: 'block', type: 'callout', callout: { rich_text: [t('🟡 PIPELINE STATUS: ', true), t('🟡 Pending Review', false, 'yellow'), t(` · Added ${dateAdded}`, false, 'gray')], icon: { emoji: '🟡' }, color: 'yellow_background' } },
      { object: 'block', type: 'divider', divider: {} },
      { object: 'block', type: 'column_list', column_list: { children: [
        { object: 'block', type: 'column', column: { children: [{ object: 'block', type: 'embed', embed: { url: video.url } }] } },
        { object: 'block', type: 'column', column: { children: [{ object: 'block', type: 'callout', callout: { rich_text: [t('📊 RECORD INFO\n', true), t('Channel: ', true), t(`${channel.name}\n`), t('Section: ', true), t(`${channel.section}\n`), t('Category: ', true), t(`${channel.category}\n`), t('Source: ', true), t(`${video.sourceType || 'YouTube'}\n`), t('Added: ', true), t(`${dateAdded}\n`), t('Tags: ', true), t((channel.tags||[]).join(' '))], icon: { emoji: '📊' }, color: 'blue_background' } }] } }
      ] } },
      { object: 'block', type: 'divider', divider: {} },
      { object: 'block', type: 'callout', callout: { rich_text: [t('🤖 GEMINI — AI BRIEF\n', true), t('Populates when Enhancement agent runs.', false, 'gray')], icon: { emoji: '🤖' }, color: 'purple_background' } },
      { object: 'block', type: 'divider', divider: {} },
      { object: 'block', type: 'toggle', toggle: { rich_text: [t('⚡ TFR BLOG DRAFT', true)], children: [{ object: 'block', type: 'paragraph', paragraph: { rich_text: [t('Blog post populates here after enhancement.', false, 'gray')] } }] } },
      { object: 'block', type: 'toggle', toggle: { rich_text: [t('✂️ SHORT FORM', true)], children: [{ object: 'block', type: 'paragraph', paragraph: { rich_text: [t('Short-form content populates here.', false, 'gray')] } }] } },
      { object: 'block', type: 'toggle', toggle: { rich_text: [t('📲 SOCIAL COPY PANEL', true)], children: [{ object: 'block', type: 'callout', callout: { rich_text: [t('𝕏 / Twitter\n', true), t('...\n\n', false, 'gray'), t('Instagram\n', true), t('...\n\n', false, 'gray'), t('Reddit\n', true), t('...\n\n', false, 'gray'), t('LinkedIn\n', true), t('...', false, 'gray')], icon: { emoji: '📲' }, color: 'green_background' } }] } },
      { object: 'block', type: 'toggle', toggle: { rich_text: [t('🔍 SEO & DISCOVERABILITY', true)], children: [{ object: 'block', type: 'callout', callout: { rich_text: [t('Slug: ', true), t('—\n', false, 'gray'), t('Meta Description: ', true), t('...\n', false, 'gray'), t('Focus Keywords: ', true), t('...', false, 'gray')], icon: { emoji: '🔍' }, color: 'orange_background' } }] } },
      { object: 'block', type: 'divider', divider: {} },
      { object: 'block', type: 'callout', callout: { rich_text: [t('✅ READY TO PUBLISH?', true)], icon: { emoji: '✅' }, color: 'green_background', children: [
        { object: 'block', type: 'to_do', to_do: { rich_text: [t('Thumbnail confirmed')], checked: false } },
        { object: 'block', type: 'to_do', to_do: { rich_text: [t('Embed working')], checked: false } },
        { object: 'block', type: 'to_do', to_do: { rich_text: [t('SEO slug set')], checked: false } },
        { object: 'block', type: 'to_do', to_do: { rich_text: [t('Category & Section tagged')], checked: false } },
        { object: 'block', type: 'to_do', to_do: { rich_text: [t('Blog draft reviewed')], checked: false } }
      ] } }
    ];
  }

  // ─── Write to Notion ─────────────────────────────────────────────────────────
  async writeToNotion(video, channel, config) {
    const creators = await this.loadCreatorCache(config);
    const creator = creators.find(c => c.channelId === channel.id);
    const dateAdded = new Date().toISOString().split('T')[0];

    const properties = {
      'Title': { title: [{ text: { content: video.title } }] },
      '🎬 Video URL': { url: video.url },
      '🆔 Video ID': { rich_text: [{ text: { content: video.id } }] },
      '📺 Channel ID': { rich_text: [{ text: { content: channel.id || '' } }] },
      '🖼️ Thumbnail': { url: video.thumbnail },
      'Status': { status: { name: '🟡 Pending Review' } },
      '🗂️ Category': { select: { name: channel.category } },
      '🗂️ Section': { select: { name: channel.section } },
      '🔖 Tags': { multi_select: (channel.tags || []).map(tag => ({ name: tag })) },
      'Featured': { checkbox: false },
      'Source': { multi_select: [{ name: video.sourceType || 'RSS' }] },
      '📅 Date Added': { date: { start: dateAdded } }
    };

    if (creator) properties['Content Creator'] = { relation: [{ id: creator.id }] };

    const res = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${config.notion_token}`, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' },
      body: JSON.stringify({ parent: { database_id: config.notion_database_id || '1fbbd080-de92-8043-89aa-dc02853c15c7' }, properties, children: this.buildTemplateBlocks(video, channel, dateAdded) })
    });

    if (!res.ok) throw new Error(`Notion API error: ${await res.text()}`);
    const page = await res.json();
    console.log(`Created Notion page: ${page.id}`);
    return page;
  }
}

export default DiscoveryAgent;
