export class DiscoveryAgent {
  constructor(env) {
    this.env = env;
    this.results = { youtube: 0, rss: 0, github: 0, hackernews: 0, approved: 0, errors: [] };
  }
  
  async loadConfig() {
    const stored = await this.env.CONTENT_KV.get('channels_config');
    return stored ? JSON.parse(stored) : this.getDefaultConfig();
  }
  
  getDefaultConfig() {
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
      },
      {
        id: "rss:https://blog.cloudflare.com/rss/",
        name: "Cloudflare Blog",
        type: "rss",
        minScore: 80,
        category: "DevOps",
        section: "engineering",
        tags: ["cloudflare", "edge", "security"],
        featured: true
      },
      {
        id: "github:vercel/next.js",
        name: "Next.js Releases",
        type: "github",
        minScore: 85,
        category: "Web Development",
        section: "engineering",
        tags: ["nextjs", "react", "vercel"],
        featured: false
      },
      {
        id: "hn:top",
        name: "Hacker News Top",
        type: "hackernews",
        minScore: 90,
        category: "Tech News",
        section: "news",
        tags: ["startups", "programming", "tech"],
        featured: false
      }
    ];
  }
  
  async run() {
    const config = await this.loadConfig();
    
    for (const source of config) {
      try {
        switch (source.type) {
          case 'youtube':
            await this.processYouTube(source);
            break;
          case 'rss':
            await this.processRSS(source);
            break;
          case 'github':
            await this.processGitHub(source);
            break;
          case 'hackernews':
            await this.processHackerNews(source);
            break;
        }
      } catch (error) {
        this.results.errors.push({ source: source.name, error: error.message });
      }
    }
    
    await this.env.CONTENT_KV.put('last_discovery', JSON.stringify({
      timestamp: new Date().toISOString(),
      results: this.results
    }));
    
    return new Response(JSON.stringify(this.results), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  async runSource(sourceType) {
    const config = await this.loadConfig();
    const source = config.find(s => s.type === sourceType);
    if (!source) return new Response('Source not found', { status: 404 });
    
    switch (sourceType) {
      case 'youtube':
        await this.processYouTube(source);
        break;
      case 'rss':
        await this.processRSS(source);
        break;
      case 'github':
        await this.processGitHub(source);
        break;
      case 'hackernews':
        await this.processHackerNews(source);
        break;
    }
    
    return new Response(JSON.stringify(this.results), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  async processYouTube(channel) {
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channel.id}&maxResults=10&order=date&type=video&key=${this.env.YOUTUBE_API_KEY}`;
    const response = await fetch(url);
    const data = await response.json();
    
    for (const item of data.items || []) {
      const videoId = item.id.videoId;
      if (await this.isProcessed(`video:${videoId}`)) continue;
      
      const score = await this.scoreContent(
        item.snippet.title,
        item.snippet.description,
        channel.category
      );
      
      await this.markProcessed(`video:${videoId}`, {
        id: videoId,
        title: item.snippet.title,
        url: `https://youtube.com/watch?v=${videoId}`,
        score
      });
      
      this.results.youtube++;
      
      if (score > (channel.minScore || 70)) {
        await this.writeToNotion({
          title: item.snippet.title,
          url: `https://youtube.com/watch?v=${videoId}`,
          description: item.snippet.description,
          score,
          channelTitle: item.snippet.channelTitle
        }, channel);
        this.results.approved++;
      }
    }
  }
  
  async processRSS(feed) {
    const url = feed.id.replace('rss:', '');
    const response = await fetch(url);
    const text = await response.text();
    
    const items = text.match(/<item>[\s\S]*?<\/item>/g) || [];
    
    for (const item of items.slice(0, 10)) {
      const title = this.extractXML(item, 'title');
      const link = this.extractXML(item, 'link');
      const description = this.extractXML(item, 'description');
      
      const itemId = btoa(link).substring(0, 20);
      if (await this.isProcessed(`rss:${itemId}`)) continue;
      
      const score = await this.scoreContent(title, description, feed.category);
      
      await this.markProcessed(`rss:${itemId}`, { title, url: link, score });
      this.results.rss++;
      
      if (score > (feed.minScore || 70)) {
        await this.writeToNotion({
          title,
          url: link,
          description,
          score,
          channelTitle: feed.name
        }, feed);
        this.results.approved++;
      }
    }
  }
  
  async processGitHub(repo) {
    const [owner, name] = repo.id.replace('github:', '').split('/');
    const url = `https://api.github.com/repos/${owner}/${name}/releases/latest`;
    
    const response = await fetch(url, {
      headers: {
        'Authorization': `token ${this.env.GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json'
      }
    });
    
    const release = await response.json();
    const releaseId = release.id.toString();
    
    if (await this.isProcessed(`github:${releaseId}`)) return;
    
    const score = await this.scoreContent(
      release.name || release.tag_name,
      release.body || '',
      repo.category
    );
    
    await this.markProcessed(`github:${releaseId}`, {
      title: release.name || release.tag_name,
      url: release.html_url,
      score
    });
    this.results.github++;
    
    if (score > (repo.minScore || 70)) {
      await this.writeToNotion({
        title: `${repo.name} ${release.tag_name}`,
        url: release.html_url,
        description: release.body?.substring(0, 500) || '',
        score,
        channelTitle: repo.name
      }, repo);
      this.results.approved++;
    }
  }
  
  async processHackerNews(source) {
    const topUrl = 'https://hacker-news.firebaseio.com/v0/topstories.json';
    const response = await fetch(topUrl);
    const topIds = await response.json();
    
    for (const id of topIds.slice(0, 10)) {
      if (await this.isProcessed(`hn:${id}`)) continue;
      
      const itemUrl = `https://hacker-news.firebaseio.com/v0/item/${id}.json`;
      const itemRes = await fetch(itemUrl);
      const item = await itemRes.json();
      
      if (!item || item.type !== 'story') continue;
      
      // Check score threshold for HN (filter low engagement)
      if (item.score < 100) continue;
      
      const score = await this.scoreContent(
        item.title,
        item.text || '',
        source.category
      );
      
      await this.markProcessed(`hn:${id}`, {
        title: item.title,
        url: item.url || `https://news.ycombinator.com/item?id=${id}`,
        score
      });
      this.results.hackernews++;
      
      if (score > (source.minScore || 70)) {
        await this.writeToNotion({
          title: item.title,
          url: item.url || `https://news.ycombinator.com/item?id=${id}`,
          description: `HN Score: ${item.score}, Comments: ${item.descendants || 0}`,
          score,
          channelTitle: 'Hacker News'
        }, source);
        this.results.approved++;
      }
    }
  }
  
  extractXML(xml, tag) {
    const match = xml.match(new RegExp(`<${tag}>(.*?)</${tag}>`, 's'));
    return match ? match[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : '';
  }
  
  async scoreContent(title, description, category) {
    const prompt = `Score 0-100 for ${category} tech blog relevance.
Title: "${title}"
Description: "${description?.substring(0, 500)}"

Consider: technical depth, tutorial potential, evergreen value, audience interest.
Return only the number.`;
    
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${this.env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }]
      })
    });
    
    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '50';
    return parseInt(text.match(/\d+/)?.[0]) || 50;
  }
  
  async isProcessed(key) {
    const exists = await this.env.CONTENT_KV.get(key);
    return exists !== null;
  }
  
  async markProcessed(key, data) {
    await this.env.CONTENT_KV.put(key, JSON.stringify(data), {
      expirationTtl: 2592000 // 30 days
    });
  }
  
  async writeToNotion(content, source) {
    const payload = {
      parent: { database_id: this.env.NOTION_DATABASE_ID },
      properties: {
        Name: { title: [{ text: { content: content.title } }] },
        "Video URL": { url: content.url },
        Score: { number: content.score },
        Status: { select: { name: "Pending Review" } },
        "Channel Name": { rich_text: [{ text: { content: content.channelTitle } }] },
        Category: { select: { name: source.category } },
        Section: { select: { name: source.section } },
        Tags: { multi_select: source.tags.map(tag => ({ name: tag })) },
        Featured: { checkbox: source.featured },
        Source: { select: { name: source.type } }
      }
    };
    
    await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.env.NOTION_TOKEN}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28'
      },
      body: JSON.stringify(payload)
    });
  }
}
