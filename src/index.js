/// TechFusion Agents - Complete Worker
// File: src/index.js

// ========== ROUTER ==========
class Router {
  constructor() {
    this.routes = new Map();
  }
  get(path, handler)    { this.routes.set(`GET:${path}`, handler); }
  post(path, handler)   { this.routes.set(`POST:${path}`, handler); }
  delete(path, handler) { this.routes.set(`DELETE:${path}`, handler); }

  async handle(request, env) {
    const url = new URL(request.url);
    const key = `${request.method}:${url.pathname}`;
    const handler = this.routes.get(key);
    if (!handler) return new Response('Not Found', { status: 404 });
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
    const stored = await this.env.CONTENT_KV.get('channels_config');
    if (stored) {
      const channels = JSON.parse(stored);
      console.log(`Loaded ${channels.length} channels from KV`);
      return channels;
    }
    try {
      const response = await fetch('https://raw.githubusercontent.com/TechFusionReport/Automations/main/config/channels.json');
      if (response.ok) {
        const channels = await response.json();
        await this.env.CONTENT_KV.put('channels_config', JSON.stringify(channels));
        console.log(`Loaded ${channels.length} channels from GitHub`);
        return channels;
      }
    } catch (e) {
      console.error('Failed to load from GitHub:', e);
    }
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
            channelId,
            name: page.properties.Name?.title?.[0]?.text?.content || 'Unknown'
          });
        }
      }
      cursor = data.next_cursor;
      hasMore = data.has_more && cursor;
    }
    await this.env.CONTENT_KV.put('creator_cache', JSON.stringify(creators), { expirationTtl: 86400 });
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
  }

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
    const results = { total: channels.length, processed: 0, approved: 0, byType: {}, errors: [] };

    for (const channel of channels) {
      try {
        console.log(`Processing: ${channel.name} [${channel.type}]`);
        let channelResult = { processed: 0, approved: 0 };
        switch (channel.type) {
          case 'youtube':    channelResult = await this.processYouTube(channel);    break;
          case 'rss':        channelResult = await this.processRSS(channel);        break;
          case 'github':     channelResult = await this.processGitHub(channel);     break;
          case 'hackernews': channelResult = await this.processHackerNews(channel); break;
        }
        results.processed += channelResult.processed;
        results.approved  += channelResult.approved;
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

    return new Response(JSON.stringify(results), { headers: { 'Content-Type': 'application/json' } });
  }

  // ── YouTube ──────────────────────────────────────────────
  async processYouTube(channel) {
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channel.id}&maxResults=5&order=date&type=video&key=${this.config.youtube_api_key}`;
    const response = await fetch(url);
    const data = await response.json();
    let processed = 0, approved = 0;

    for (const item of data.items || []) {
      const videoId = item.id.videoId;
      if (await this.env.CONTENT_KV.get(`video:${videoId}`)) continue;

      const score = await this.scoreContent(
        item.snippet.title,
        item.snippet.description,
        channel.category,
        channel.id
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

  // ── RSS (supports RSS 2.0 + Atom) ────────────────────────
  async processRSS(channel) {
    // channel.id = full RSS feed URL
    let processed = 0, approved = 0;
    try {
      const response = await fetch(channel.id, {
        headers: { 'User-Agent': 'TechFusionReport-Bot/1.0' }
      });
      if (!response.ok) {
        console.error(`RSS fetch failed for ${channel.name}: ${response.status}`);
        return { processed, approved };
      }
      const xml = await response.text();
      const items = [];

      // RSS 2.0: <item> blocks
      const rssMatches = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];
      for (const match of rssMatches) {
        const block = match[1];
        const title   = this.xmlText(block, 'title');
        const link    = this.xmlText(block, 'link') || this.xmlAttr(block, 'guid');
        const pubDate = this.xmlText(block, 'pubDate');
        const desc    = this.xmlText(block, 'description');
        if (title && link) items.push({ title, link, pubDate, desc });
      }

      // Atom: <entry> blocks (fallback)
      if (items.length === 0) {
        const atomMatches = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)];
        for (const match of atomMatches) {
          const block = match[1];
          const title   = this.xmlText(block, 'title');
          const link    = this.xmlAttr(block, 'link', 'href') || this.xmlText(block, 'link');
          const pubDate = this.xmlText(block, 'published') || this.xmlText(block, 'updated');
          const desc    = this.xmlText(block, 'summary') || this.xmlText(block, 'content');
          if (title && link) items.push({ title, link, pubDate, desc });
        }
      }

      const cutoff = Date.now() - (3 * 24 * 60 * 60 * 1000);

      for (const item of items.slice(0, 10)) {
        const cacheKey = `rss:${btoa(item.link).substring(0, 40)}`;
        if (await this.env.CONTENT_KV.get(cacheKey)) continue;

        if (item.pubDate && new Date(item.pubDate).getTime() < cutoff) continue;

        const score = await this.scoreContent(item.title, item.desc, channel.category);

        await this.env.CONTENT_KV.put(cacheKey, JSON.stringify({
          title: item.title,
          channel: channel.name,
          score,
          processedAt: Date.now()
        }), { expirationTtl: 2592000 });

        processed++;

        if (score > (channel.minScore || 70)) {
          await this.writeToNotion({
            id: cacheKey,
            title: item.title,
            description: item.desc,
            url: item.link,
            channelTitle: channel.name,
            publishedAt: item.pubDate || new Date().toISOString(),
            score
          }, channel);
          approved++;
        }
      }
    } catch (err) {
      console.error(`RSS processing error for ${channel.name}:`, err);
    }
    return { processed, approved };
  }

  // ── GitHub Releases ───────────────────────────────────────
  async processGitHub(channel) {
    // channel.id = "owner/repo" e.g. "vercel/next.js"
    let processed = 0, approved = 0;
    try {
      const response = await fetch(
        `https://api.github.com/repos/${channel.id}/releases?per_page=5`,
        {
          headers: {
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'TechFusionReport-Bot/1.0',
            ...(this.env.GITHUB_TOKEN && { 'Authorization': `token ${this.env.GITHUB_TOKEN}` })
          }
        }
      );
      if (!response.ok) {
        console.error(`GitHub releases fetch failed for ${channel.id}: ${response.status}`);
        return { processed, approved };
      }
      const releases = await response.json();
      const cutoff = Date.now() - (7 * 24 * 60 * 60 * 1000);

      for (const release of releases) {
        if (release.draft || release.prerelease) continue;
        const cacheKey = `gh:${channel.id}:${release.id}`.replace(/\//g, '-');
        if (await this.env.CONTENT_KV.get(cacheKey)) continue;
        if (new Date(release.published_at).getTime() < cutoff) continue;

        const title = `${channel.name} ${release.tag_name} Released: ${release.name || 'New Update'}`;
        const desc  = release.body ? release.body.substring(0, 500) : '';
        const score = await this.scoreContent(title, desc, channel.category);

        await this.env.CONTENT_KV.put(cacheKey, JSON.stringify({
          title, channel: channel.name, score, processedAt: Date.now()
        }), { expirationTtl: 2592000 });

        processed++;

        if (score > (channel.minScore || 65)) {
          await this.writeToNotion({
            id: String(release.id),
            title,
            description: desc,
            url: release.html_url,
            channelTitle: channel.name,
            publishedAt: release.published_at,
            score
          }, channel);
          approved++;
        }
      }
    } catch (err) {
      console.error(`GitHub processing error for ${channel.id}:`, err);
    }
    return { processed, approved };
  }

  // ── Hacker News (Algolia API — free, no key needed) ───────
  async processHackerNews(channel) {
    // channel.id = search keyword e.g. "homelab docker"
    let processed = 0, approved = 0;
    try {
      const query  = encodeURIComponent(channel.id);
      const cutoff = Math.floor((Date.now() - 3 * 24 * 60 * 60 * 1000) / 1000);
      const response = await fetch(
        `https://hn.algolia.com/api/v1/search?query=${query}&tags=story&numericFilters=created_at_i>${cutoff},points>50&hitsPerPage=10`
      );
      if (!response.ok) {
        console.error(`HN fetch failed: ${response.status}`);
        return { processed, approved };
      }
      const data = await response.json();

      for (const hit of data.hits || []) {
        if (!hit.url || !hit.title) continue;
        const cacheKey = `hn:${hit.objectID}`;
        if (await this.env.CONTENT_KV.get(cacheKey)) continue;

        const score = await this.scoreContent(
          hit.title,
          `${hit.points} points, ${hit.num_comments} comments on Hacker News`,
          channel.category
        );

        await this.env.CONTENT_KV.put(cacheKey, JSON.stringify({
          title: hit.title,
          channel: channel.name,
          score,
          hnPoints: hit.points,
          processedAt: Date.now()
        }), { expirationTtl: 2592000 });

        processed++;

        if (score > (channel.minScore || 70)) {
          await this.writeToNotion({
            id: hit.objectID,
            title: hit.title,
            description: `${hit.points} HN points · ${hit.num_comments} comments · by ${hit.author}`,
            url: hit.url,
            channelTitle: `Hacker News — ${channel.name}`,
            publishedAt: new Date(hit.created_at_i * 1000).toISOString(),
            score
          }, channel);
          approved++;
        }
      }
    } catch (err) {
      console.error(`HN processing error for ${channel.name}:`, err);
    }
    return { processed, approved };
  }

  // ── XML Helpers ───────────────────────────────────────────
  xmlText(xml, tag) {
    const match = xml.match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, 'i'));
    return match ? match[1].trim() : null;
  }

  xmlAttr(xml, tag, attr = 'href') {
    const match = xml.match(new RegExp(`<${tag}[^>]*${attr}="([^"]+)"`, 'i'));
    return match ? match[1].trim() : null;
  }

  // ── Scoring (with channel history bonus) ─────────────────
  async scoreContent(title, description, category, channelId = null) {
    let channelBonus = 0;
    if (channelId) {
      try {
        const channelData = await this.env.CONTENT_KV.get(`channel-score:${channelId}`);
        if (channelData) {
          const { publishCount } = JSON.parse(channelData);
          channelBonus = Math.min(publishCount * 2, 15);
        }
      } catch {}
    }

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
      const baseScore = match ? parseInt(match[0]) : 50;
      return Math.min(baseScore + channelBonus, 100);
    } catch (error) {
      console.error('Scoring failed:', error);
      return 50 + channelBonus;
    }
  }

  // ── Write to Notion ───────────────────────────────────────
  async writeToNotion(video, channel) {
    const creator = this.creatorCache?.find(c => c.channelId === channel.id);
    const properties = {
      Name:            { title: [{ text: { content: video.title } }] },
      'Video URL':     { url: video.url },
      Score:           { number: video.score },
      Status:          { select: { name: 'Pending Review' } },
      Category:        { select: { name: channel.category } },
      Section:         { select: { name: channel.section } },
      Tags:            { multi_select: channel.tags.map(tag => ({ name: tag })) },
      Featured:        { checkbox: channel.featured },
      Source:          { select: { name: channel.type } },
      'Published Date':{ date: { start: video.publishedAt } }
    };
    if (creator) {
      properties['Content Creator'] = { relation: [{ id: creator.id }] };
      properties['Creator Name']    = { rich_text: [{ text: { content: creator.name } }] };
    } else {
      properties['Creator Name'] = { rich_text: [{ text: { content: channel.name } }] };
    }
    const response = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.config.notion_token}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28'
      },
      body: JSON.stringify({ parent: { database_id: this.config.notion_database_id }, properties })
    });
    if (!response.ok) throw new Error(`Notion error: ${await response.text()}`);
    return await response.json();
  }
}

