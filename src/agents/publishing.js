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

  async getSecrets() {
    const raw = await this.env.CONTENT_KV.get('secrets');
    return raw ? JSON.parse(raw) : {};
  }

  async publish({ notionPageId, title, content, category, section, tags, featured = false }) {
    const secrets = await this.getSecrets();
    const date    = new Date().toISOString().split('T')[0];
    const slug    = this.createSlug(title);

    const metadata = {
      title,
      description: this.generateMetaDescription(content),
      date,
      slug,
      category: category || 'General',
      section:  section  || 'Technology',
      tags:     tags     || [],
      notionPageId,
      featured
    };

    // Insert affiliate links
    const contentWithAffiliates = this.affiliateInserter.insert(content);

    // Convert to HTML
    const html = this.convertToHTML(contentWithAffiliates, metadata);

    // Commit to GitHub Pages — _posts/YYYY-MM-DD-slug.html
    const path      = `_posts/${date}-${slug}.html`;
    const githubUrl = await this.commitToGitHub(path, html, metadata, secrets);

    // Update posts.json index (homepage + blog.html read this)
    await this.updatePostsJson(metadata, githubUrl, secrets);

    // Store article data in KV
    await this.env.CONTENT_KV.put(`article:${slug}`, JSON.stringify({
      ...metadata, githubUrl, publishedAt: Date.now(), views: 0
    }));

    // Update Notion record
    await this.updateNotionRecord(notionPageId, githubUrl, date, secrets);

    const liveUrl = `https://techfusionreport.com/${path}`;
    return new Response(JSON.stringify({ status: 'published', url: liveUrl, github: githubUrl }),
      { headers: { 'Content-Type': 'application/json' } });
  }

  async updatePostsJson(metadata, githubUrl, secrets) {
    const pat     = secrets.github_pat;
    const apiBase = 'https://api.github.com/repos/TechFusionReport/Website/contents/posts.json';
    const headers = {
      'Authorization': `token ${pat}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'User-Agent': 'TechFusionReport-Bot/1.0'
    };

    // Fetch existing posts.json
    const existing = await fetch(apiBase, { headers });
    let posts = [];
    let sha;
    if (existing.ok) {
      const data = await existing.json();
      sha = data.sha;
      try {
        posts = JSON.parse(decodeURIComponent(escape(atob(data.content.replace(/\n/g, '')))));
      } catch { posts = []; }
    }

    // Prepend new entry (newest first), deduplicate by slug
    const newSlug = `${metadata.date}-${metadata.slug}`;
    posts = posts.filter(p => p.slug !== newSlug);
    posts.unshift({
      title:    metadata.title,
      slug:     newSlug,
      date:     metadata.date,
      category: metadata.category || 'Technology',
      excerpt:  metadata.description || '',
      url:      `/_posts/${newSlug}.html`
    });

    const content = btoa(unescape(encodeURIComponent(JSON.stringify(posts, null, 2))));
    const res = await fetch(apiBase, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        message: `Update posts.json: add ${metadata.title}`,
        content,
        ...(sha ? { sha } : {}),
        committer: { name: 'TechFusion Bot', email: 'bot@techfusionreport.com' }
      })
    });

    if (!res.ok) {
      console.error('posts.json update failed:', await res.text());
    }
  }

  async commitToGitHub(path, html, metadata, secrets) {
    const pat           = secrets.github_pat;
    if (!pat) throw new Error('github_pat missing from secrets');
    const base64Content = btoa(unescape(encodeURIComponent(html)));
    const apiBase       = `https://api.github.com/repos/TechFusionReport/Website/contents/${path}`;
    const headers       = {
      'Authorization': `token ${pat}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'User-Agent': 'TechFusionReport-Bot/1.0'
    };

    // Check if file exists (to get sha for updates)
    const checkRes = await fetch(apiBase, { headers });
    const sha      = checkRes.ok ? (await checkRes.json()).sha : undefined;

    const commitRes = await fetch(apiBase, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        message: `Add: ${metadata.title} [${metadata.category}]`,
        content: base64Content,
        ...(sha ? { sha } : {}),
        committer: { name: 'TechFusion Bot', email: 'bot@techfusionreport.com' }
      })
    });

    if (!commitRes.ok) throw new Error(`GitHub commit failed: ${await commitRes.text()}`);
    return (await commitRes.json()).content.html_url;
  }

  async updateNotionRecord(pageId, githubUrl, date, secrets) {
    const token = secrets.notion_token;
    const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28'
      },
      body: JSON.stringify({
        properties: {
          'Status':                 { status:   { name: '✅Published To Github' } },
          '🔗 Published URL':       { url: githubUrl },
          '✅ Published To Github': { checkbox: true },
          '📅 Published Date':      { date: { start: date } }
        }
      })
    });
    if (!res.ok) {
      const err = await res.text();
      console.error('Notion record update failed:', err);
      // Write error to the record so we can see it without Cloudflare logs
      await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Notion-Version': '2022-06-28'
        },
        body: JSON.stringify({ properties: { '⚠️ Last Error': { rich_text: [{ text: { content: `Notion update failed: ${err.substring(0, 500)}` } }] } } })
      });
    }
  }

  convertToHTML(markdown, metadata) {
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

    const toc           = this.generateTOC(markdown);
    const internalLinks = this.suggestInternalLinks(metadata.category);
    const postPath      = `_posts/${metadata.date}-${metadata.slug}.html`;

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
  <link rel="stylesheet" href="/assets/style.css">
  <link rel="canonical" href="https://techfusionreport.com/${postPath}">
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
          <p>Subscribe to TechFusion Report for weekly tech insights.</p>
        </div>
      </div>
    </div>
  </article>
</body>
</html>`;
  }

  generateMetaDescription(content) {
    return content.replace(/[#*`\[\]]/g, '').substring(0, 155).trim() + '...';
  }

  generateTOC(markdown) {
    const headings = [...markdown.matchAll(/^## (.+)$/gim)];
    if (!headings.length) return '';
    return '<ul>' + headings.map(h => `<li><a href="#${h[1]}">${h[1]}</a></li>`).join('') + '</ul>';
  }

  generateTLDR(content) {
    return content.replace(/[#*`\[\]]/g, '').substring(0, 200).trim() + '...';
  }

  estimateReadingTime(content) {
    return Math.max(1, Math.round(content.split(/\s+/).length / 200));
  }

  generateSchema(metadata) {
    return {
      "@context": "https://schema.org",
      "@type": "Article",
      "headline": metadata.title,
      "description": metadata.description,
      "datePublished": metadata.date,
      "author": { "@type": "Organization", "name": "TechFusion Report" },
      "publisher": { "@type": "Organization", "name": "TechFusion Report", "url": "https://techfusionreport.com" }
    };
  }

  getSponsorBanner(category) {
    return `<div class="sponsor-banner">Sponsored content for ${category}</div>`;
  }

  suggestInternalLinks(category) {
    return `<p><a href="/${category.toLowerCase().replace(/\s+/g, '-')}">More ${category} articles</a></p>`;
  }

  generateABScript(variants, slug) {
    return `<script>
      const variants = ${JSON.stringify(variants)};
      const idx = Math.floor(Math.random() * variants.length);
      document.addEventListener('DOMContentLoaded', () => {
        const el = document.getElementById('ab-headline');
        if (el) el.textContent = variants[idx].headline;
      });
    </script>`;
  }

  async generateHeadlineVariants(title) {
    return [{ headline: title }, { headline: title + ' — Full Guide' }];
  }

  async generateSocialContent(metadata, content) {
    const prompt = `Create social media posts for:
Title: ${metadata.title}
Category: ${metadata.category}
Tags: ${metadata.tags.join(', ')}

Create:
1. Twitter/X thread (3-5 tweets, engaging)
2. LinkedIn post (professional, 2 paragraphs)
3. Dev.to title and 4 tags

Format clearly.`;

    try {
      const secrets  = await this.getSecrets();
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${secrets.gemini_api_key}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
      });

      const data = await response.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

      return {
        twitter: this.extractSection(text, 'Twitter') || `🚀 ${metadata.title}\n\n#${metadata.category.replace(/\s+/g, '')}`,
        linkedin: this.extractSection(text, 'LinkedIn') || `Just published: ${metadata.title}`,
        devto: { title: metadata.title, tags: metadata.tags.slice(0, 4) }
      };
    } catch {
      return {
        twitter: `🚀 New post: ${metadata.title}\n\nCheck it out! #${metadata.category.replace(/\s+/g, '')}`,
        linkedin: `Just published: ${metadata.title} in our ${metadata.category} section.`,
        devto: { title: metadata.title, tags: metadata.tags.slice(0, 4) }
      };
    }
  }

  extractSection(text, header) {
    const match = text.match(new RegExp(`${header}:?[\\s]*\\n([\\s\\S]*?)(?=\\n\\w+:|$)`, 'i'));
    return match ? match[1].trim() : null;
  }

  async crossPost(articleId, platforms) {
    const articleData = await this.env.CONTENT_KV.get(`article:${articleId}`);
    if (!articleData) throw new Error('Article not found');
    const article = JSON.parse(articleData);
    const socialData = await this.env.CONTENT_KV.get(`social:${articleId}`);
    const social = socialData ? JSON.parse(socialData) : {};

    const results = {};
    for (const platform of platforms) {
      try {
        if (platform === 'medium') results.medium = await this.publishToMedium(article, social);
        if (platform === 'devto') results.devto = await this.publishToDevTo(article, social);
        if (platform === 'hashnode') results.hashnode = await this.publishToHashnode(article, social);
      } catch (e) {
        results[platform] = { error: e.message };
      }
    }

    return new Response(JSON.stringify(results), { headers: { 'Content-Type': 'application/json' } });
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
    const query = `
    mutation {
      publishPost(input: {
        title: "${article.title}"
        contentMarkdown: "${social.linkedin.replace(/"/g, '\\"')}"
        tags: [${article.tags.map(t => `{ slug: "${t}" }`).join(',')}]
        publicationId: "${this.env.HASHNODE_PUBLICATION_ID}"
      }) {
        post { slug url }
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
