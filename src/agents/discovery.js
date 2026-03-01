export class DiscoveryAgent {
  constructor(env) {
    this.env = env;
  }
  
  async run() {
    const config = [
      {
        id: "UC_x5XG1OV2P6uZZ5FSM9Ttw",
        name: "Google Developers",
        type: "youtube",
        minScore: 75,
        category: "Web Development",
        section: "engineering",
        tags: ["cloud", "api"],
        featured: false
      }
    ];
    
    for (const channel of config) {
      await this.processYouTube(channel);
    }
    
    return new Response(JSON.stringify({ status: 'discovery-complete' }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  async processYouTube(channel) {
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channel.id}&maxResults=5&order=date&type=video&key=${this.env.YOUTUBE_API_KEY}`;
    const response = await fetch(url);
    const data = await response.json();
    
    for (const item of data.items || []) {
      const videoId = item.id.videoId;
      const exists = await this.env.CONTENT_KV.get(`video:${videoId}`);
      if (exists) continue;
      
      await this.env.CONTENT_KV.put(`video:${videoId}`, JSON.stringify({
        title: item.snippet.title,
        channel: channel.name
      }), { expirationTtl: 2592000 });
      
      await fetch('https://api.notion.com/v1/pages', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.env.NOTION_TOKEN}`,
          'Content-Type': 'application/json',
          'Notion-Version': '2022-06-28'
        },
        body: JSON.stringify({
          parent: { database_id: this.env.NOTION_DATABASE_ID },
          properties: {
            Name: { title: [{ text: { content: item.snippet.title } }] },
            "Video URL": { url: `https://youtube.com/watch?v=${videoId}` },
            Status: { select: { name: "Pending Review" } },
            Category: { select: { name: channel.category } }
          }
        })
      });
    }
  }
}