// ========== ENHANCEMENT AGENT ==========
class EnhancementAgent {
  constructor(env) {
    this.env = env;
  }

  async callGemini(prompt, temperature = 0.7) {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${this.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature, maxOutputTokens: 2048 }
        })
      }
    );
    const data = await response.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || 'Draft generation failed';
  }

  // Fetch real YouTube captions before generating draft
  async fetchTranscript(videoUrl) {
    try {
      const match = videoUrl.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
      if (!match) return null;
      const videoId = match[1];

      const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TechFusionBot/1.0)' }
      });
      const html = await pageRes.text();

      const captionMatch = html.match(/"captionTracks":\[(.*?)\]/);
      if (!captionMatch) {
        console.warn(`No captions found for ${videoId}`);
        return null;
      }

      const tracks = JSON.parse(`[${captionMatch[1]}]`);
      const track  = tracks.find(t => t.languageCode === 'en' && !t.kind)
        || tracks.find(t => t.languageCode === 'en')
        || tracks[0];

      if (!track?.baseUrl) return null;

      const captionRes = await fetch(track.baseUrl);
      const captionXml = await captionRes.text();

      const text = captionXml
        .replace(/<[^>]+>/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/\s+/g, ' ')
        .trim();

      console.log(`Transcript: ${text.length} chars for ${videoId}`);
      return text.substring(0, 12000);
    } catch (err) {
      console.warn(`Transcript fetch failed: ${err.message}`);
      return null;
    }
  }

  async start(data) {
    const { notionPageId, videoUrl, category, section, tags } = data;

    // Fetch real transcript first
    const transcript = videoUrl ? await this.fetchTranscript(videoUrl) : null;

    const sourceContext = transcript
      ? `Here is the actual video transcript:\n\n${transcript}`
      : `Video URL: ${videoUrl}\n(No transcript available — use your knowledge of this topic)`;

    const prompt = `You are writing for TechFusion Report, a dark-themed tech blog targeting developers and tech enthusiasts.

${sourceContext}

Write a comprehensive ${category} blog post based on this content.

Requirements:
- 1500-2000 words
- Technical but accessible tone
- Include practical code examples where relevant
- TL;DR summary at top (3-4 bullets)
- Clear conclusion with next steps
- Format in markdown

Structure:
1. Introduction (hook + what reader will learn)
2. TL;DR bullets
3. Main content (3-5 H2 sections)
4. Code examples (marked as [CODE_BLOCK: description])
5. Conclusion + CTA

After the main post, add a line containing only "---SEO---" then:
SEO_TITLE: (55-65 char title with primary keyword)
META_DESC: (145-160 char meta description)
SLUG: (url-friendly-slug)
KEYWORD: (primary 2-4 word keyword phrase)`;

    const raw = await this.callGemini(prompt);

    // Split out SEO fields
    const seoSplit    = raw.split('---SEO---');
    const mainContent = seoSplit[0].trim();
    const seoBlock    = seoSplit[1] || '';

    const seoTitle  = (seoBlock.match(/SEO_TITLE:\s*(.+)/)  || [])[1]?.trim() || '';
    const metaDesc  = (seoBlock.match(/META_DESC:\s*(.+)/)  || [])[1]?.trim() || '';
    const slug      = (seoBlock.match(/SLUG:\s*(.+)/)       || [])[1]?.trim() || '';
    const keyword   = (seoBlock.match(/KEYWORD:\s*(.+)/)    || [])[1]?.trim() || '';

    // Write draft to Notion body
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
            type: 'callout',
            callout: {
              rich_text: [{ text: { content: `🤖 Draft generated from ${transcript ? 'real transcript' : 'AI knowledge'} · ${mainContent.split(/\s+/).length} words` } }],
              icon: { emoji: '🤖' }
            }
          },
          {
            object: 'block',
            type: 'code',
            code: {
              language: 'markdown',
              rich_text: [{ text: { content: mainContent.substring(0, 2000) } }]
            }
          }
        ]
      })
    });

    // Write SEO fields back to Notion properties
    const propsToUpdate = { Status: { select: { name: 'Draft Review' } } };
    if (seoTitle) propsToUpdate['SEO Title']        = { rich_text: [{ text: { content: seoTitle } }] };
    if (metaDesc) propsToUpdate['Meta Description'] = { rich_text: [{ text: { content: metaDesc } }] };
    if (slug)     propsToUpdate['Slug']              = { rich_text: [{ text: { content: slug } }] };
    if (keyword)  propsToUpdate['Target Keyword']   = { rich_text: [{ text: { content: keyword } }] };

    await fetch(`https://api.notion.com/v1/pages/${notionPageId}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${this.env.NOTION_TOKEN}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28'
      },
      body: JSON.stringify({ properties: propsToUpdate })
    });

    return new Response(JSON.stringify({
      status: 'enhanced',
      notionPageId,
      wordCount: mainContent.split(/\s+/).length,
      transcriptUsed: !!transcript,
      seoFieldsExtracted: !!(seoTitle && metaDesc && slug)
    }), { headers: { 'Content-Type': 'application/json' } });
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
      date:     new Date().toISOString().split('T')[0],
      slug:     this.createSlug(title),
      category: category || 'General',
      section:  section  || 'general',
      tags:     tags     || [],
      featured,
      notionPageId
    };

    const contentWithAffiliates = this.insertAffiliateLinks(content);
    const html       = this.convertToHTML(contentWithAffiliates, metadata);
    const categoryPath = metadata.category.toLowerCase().replace(/\s+/g, '-');
    const filePath   = `${metadata.section}/${categoryPath}/${metadata.slug}.html`;

    const githubUrl  = await this.commitToGitHub(filePath, html, metadata);
    const url        = `https://techfusionreport.com/${filePath}`;

    // Extended article record with revenue tracking fields
    await this.env.CONTENT_KV.put(`article:${metadata.slug}`, JSON.stringify({
      ...metadata,
      githubUrl,
      publishedAt:        Date.now(),
      views:              0,
      estimatedAdRevenue: 0,
      affiliateClicks:    0,
      sponsorName:        null,
      revenueType:        'display_ads'
    }));

    await this.updateNotionStatus(notionPageId, 'Published', url);

    const socialContent = await this.generateSocialContent(metadata, content);
    await this.env.CONTENT_KV.put(`social:${notionPageId}`, JSON.stringify(socialContent));

    // Record that this channel produced a published article (feeds back into scoring)
    await this.recordChannelPublish(notionPageId);

    if (metadata.featured) {
      await this.env.PUBLISHING_QUEUE?.send({
        type: 'crosspost',
        notionPageId,
        platforms: ['medium', 'devto']
      });
    }

    return new Response(JSON.stringify({ status: 'published', url, social: socialContent }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // Write channel publish counter back to KV so Discovery can use it for scoring
  async recordChannelPublish(notionPageId) {
    try {
      const pageRes = await fetch(`https://api.notion.com/v1/pages/${notionPageId}`, {
        headers: {
          'Authorization': `Bearer ${this.env.NOTION_TOKEN}`,
          'Notion-Version': '2022-06-28'
        }
      });
      if (!pageRes.ok) return;
      const page      = await pageRes.json();
      const channelId = page.properties?.['Channel ID']?.rich_text?.[0]?.text?.content;
      if (!channelId) return;

      const key      = `channel-score:${channelId}`;
      const existing = await this.env.CONTENT_KV.get(key);
      const scoreData = existing ? JSON.parse(existing) : { publishCount: 0, lastPublished: null };
      scoreData.publishCount  += 1;
      scoreData.lastPublished  = new Date().toISOString();
      await this.env.CONTENT_KV.put(key, JSON.stringify(scoreData));
      console.log(`Channel ${channelId} publish count: ${scoreData.publishCount}`);
    } catch (err) {
      console.warn('recordChannelPublish failed:', err.message);
    }
  }

  createSlug(title) {
    return title.toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 60);
  }

  generateMetaDescription(content) {
    const firstPara = content.split('\n\n')[0] || '';
    const plainText = firstPara.replace(/[#*`\[\]]/g, '').replace(/\n/g, ' ').trim();
    return plainText.length > 155 ? plainText.substring(0, 152) + '...' : plainText;
  }

  insertAffiliateLinks(content) {
    const affiliates = {
      'cloudflare': 'https://www.cloudflare.com',
      'vercel':     'https://vercel.com',
      'notion':     'https://notion.so',
      'github':     'https://github.com',
      'linear':     'https://linear.app'
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
      .replace(/^# (.*$)/gim,   '<h1>$1</h1>')
      .replace(/^## (.*$)/gim,  '<h2>$1</h2>')
      .replace(/^### (.*$)/gim, '<h3>$1</h3>')
      .replace(/\*\*(.*)\*\*/gim, '<strong>$1</strong>')
      .replace(/\*(.*)\*/gim,     '<em>$1</em>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/gim, '<a href="$2">$1</a>')
      .replace(/```([\s\S]*?)```/gim, '<pre><code>$1</code></pre>')
      .replace(/`([^`]+)`/gim, '<code>$1</code>')
      .replace(/\[CODE_BLOCK: ([^\]]+)\]/gim, '<div class="code-placeholder">Code: $1</div>')
      .replace(/\n/gim, '<br>');

    const canonicalUrl = `https://techfusionreport.com/${metadata.section}/${metadata.category.toLowerCase().replace(/\s+/g, '-')}/${metadata.slug}.html`;
    const schema = JSON.stringify({
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
    });

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${metadata.title} | TechFusion Report</title>
  <meta name="description" content="${metadata.description}">
  <link rel="canonical" href="${canonicalUrl}">
  <script type="application/ld+json">${schema}</script>
  <link rel="stylesheet" href="/assets/css/main.css">
</head>
<body>
  <main class="article-container">
    <nav class="breadcrumb">
      <a href="/">Home</a> /
      <a href="/${metadata.section}">${metadata.section}</a> /
      <a href="/${metadata.section}/${metadata.category.toLowerCase().replace(/\s+/g, '-')}">${metadata.category}</a>
    </nav>
    <span class="badge">${metadata.category}</span>
    ${metadata.featured ? '<span class="badge featured">Featured</span>' : ''}
    <h1>${metadata.title}</h1>
    <time>${new Date(metadata.date).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</time>
    <div class="tags">${metadata.tags.map(tag => `<a href="/tag/${tag}" class="tag">${tag}</a>`).join('')}</div>
    <article class="content">${contentHtml}</article>
    <div class="share-links">
      <a href="https://twitter.com/intent/tweet?text=${encodeURIComponent(metadata.title)}&url=${encodeURIComponent(canonicalUrl)}" target="_blank">Share on X</a>
      <a href="https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(canonicalUrl)}" target="_blank">Share on LinkedIn</a>
    </div>
  </main>
  <script src="/assets/js/main.js"></script>
</body>
</html>`;
  }

  async commitToGitHub(path, content, metadata) {
    const base64Content = btoa(unescape(encodeURIComponent(content)));
    const checkRes = await fetch(
      `https://api.github.com/repos/TechFusionReport/Website/contents/${path}`,
      { headers: { 'Authorization': `token ${this.env.GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json' } }
    );
    const sha = checkRes.ok ? (await checkRes.json()).sha : undefined;

    const commitRes = await fetch(
      `https://api.github.com/repos/TechFusionReport/Website/contents/${path}`,
      {
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
      }
    );
    if (!commitRes.ok) throw new Error(`GitHub commit failed: ${await commitRes.text()}`);
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
          Status:        { select: { name: status } },
          'Published URL': { url }
        }
      })
    });
  }

  // Fixed: was calling CONTENT_KV.get() without await inside .map()
  async suggestInternalLinks(category) {
    try {
      const list = await this.env.CONTENT_KV.list({ prefix: 'article:' });
      const articles = await Promise.all(
        list.keys.map(async k => {
          const raw = await this.env.CONTENT_KV.get(k.name);
          return raw ? JSON.parse(raw) : null;
        })
      );
      const related = articles
        .filter(a => a && a.category === category && a.url)
        .slice(0, 3);
      if (related.length === 0) return '';
      const links = related.map(a => `<li><a href="${a.url}">${a.title}</a></li>`).join('\n');
      return `<ul class="related-articles">\n${links}\n</ul>`;
    } catch (err) {
      console.warn('suggestInternalLinks failed:', err.message);
      return '';
    }
  }

  async generateSocialContent(metadata, content) {
    const prompt = `Create social posts for "${metadata.title}" [${metadata.category}]:
1. Twitter thread (3-5 tweets, engaging, hashtags)
2. LinkedIn post (professional, 2 paragraphs)
Format with clear headers.`;
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
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      return {
        twitter:  this.extractSection(text, 'Twitter')  || `🚀 ${metadata.title}\n\n#${metadata.category.replace(/\s+/g, '')}`,
        linkedin: this.extractSection(text, 'LinkedIn') || `Just published: ${metadata.title}`,
        devto:    { title: metadata.title, tags: metadata.tags.slice(0, 4) }
      };
    } catch {
      return {
        twitter:  `🚀 ${metadata.title}\n\n#${metadata.category.replace(/\s+/g, '')}`,
        linkedin: `Just published: ${metadata.title}`,
        devto:    { title: metadata.title, tags: metadata.tags.slice(0, 4) }
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
      return new Response(channels || '[]', { headers: { 'Content-Type': 'application/json' } });
    });

    router.post('/admin/channels', async (req, env) => {
      const channels = await req.json();
      if (!Array.isArray(channels)) return new Response('Invalid: must be array', { status: 400 });
      await env.CONTENT_KV.put('channels_config', JSON.stringify(channels));
      return new Response(JSON.stringify({ status: 'saved', count: channels.length }), {
        headers: { 'Content-Type': 'application/json' }
      });
    });

    router.post('/admin/channels/refresh', async (req, env) => {
      try {
        const response = await fetch('https://raw.githubusercontent.com/TechFusionReport/Automations/main/config/channels.json');
        const channels = await response.json();
        await env.CONTENT_KV.put('channels_config', JSON.stringify(channels));
        return new Response(JSON.stringify({ status: 'refreshed', count: channels.length }), {
          headers: { 'Content-Type': 'application/json' }
        });
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

    // Channel score leaderboard
    router.get('/admin/channel-scores', async (req, env) => {
      const list = await env.CONTENT_KV.list({ prefix: 'channel-score:' });
      const scores = await Promise.all(
        list.keys.map(async k => {
          const raw = await env.CONTENT_KV.get(k.name);
          const data = raw ? JSON.parse(raw) : {};
          return { channelId: k.name.replace('channel-score:', ''), ...data };
        })
      );
      scores.sort((a, b) => (b.publishCount || 0) - (a.publishCount || 0));
      return new Response(JSON.stringify(scores, null, 2), { headers: { 'Content-Type': 'application/json' } });
    });

    // ENHANCEMENT
    router.post('/enhance', async (req, env) => {
      const data  = await req.json();
      const agent = new EnhancementAgent(env);
      return await agent.start(data);
    });

    // PUBLISHING
    router.post('/publish', async (req, env) => {
      const data  = await req.json();
      const agent = new PublishingAgent(env);
      return await agent.publish(data);
    });

    // REVENUE TRACKING
    router.post('/analytics/revenue', async (req, env) => {
      const { slug, views, estimatedAdRevenue, affiliateClicks, sponsorName, revenueType } = await req.json();
      const key      = `article:${slug}`;
      const existing = await env.CONTENT_KV.get(key);
      if (!existing) return new Response(JSON.stringify({ error: 'Article not found' }), { status: 404 });
      const article = JSON.parse(existing);
      const updated = {
        ...article,
        views:              views              ?? article.views,
        estimatedAdRevenue: estimatedAdRevenue ?? article.estimatedAdRevenue,
        affiliateClicks:    affiliateClicks    ?? article.affiliateClicks,
        sponsorName:        sponsorName        ?? article.sponsorName,
        revenueType:        revenueType        ?? article.revenueType,
        lastRevenueUpdate:  new Date().toISOString()
      };
      await env.CONTENT_KV.put(key, JSON.stringify(updated));
      return new Response(JSON.stringify({ status: 'updated', slug }), {
        headers: { 'Content-Type': 'application/json' }
      });
    });

    router.get('/analytics/revenue', async (req, env) => {
      const list     = await env.CONTENT_KV.list({ prefix: 'article:' });
      const articles = await Promise.all(
        list.keys.map(async k => {
          const raw = await env.CONTENT_KV.get(k.name);
          return raw ? JSON.parse(raw) : null;
        })
      );
      const valid   = articles.filter(Boolean);
      const summary = {
        totalArticles:        valid.length,
        totalViews:           valid.reduce((s, a) => s + (a.views || 0), 0),
        totalAdRevenue:       valid.reduce((s, a) => s + (a.estimatedAdRevenue || 0), 0),
        totalAffiliateClicks: valid.reduce((s, a) => s + (a.affiliateClicks || 0), 0),
        byCategory:           {},
        byRevenueType:        {},
        topByViews:           [...valid]
          .sort((a, b) => (b.views || 0) - (a.views || 0))
          .slice(0, 10)
          .map(a => ({ slug: a.slug, title: a.title, views: a.views, revenue: a.estimatedAdRevenue }))
      };
      for (const a of valid) {
        const cat = a.category || 'Unknown';
        if (!summary.byCategory[cat]) summary.byCategory[cat] = { articles: 0, views: 0, revenue: 0 };
        summary.byCategory[cat].articles++;
        summary.byCategory[cat].views   += a.views || 0;
        summary.byCategory[cat].revenue += a.estimatedAdRevenue || 0;
        const rt = a.revenueType || 'none';
        summary.byRevenueType[rt] = (summary.byRevenueType[rt] || 0) + 1;
      }
      return new Response(JSON.stringify(summary, null, 2), { headers: { 'Content-Type': 'application/json' } });
    });

    // STATUS & HEALTH
    router.get('/status', async (req, env) => {
      const lastDiscovery = await env.CONTENT_KV.get('last_discovery');
      const channels      = await env.CONTENT_KV.get('channels_config');
      const creators      = await env.CONTENT_KV.get('creator_cache');
      return new Response(JSON.stringify({
        status:         'operational',
        lastDiscovery:  lastDiscovery ? JSON.parse(lastDiscovery) : null,
        channelsLoaded: channels ? JSON.parse(channels).length : 0,
        creatorsCached: creators ? JSON.parse(creators).length : 0,
        timestamp:      new Date().toISOString()
      }), { headers: { 'Content-Type': 'application/json' } });
    });

    router.get('/health', async (req, env) => {
      return new Response(JSON.stringify({ status: 'healthy', version: '3.0.0', uptime: Date.now() }), {
        headers: { 'Content-Type': 'application/json' }
      });
    });

    // WEBHOOKS
    router.post('/webhook/notion', async (req, env) => {
      const payload = await req.json();
      if (payload.type === 'page.updated') {
        const pageId = payload.page.id;
        const status = payload.page.properties?.Status?.select?.name;
        if (status === 'Ready to Enhance') {
          const agent = new EnhancementAgent(env);
          return await agent.start({
            notionPageId: pageId,
            videoUrl:  payload.page.properties?.['Video URL']?.url,
            category:  payload.page.properties?.Category?.select?.name,
            section:   payload.page.properties?.Section?.select?.name,
            tags:      payload.page.properties?.Tags?.multi_select?.map(t => t.name) || []
          });
        }
        if (status === 'Ready to Publish') {
          const content = payload.page.properties?.['Content']?.rich_text?.[0]?.text?.content;
          const agent   = new PublishingAgent(env);
          return await agent.publish({
            notionPageId: pageId,
            title:    payload.page.properties?.Name?.title?.[0]?.text?.content,
            content,
            category: payload.page.properties?.Category?.select?.name,
            section:  payload.page.properties?.Section?.select?.name,
            tags:     payload.page.properties?.Tags?.multi_select?.map(t => t.name) || [],
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
            await agent.loadConfig();
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
            headers: { 'Authorization': `Bearer ${env.NOTION_TOKEN}`, 'Notion-Version': '2022-06-28' }
          });
          if (!notionRes.ok) continue;
          const page  = await notionRes.json();
          const agent = new EnhancementAgent(env);
          await agent.start({
            notionPageId: pageId,
            videoUrl:  page.properties?.['Video URL']?.url,
            category:  page.properties?.Category?.select?.name,
            section:   page.properties?.Section?.select?.name,
            tags:      page.properties?.Tags?.multi_select?.map(t => t.name) || []
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
            headers: { 'Authorization': `Bearer ${env.NOTION_TOKEN}`, 'Notion-Version': '2022-06-28' }
          });
          if (!notionRes.ok) continue;
          const page         = await notionRes.json();
          const contentBlock = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children`, {
            headers: { 'Authorization': `Bearer ${env.NOTION_TOKEN}`, 'Notion-Version': '2022-06-28' }
          });
          const blocks = await contentBlock.json();
          let content = '';
          for (const block of blocks.results) {
            if (block.type === 'code' && block.code?.language === 'markdown') {
              content = block.code.rich_text.map(t => t.text.content).join('');
              break;
            }
          }
          const agent  = new PublishingAgent(env);
          await agent.publish({
            notionPageId: pageId,
            title:    page.properties?.Name?.title?.[0]?.text?.content,
            content,
            category: page.properties?.Category?.select?.name,
            section:  page.properties?.Section?.select?.name,
            tags:     page.properties?.Tags?.multi_select?.map(t => t.name) || [],
            featured: page.properties?.Featured?.checkbox || false
          });
          results.push({ pageId, status: 'published' });
        } catch (error) {
          results.push({ pageId, status: 'error', error: error.message });
        }
      }
      return new Response(JSON.stringify({ processed: results.length, results }), {
        headers: { 'Content-Type': 'application/json' }
      });
    });

    // ANALYTICS
    router.get('/analytics/summary', async (req, env) => {
      const lastDiscovery = await env.CONTENT_KV.get('last_discovery');
      const discovery     = lastDiscovery ? JSON.parse(lastDiscovery) : null;
      const keys          = await env.CONTENT_KV.list({ prefix: 'video:' });
      const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
      let recentVideos = 0;
      for (const key of keys.keys) {
        const video = await env.CONTENT_KV.get(key.name);
        if (video && JSON.parse(video).processedAt > thirtyDaysAgo) recentVideos++;
      }
      return new Response(JSON.stringify({
        lastDiscovery,
        recentVideosProcessed: recentVideos,
        totalVideosInCache:    keys.keys.length,
        period: '30 days'
      }), { headers: { 'Content-Type': 'application/json' } });
    });

    // CACHE MANAGEMENT
    router.post('/cache/clear', async (req, env) => {
      const { pattern } = await req.json();
      const list = await env.CONTENT_KV.list({ prefix: pattern || '' });
      let deleted = 0;
      for (const key of list.keys) { await env.CONTENT_KV.delete(key.name); deleted++; }
      return new Response(JSON.stringify({ cleared: deleted, pattern: pattern || 'all' }), {
        headers: { 'Content-Type': 'application/json' }
      });
    });

    // SOCIAL PREVIEW
    router.get('/social/preview/:id', async (req, env) => {
      const url  = new URL(req.url);
      const id   = url.pathname.split('/').pop();
      const data = await env.CONTENT_KV.get(`social:${id}`);
      if (!data) return new Response('Not found', { status: 404 });
      return new Response(data, { headers: { 'Content-Type': 'application/json' } });
    });

    return router.handle(request, env);
  },

  // QUEUE CONSUMER
  async queue(batch, env, ctx) {
    for (const message of batch.messages) {
      const { type, data } = message.body;
      try {
        switch (type) {
          case 'crosspost': await handleCrosspost(data, env);                              break;
          case 'enhance':   await new EnhancementAgent(env).start(data);                  break;
          case 'publish':   await new PublishingAgent(env).publish(data);                 break;
          case 'discover':  await new DiscoveryAgent(env).run();                          break;
        }
        message.ack();
      } catch (error) {
        console.error(`Queue error [${type}]:`, error);
        message.retry();
      }
    }
  },

  // CRON SCHEDULER
  async scheduled(event, env, ctx) {
    console.log('Scheduled event:', event.cron);
    switch (event.cron) {
      case '0 */6 * * *':
        await new DiscoveryAgent(env).run();
        break;
      case '0 9 * * 1':
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
  if (!socialData) return;
  const social  = JSON.parse(socialData);
  const results = {};
  for (const platform of platforms) {
    try {
      switch (platform) {
        case 'devto':    results.devto    = await postToDevTo(social, env);    break;
        case 'medium':   results.medium   = { status: 'not_implemented' };     break;
        case 'twitter':  results.twitter  = { status: 'not_implemented' };     break;
        case 'linkedin': results.linkedin = { status: 'not_implemented' };     break;
      }
    } catch (error) {
      results[platform] = { error: error.message };
    }
  }
  return results;
}

async function postToDevTo(social, env) {
  const response = await fetch('https://dev.to/api/articles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': env.DEVTO_API_KEY },
    body: JSON.stringify({
      article: {
        title:          social.devto?.title || social.title,
        body_markdown:  social.content || '',
        tags:           social.devto?.tags || [],
        published:      false
      }
    })
  });
  if (!response.ok) throw new Error(`Dev.to error: ${await response.text()}`);
  const data = await response.json();
  return { url: data.url, id: data.id };
}

async function handleNotification(data, env) {
  if (env.SLACK_WEBHOOK_URL) {
    await fetch(env.SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `📢 ${data.message}\n${data.url || ''}` })
    });
  }
}

async function handleIndexing(data, env) {
  if (data.url && env.BING_API_KEY) {
    await fetch(`https://ssl.bing.com/webmaster/api.svc/json/SubmitUrlbatch?apikey=${env.BING_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteUrl: 'https://techfusionreport.com', urlList: [data.url] })
    });
  }
}
