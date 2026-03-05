export class AffiliateInserter {
  constructor() {
    this.programs = {
      'cloudflare': {
        url: 'https://www.cloudflare.com',
        commission: '20%',
        keywords: ['cloudflare', 'cdn', 'edge computing', 'ddos protection']
      },
      'vercel': {
        url: 'https://vercel.com',
        commission: '15%',
        keywords: ['vercel', 'next.js', 'deployment', 'hosting']
      },
      'notion': {
        url: 'https://notion.so',
        commission: '50%',
        keywords: ['notion', 'wiki', 'documentation', 'notes']
      },
      'linear': {
        url: 'https://linear.app',
        commission: '10%',
        keywords: ['linear', 'project management', 'issue tracking']
      },
      'github': {
        url: 'https://github.com',
        commission: 'N/A',
        keywords: ['github', 'git', 'version control', 'repository']
      },
      'openai': {
        url: 'https://openai.com',
        commission: 'N/A',
        keywords: ['openai', 'gpt', 'chatgpt', 'ai model']
      },
      'anthropic': {
        url: 'https://anthropic.com',
        commission: 'N/A',
        keywords: ['claude', 'anthropic', 'ai assistant']
      }
    };
  }
  
  insert(content) {
    let result = content;
    
    for (const [tool, data] of Object.entries(this.programs)) {
      // Find mentions not already linked
      const regex = new RegExp(`\\b(${data.keywords.join('|')})\\b(?!\\]\\()`, 'gi');
      
      result = result.replace(regex, (match) => {
        // Don't replace if inside code block or already linked
        return `[${match}](${data.url}?ref=techfusion)`;
      });
    }
    
    // Replace [AFFILIATE: tool] placeholders
    result = result.replace(/\[AFFILIATE: (\w+)\]/g, (match, tool) => {
      const data = this.programs[tool.toLowerCase()];
      return data ? `[${tool}](${data.url}?ref=techfusion)` : tool;
    });
    
    return result;
  }
  
  getPrograms() {
    return this.programs;
  }
}
