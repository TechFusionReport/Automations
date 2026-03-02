export class NewsletterGenerator {
  constructor(env) {
    this.env = env;
  }
  
  async generateWeekly() {
    // Get articles from last 7 days
    const articles = await this.getRecentArticles(7);
    
    if (articles.length === 0) {
      return null;
    }
    
    const prompt = `Create engaging weekly newsletter from these articles:
${articles.map((a, i) => `${i + 1}. ${a.title} [${a.category}]`).join('\n')}

Include:
1. Catchy subject line (under 50 chars)
2. Friendly 2-sentence intro
3. Article summaries (2-3 sentences each, why it matters)
4. One actionable tip from the content
5. Clear CTA to read full articles
6. Sign-off

Tone: conversational, expert but accessible.`;
    
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${this.env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }]
      })
    });
    
    const data = await response.json();
    const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
    
    // Extract subject line
    const subjectMatch = content.match(/Subject:?\s*(.+)/i);
    const subject = subjectMatch ? subjectMatch[1].trim() : 'This Week in Tech';
    
    return {
      subject: subject.substring(0, 50),
      content: content.replace(/Subject:?.+\n/, ''),
      articles: articles.length,
      preview: content.substring(0, 200)
    };
  }
  
  async getRecentArticles(days) {
    const all = await this.env.CONTENT_KV.list({ prefix: 'article:' });
    const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
    
    const articles = [];
    for (const key of all.keys) {
      const data = JSON.parse(await this.env.CONTENT_KV.get(key.name));
      if (data.publishedAt > cutoff) {
        articles.push(data);
      }
    }
    
    return articles.sort((a, b) => b.publishedAt - a.publishedAt).slice(0, 5);
  }
  
  async sendWeekly() {
    const newsletter = await this.generateWeekly();
    
    if (!newsletter) {
      return new Response(JSON.stringify({ status: 'no-content' }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Send via Buttondown
    const response = await fetch('https://api.buttondown.email/v1/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Token ${this.env.BUTTONDOWN_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        subject: newsletter.subject,
        body: newsletter.content,
        status: 'draft' // Change to 'sent' when ready
      })
    });
    
    if (!response.ok) {
      throw new Error(`Buttondown error: ${await response.text()}`);
    }
    
    // Log send
    await this.env.CONTENT_KV.put(`newsletter:${Date.now()}`, JSON.stringify({
      subject: newsletter.subject,
      articles: newsletter.articles,
      sentAt: new Date().toISOString()
    }));
    
    return new Response(JSON.stringify({
      status: 'sent',
      subject: newsletter.subject,
      articles: newsletter.articles
    }), { headers: { 'Content-Type': 'application/json' }});
  }
  
  async generatePreview() {
    const newsletter = await this.generateWeekly();
    return new Response(JSON.stringify(newsletter || { status: 'no-content' }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
