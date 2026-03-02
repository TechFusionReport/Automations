import { AffiliateInserter } from '../utils/affiliates.js';

export class PublishingAgent {
  constructor(env) {
    this.env = env;
    this.affiliateInserter = new AffiliateInserter();
  }
  
  createSlug(title) {
    return title.toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 60);
  }
  
  async publish({ notionPageId, title, content, category, section, tags, abTest = false }) {
    const metadata = {
      title,
      description: this.generateMetaDescription(content),
      date: new Date().toISOString().split('T')[0],
      slug: this.createSlug(title),
      category: category || 'General',
      section: section || 'general',
      tags: tags || [],
      notionPageId
    };
    
    // Insert affiliate links
    const contentWithAffiliates = this.affiliateInserter.insert(content);
    
    // Generate A/B variants if requested
    let variants = null;
    if (abTest) {
      variants = await this.generateHeadlineVariants(title);
    }
    
    // Convert to HTML
    const html = this.convertToHTML(contentWithAffiliates, metadata, variants);
    
    // Commit to GitHub
    const path = `${metadata.section}/${metadata.category.toLowerCase().replace(/\s+/g, '-')}/${metadata.slug}.html`;
    const githubUrl = await this.commitToGitHub(path, html, metadata);
    
    // Store article data
    await this.env.CONTENT_KV.put(`article:${metadata.slug}`, JSON.stringify({
      ...metadata,
      githubUrl,
      publishedAt: Date.now(),
      views: 0
    }));
    
    // Update Notion
    await this.updateNotionStatus(notionPageId, 'Published', githubUrl);
    
    // Generate social content
    const social = await this.generateSocialPosts(metadata, content);
    await this.env.CONTENT_KV.put(`social:${notionPageId}`, JSON.stringify(social));
    
    // Auto-crosspost if featured
    if (metadata.featured) {
      await this.env.PUBLISHING_QUEUE.send({
        type: 'crosspost',
        articleId: notionPageId,
        platforms: ['medium', 'devto']
      });
    }
    
    return new Response(JSON.stringify({
      status: 'published',
      url: `https://techfusionreport.com/${path}`,
      github: githubUrl,
      social,
      variants: variants ? variants.map(v => v.headline) : null
    }), { headers: { 'Content-Type': 'application/json' }});
  }
  
  convertToHTML(markdown, metadata, variants = null) {
    // Process markdown
    let html = markdown
      .replace(/^# (.*$)/gim, '<h1>$1</h1>')
      .replace(/^## (.*$)/gim, '<h2 id="$1">$1</h2>')
      .replace(/^### (.*$)/gim, '<h3>$1</h3>')
      .replace(/\*\*(.*)\*\*/gim, '<strong>$1</strong>')
      .replace(/\*(.*)\*/gim, '<em>$1</em>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/gim, '<a href="$2" class="external">$1</a>')
      .replace(/```([\s\S]*?)```/gim, '<pre><code class="language-$1">$1</code></pre>')
      .replace(/`([^`]+)`/gim, '<code>$1</code>')
      .replace(/\[CODE_BLOCK: ([^\]]+)\]/gim, '<div class="code-placeholder">[Code: $1]</div>')
      .replace(/\[SPONSOR\]/gim, this.getSponsorBanner(metadata.category))
      .replace(/\n/gim, '<br>');
    
    // Add table of contents
    const toc = this.generateTOC(markdown);
    
    // A/B test script if variants exist
    const abScript = variants ? this.generateABScript(variants, metadata.slug) : '';
    
    // Internal links
    const internalLinks = this.suggestInternalLinks(metadata.category);
    
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${metadata.title}</title>
  <meta name="description" content="${metadata.description}">
  <meta property="og:title" content="${metadata.title}">
  <meta property="og:description" content="${metadata.description}">
  <meta property="og:type" content="article">
  <meta property="article:section" content="${metadata.category}">
  <meta property="article:tag" content="${metadata.tags.join(',')}">
  <meta property="article:published_time" content="${metadata.date}">
  <script type="application/ld+json">
  ${JSON.stringify(this.generateSchema(metadata))}
  </script>
  ${abScript}
  <link rel="stylesheet" href="/assets/style.css">
  <link rel="canonical" href="https://techfusionreport.com/${metadata.section}/${metadata.category.toLowerCase().replace(/\s+/g, '-')}/${metadata.slug}.html">
</head>
<body>
  <article data-category="${metadata.category}" data-section="${metadata.section}" data-slug="${metadata.slug}">
    <header>
      <nav class="breadcrumb">
        <a href="/">Home</a> / 
        <a href="/${metadata.section}">${metadata.section}</a> / 
        <a href="/${metadata.section}/${metadata.category.toLowerCase().replace(/\s+/g, '-')}">${metadata.category}</a>
      </nav>
      <span class="category-badge">${metadata.category}</span>
      ${metadata.featured ? '<span class="featured-badge">Featured</span>' : ''}
      <h1 id="ab-headline">${metadata.title}</h1>
      <div class="tags">
        ${metadata.tags.map(tag => `<span class="tag"><a href="/tag/${tag}">${tag}</a></span>`).join('')}
      </div>
      <time datetime="${metadata.date}">${new Date(metadata.date).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</time>
      <div class="reading-time">${this.estimateReadingTime(markdown)} min read</div>
    </header>
    
    <div class="content-wrapper">
      <aside class="toc">
        <h3>Table of Contents</h3>
        ${toc}
      </aside>
      
      <div class="content">
        <div class="tldr">
          <strong>TL;DR:</strong> ${this.generateTLDR(markdown)}
        </div>
        
        ${html}
        
        <div class="internal-links">
          <h3>Related Articles</h3>
          ${internalLinks}
        </div>
        
        <div class="newsletter-cta">
          <h3>Enjoyed this article?</h3>
          <p>Get weekly ${metadata.category} insights delivered to your inbox.</p>
          <form action="https://buttondown.email/api/emails/embed-subscribe/techfusion" method="post" target="popupwindow">
            <input type="email" name="email" placeholder="your@email.com" required>
            <input type="hidden" value="1" name="embed">
            <button type="submit">Subscribe</button>
          </form>
        </div>
      </div>
    </div>
    
    <footer>
      <p>Published in <a href="/${metadata.section}/${metadata.category.toLowerCase().replace(/\s+/g, '-')}">${metadata.category}</a></p>
      <p class="last-updated">Last updated: ${metadata.date}</p>
      <div class="social-share">
        <a href="https://twitter.com/intent/tweet?text=${encodeURIComponent(metadata.title)}&url=${encodeURIComponent(`https://techfusionreport.com/${metadata.section}/${metadata.slug}`)}">Share on X</a>
        <a href="https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(`https://techfusionreport.com/${metadata.section}/${metadata.slug}`)}">Share on LinkedIn</a>
      </div>
    </footer>
  </article>
  
  <script>
    // Track view
    fetch('/analytics/track', {
      method: 'POST',
      body: JSON.stringify({ slug: '${metadata.slug}', metric: 'view' })
    });
  </script>
</body>
</html>`;
  }
  
  async commitToGitHub(path, content, metadata) {
    const base64Content = btoa(unescape(encodeURIComponent(content)));
    
    // Check if exists
    const checkRes = await fetch(`https://api.github.com/repos/TechFusionReport/Website/contents/${path}`, {
      headers: {
        'Authorization': `token ${this.env.GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json'
      }
    });
    
    const sha = checkRes.ok ? (await checkRes.json()).sha : undefined;
    
    const commitRes = await fetch(`https://api.github.com/repos/TechFusionReport/Website/contents/${path}`, {
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
        committer: {
          name: 'TechFusion Bot',
          email: 'bot@techfusionreport.com'
        }
      })
    });
    
    if (!commitRes.ok) {
      throw new Error(`GitHub error: ${await commitRes.text()}`);
    }
    
    const result = await commitRes.json();
    return result.content.html_url;
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
          Status: { select: { name: status } },
          "Published URL": { url: url }
        }
      })
    });
  }
  
  async generateHeadlineVariants(title) {
    const prompt = `Generate 3 headline variants for A/B testing:
Original: "${title}"

1. SEO-optimized (keywords first, descriptive)
2. Curiosity-driven (question, knowledge gap)
3. Benefit-driven (what reader gains, "how to")

Return as JSON array: [{"type": "seo", "headline": "..."}, ...]`;
    
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${this.env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }]
      })
    });
    
    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
    
    try {
      return JSON.parse(text);
    } catch {
      return [
        { type: 'original', headline: title },
        { type: 'seo', headline: title },
        { type: 'curiosity', headline: `Why ${title}?` }
      ];
    }
  }
  
  generateABScript(variants, slug) {
    const weights = variants.map((_, i) => 1 / variants.length);
    return `<script>
    (function() {
      const variants = ${JSON.stringify(variants.map(v => v.headline))};
      const weights = ${JSON.stringify(weights)};
      const slug = '${slug}';
      
      // Check for existing assignment
      let assigned = localStorage.getItem('ab-' + slug);
      if (!assigned) {
        const rand = Math.random();
        let cumsum = 0;
        for (let i = 0; i < weights.length; i++) {
          cumsum += weights[i];
          if (rand <= cumsum) {
            assigned = i;
            break;
          }
        }
        localStorage.setItem('ab-' + slug, assigned);
      }
      
      // Apply variant
      document.getElementById('ab-headline').textContent = variants[assigned];
      
      // Track impression
      fetch('/analytics/track', {
        method: 'POST',
        body: JSON.stringify({ slug: slug, metric: 'ab-impression', variant: assigned })
      });
    })();
    </script>`;
  }
  
  generateTOC(markdown) {
    const headers = markdown.match(/^## (.*$)/gim) || [];
    return '<ul>' + headers.map(h => {
      const text = h.replace(/^## /, '');
      const id = text.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      return `<li><a href="#${id}">${text}</a></li>`;
    }).join('') + '</ul>';
  }
  
  generateTLDR(markdown) {
    const firstPara = markdown.split('\n\n')[0] || '';
    return firstPara.substring(0, 200) + '...';
  }
  
  estimateReadingTime(markdown) {
    const words = markdown.split(/\s+/).length;
    return Math.ceil(words / 200);
  }
  
  generateMetaDescription(content) {
    return content.replace(/[#*`]/g, '').substring(0, 155) + '...';
  }
  
  generateSchema(metadata) {
    return {
      "@context": "https://schema.org",
      "@type": "TechArticle",
      "headline": metadata.title,
      "description": metadata.description,
      "datePublished": metadata.date,
      "author": {
        "@type": "Organization",
        "name": "TechFusion Report"
      },
      "publisher": {
        "@type": "Organization",
        "name": "TechFusion Report",
        "logo": {
          "@type": "ImageObject",
          "url": "https://techfusionreport.com/logo.png"
        }
      },
      "articleSection": metadata.category,
      "keywords": metadata.tags.join(', ')
    };
  }
  
  getSponsorBanner(category) {
    const sponsors = {
      'Productivity': 'Notion',
      'Web Development': 'Vercel',
      'DevOps': 'Cloudflare',
      'AI/ML': 'OpenAI'
    };
    const sponsor = sponsors[category] || 'TechFusion';
    return `<div class="sponsor-banner">Sponsored by <a href="/sponsor/${sponsor.toLowerCase()}">${sponsor}</a></div>`;
  }
  
  async suggestInternalLinks(category) {
    const articles = await this.env.CONTENT_KV.list({ prefix: 'article:' });
    const related = articles.keys
      .map(k => JSON.parse(this.env.CONTENT_KV.get(k.name)))
      .filter(a => a.category === category)
      .slice(0, 3);
    
    return '<ul>' + related.map(a => 
      `<li><a href="${a.url}">${a.title}</a></li>`
    ).join('') + '</ul>';
  }
  
  async generateSocialPosts(metadata, content) {
    const prompt = `Create social media posts for:
Title: ${metadata.title}
Category: ${metadata.category}
Tags: ${metadata.tags.join(', ')}

Create:
1. Twitter/X thread (3-5 tweets, engaging, hashtags)
2. LinkedIn post (professional, 2 paragraphs)
3. Dev.to title and 4 tags

Format clearly with headers.`;
    
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${this.env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }]
      })
    });
    
    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    
    return {
      twitter: this.extractSection(text, 'Twitter') || `🚀 ${metadata.title}\n\n#${metadata.category.replace(/\s+/g, '')}`,
      linkedin: this.extractSection(text, 'LinkedIn') || `Just published: ${metadata.title}`,
      devto: {
        title: metadata.title,
        tags: metadata.tags.slice(0, 4)
      }
    };
  }
  
  extractSection(text, header) {
    const match = text.match(new RegExp(`${header}:?\\s*\\n([\\s\\S]*?)(?=\\n\\w+:|$)`));
    return match ? match[1].trim() : null;
  }
  
  async crossPost(articleId, platforms) {
    const article = JSON.parse(await this.env.CONTENT_KV.get(`article:${articleId}`));
    const social = JSON.parse(await this.env.CONTENT_KV.get(`social:${articleId}`));
    
    const results = {};
    
    if (platforms.includes('medium')) {
      results.medium = await this.publishToMedium(article, social);
    }
    if (platforms.includes('devto')) {
      results.devto = await this.publishToDevTo(article, social);
    }
    if (platforms.includes('hashnode')) {
      results.hashnode = await this.publishToHashnode(article, social);
    }
    
    return new Response(JSON.stringify(results), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  async publishToMedium(article, social) {
    const response = await fetch('https://api.medium.com/v1/users/me/posts', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.env.MEDIUM_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        title: article.title,
        contentFormat: 'markdown',
        content: social.linkedin,
        tags: article.tags.slice(0, 5),
        publishStatus: 'public'
      })
    });
    
    return await response.json();
  }
  
  async publishToDevTo(article, social) {
    const response = await fetch('https://dev.to/api/articles', {
      method: 'POST',
      headers: {
        'api-key': this.env.DEVTO_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        article: {
          title: article.title,
          body_markdown: social.linkedin,
          tags: social.devto.tags,
          published: true
        }
      })
    });
    
    return await response.json();
  }
  
  async publishToHashnode(article, social) {
    // GraphQL mutation for Hashnode
    const query = `
    mutation {
      publishPost(input: {
        title: "${article.title}"
        contentMarkdown: "${social.linkedin.replace(/"/g, '\\"')}"
        tags: [${article.tags.map(t => `{ slug: "${t}" }`).join(',')}]
        publicationId: "${this.env.HASHNODE_PUBLICATION_ID}"
      }) {
        post {
          slug
          url
        }
      }
    }`;
    
    const response = await fetch('https://gql.hashnode.com', {
      method: 'POST',
      headers: {
        'Authorization': this.env.HASHNODE_TOKEN,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ query })
    });
    
    return await response.json();
  }
  
  async processCrossPost(data) {
    return await this.crossPost(data.articleId, data.platforms);
  }
  
  async createABTest(articleId, variants) {
    await this.env.CONTENT_KV.put(`ab-test:${articleId}`, JSON.stringify({
      variants,
      startedAt: Date.now(),
      impressions: variants.map(() => 0),
      clicks: variants.map(() => 0)
    }));
    
    return new Response(JSON.stringify({ status: 'ab-test-created', variants }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
