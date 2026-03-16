// Publishing Agent — TechFusion Report
// Reads secrets from CONTENT_KV 'secrets' key.
// Commits HTML blog posts to TechFusionReport/Website/_posts/
// Updates Notion record with correct v2 property names and status type.

import { AffiliateInserter } from '../utils/affiliates.js';

export class PublishingAgent {
  constructor(env) {
    this.env = env;
    this.affiliateInserter = new AffiliateInserter();
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  async getSecrets() {
    const raw = await this.env.CONTENT_KV.get('secrets');
    return raw ? JSON.parse(raw) : {};
  }

  async callGemini(prompt, temperature = 0.7) {
    const secrets = await this.getSecrets();
    const apiKey = secrets.gemini_api_key || this.env.GEMINI_API_KEY;

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
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
    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }

  createSlug(title) {
    return title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 60);
  }

  // ─── Main Publish Flow ───────────────────────────────────────────────────────

  async publish({ notionPageId, title, content, category, section, tags, abTest = false }) {
    const secrets = await this.getSecrets();
    const githubToken = secrets.github_token || this.env.GITHUB_TOKEN;

    const slug = this.createSlug(title);
    const date = new Date().toISOString().split('T')[0];

    const metadata = {
      title,
      description: this.generateMetaDescription(content),
      date,
      slug,
      category: category || 'General',
      section: section || 'Technology',
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

    // Convert markdown to HTML using existing site template
    const html = this.convertToHTML(contentWithAffiliates, metadata, variants);

    // Commit to GitHub Website repo under _posts/
    // File naming convention: YYYY-MM-DD-slug.html
    const filename = `${date}-${slug}.html`;
    const path = `_posts/${filename}`;
    const githubUrl = await this.commitToGitHub(path, html, metadata, githubToken);

    // Store article data in KV
    await this.env.CONTENT_KV.put(`article:${slug}`, JSON.stringify({
      ...metadata,
      githubUrl,
      publishedAt: Date.now(),
      views: 0
    }));

    // Update Notion record — correct property names and status type
    const publishedUrl = `https://techfusionreport.com/_posts/${filename}`;
    await this.updateNotionStatus(notionPageId, publishedUrl, secrets);

    // Store social content
    const social = await this.generateSocialContent(metadata, content);
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
      url: publishedUrl,
      github: githubUrl,
      social,
      variants: variants ? variants.map(v => v.headline) : null
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // ─── GitHub Commit ───────────────────────────────────────────────────────────

  async commitToGitHub(path, html, metadata, githubToken) {
    const base64Content = btoa(unescape(encodeURIComponent(html)));

    // Check if file exists (need sha for updates)
    const checkRes = await fetch(
      `https://api.github.com/repos/TechFusionReport/Website/contents/${path}`,
      {
        headers: {
          'Authorization': `token ${githubToken}`,
          'Accept': 'application/vnd.github.v3+json'
        }
      }
    );

    const sha = checkRes.ok ? (await checkRes.json()).sha : undefined;

    const commitRes = await fetch(
      `https://api.github.com/repos/TechFusionReport/Website/contents/${path}`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `token ${githubToken}`,
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
      }
    );

    if (!commitRes.ok) {
      throw new Error(`GitHub commit failed: ${await commitRes.text()}`);
    }

    return (await commitRes.json()).content.html_url;
  }

  // ─── Notion Status Update ────────────────────────────────────────────────────
  // Uses correct v2 schema property names and status type.

  async updateNotionStatus(pageId, publishedUrl, secrets) {
    const token = secrets.notion_token || this.env.NOTION_TOKEN;

    await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28'
      },
      body: JSON.stringify({
        properties: {
          // Status — status type, not select
          'Status': { status: { name: '✅Published To Github' } },
          // Published URL — correct emoji property name
          '🔗 Published URL': { url: publishedUrl },
          // Published Date
          '📅 Published Date': {
            date: { start: new Date().toISOString().split('T')[0] }
          },
          // Published To Github checkbox
          '✅ Published To Github': { checkbox: true }
        }
      })
    });
  }

  // ─── HTML Generation ─────────────────────────────────────────────────────────

  convertToHTML(markdown, metadata, variants = null) {
    let html = markdown
      .replace(/^# (.*)$/gim, '<h1>$1</h1>')
      .replace(/^## (.*)$/gim, '<h2>$1</h2>')
      .replace(/^### (.*)$/gim, '<h3>$1</h3>')
      .replace(/\*\*(.*)\*\*/gim, '<strong>$1</strong>')
      .replace(/\*(.*)\*/gim, '<em>$1</em>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/gim, '<a href="$2">$1</a>')
      .replace(/```([\s\S]*?)```/gim, '<pre><code>$1</code></pre>')
      .replace(/`([^`]+)`/gim, '<code>$1</code>')
      .replace(/\[CODE_BLOCK: ([^\]]+)\]/gim, '<div class="code-placeholder">[Code: $1]</div>')
      .replace(/\[AFFILIATE: ([^\]]+)\]/gim, '<span class="affiliate-placeholder" data-tool="$1"></span>')
      .replace(/\n/gim, '<br>');

    const toc = this.generateTOC(markdown);
    const abScript = variants ? this.generateABScript(variants, metadata.slug) : '';
    const internalLinks = this.suggestInternalLinks(metadata.category, metadata.section);
    const schema = JSON.stringify(this.generateSchema(metadata));

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${metadata.title} | TechFusion Report</title>
  <meta name="description" content="${metadata.description}">
  <meta property="og:title" content="${metadata.title}">
  <meta property="og:description" content="${metadata.description}">
  <meta property="og:type" content="article">
  <link rel="stylesheet" href="/style.css">
  <script type="application/ld+json">${schema}</script>
  ${abScript}
</head>
<body>
  <header>
    <a href="/"><img src="/graphics/tfr_header_logo_nb.png" alt="TechFusion Report Logo"></a>
    <nav>
      <a href="/">Home</a>
      <a href="/technology.html">Technology</a>
      <a href="/entertainment.html">Entertainment</a>
      <a href="/productivity.html">Productivity</a>
      <a href="/blog.html">Blog</a>
    </nav>
  </header>

  <main class="blog-post">
    <nav class="breadcrumb">
      <a href="/">Home</a> /
      <a href="/${metadata.section.toLowerCase()}.html">${metadata.section}</a> /
      <span>${metadata.category}</span>
    </nav>

    <article>
      <header class="post-header">
        <span class="category-badge">${metadata.category}</span>
        <h1 class="post-title">${metadata.title}</h1>
        <div class="post-meta">
          <time datetime="${metadata.date}">${new Date(metadata.date).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</time>
          <span class="reading-time">${this.estimateReadingTime(markdown)} min read</span>
        </div>
        <div class="post-tags">
          ${metadata.tags.map(tag => `<a href="/tag/${tag}" class="tag">${tag}</a>`).join('')}
        </div>
      </header>

      ${toc ? `<nav class="toc"><h3>Table of Contents</h3>${toc}</nav>` : ''}

      <div class="post-content">
        ${html}
      </div>

      <footer class="post-footer">
        <div class="related-articles">
          <h3>Related Articles</h3>
          ${internalLinks}
        </div>
        <a href="/blog.html" class="back-link">← Back to All Posts</a>
      </footer>
    </article>
  </main>

  <footer>
    <p>&copy; ${new Date().getFullYear()} TechFusion Report. All rights reserved.</p>
  </footer>
</body>
</html>`;
  }

  generateMetaDescription(content) {
    return content.replace(/[#*`\[\]]/g, '').substring(0, 155).trim() + '...';
  }

  generateTOC(markdown) {
    const headings = [...markdown.matchAll(/^## (.+)$/gim)];
    if (!headings.length) return '';
    const items = headings
      .map(h => `<li><a href="#${h[1].toLowerCase().replace(/\s+/g, '-')}">${h[1]}</a></li>`)
      .join('');
    return `<ul>${items}</ul>`;
  }

  estimateReadingTime(content) {
    return Math.max(1, Math.round(content.split(/\s+/).length / 200));
  }

  generateSchema(metadata) {
    return {
      '@context': 'https://schema.org',
      '@type': 'Article',
      headline: metadata.title,
      description: metadata.description,
      datePublished: metadata.date,
      author: { '@type': 'Organization', name: 'TechFusion Report' },
      publisher: {
        '@type': 'Organization',
        name: 'TechFusion Report',
        url: 'https://techfusionreport.com'
      }
    };
  }

  suggestInternalLinks(category, section) {
    return `<a href="/${section.toLowerCase()}.html">More ${section} posts</a>`;
  }

  generateABScript(variants, slug) {
    return `<script>
      const variants = ${JSON.stringify(variants)};
      const v = Math.floor(Math.random() * variants.length);
      document.addEventListener('DOMContentLoaded', () => {
        const h1 = document.querySelector('h1.post-title');
        if (h1) h1.textContent = variants[v].headline;
      });
    </script>`;
  }

  async generateHeadlineVariants(title) {
    return [
      { headline: title },
      { headline: title + ' — Complete Guide' },
      { headline: 'How To: ' + title }
    ];
  }

  // ─── Social Content ──────────────────────────────────────────────────────────

  async generateSocialContent(metadata, content) {
    const prompt = `Create social media posts for this article:
Title: ${metadata.title}
Category: ${metadata.category}
Tags: ${metadata.tags.join(', ')}

Write:
TWITTER: (2-3 punchy sentences + hashtags, under 280 chars)
LINKEDIN: (professional tone, 3-4 sentences)
DEVTO_TITLE: (engaging dev.to title)
DEVTO_TAGS: (4 relevant tags, comma separated)`;

    try {
      const text = await this.callGemini(prompt, 0.7);
      return {
        twitter: text.match(/TWITTER:\s*([\s\S]+?)(?=LINKEDIN:|$)/)?.[1]?.trim()
          || `🚀 ${metadata.title}\n\n#${metadata.category.replace(/\s+/g, '')}`,
        linkedin: text.match(/LINKEDIN:\s*([\s\S]+?)(?=DEVTO_TITLE:|$)/)?.[1]?.trim()
          || `Just published: ${metadata.title}`,
        devto: {
          title: text.match(/DEVTO_TITLE:\s*(.+)/)?.[1]?.trim() || metadata.title,
          tags: text.match(/DEVTO_TAGS:\s*(.+)/)?.[1]?.split(',').map(t => t.trim()).slice(0, 4)
            || metadata.tags.slice(0, 4)
        }
      };
    } catch {
      return {
        twitter: `🚀 New post: ${metadata.title}\n\n#${metadata.category.replace(/\s+/g, '')}`,
        linkedin: `Just published: ${metadata.title} in our ${metadata.category} section.`,
        devto: { title: metadata.title, tags: metadata.tags.slice(0, 4) }
      };
    }
  }

  // ─── Cross-posting ───────────────────────────────────────────────────────────

  async crossPost(articleId, platforms) {
    const articleData = await this.env.CONTENT_KV.get(`article:${articleId}`);
    if (!articleData) throw new Error('Article not found');

    const article = JSON.parse(articleData);
    const socialData = await this.env.CONTENT_KV.get(`social:${articleId}`);
    const social = socialData ? JSON.parse(socialData) : {};

    const results = {};
    for (const platform of platforms) {
      try {
        if (platform === 'medium')   results.medium   = await this.publishToMedium(article, social);
        if (platform === 'devto')    results.devto    = await this.publishToDevTo(article, social);
        if (platform === 'hashnode') results.hashnode = await this.publishToHashnode(article, social);
      } catch (e) {
        results[platform] = { error: e.message };
      }
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
          title: social.devto?.title || article.title,
          body_markdown: social.linkedin,
          tags: social.devto?.tags || article.tags.slice(0, 4),
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
          title: "${article.title.replace(/"/g, '\\"')}"
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

  // ─── Queue Message Router ────────────────────────────────────────────────────

  async processMessage(message) {
    const { type, ...payload } = message;

    switch (type) {
      case 'publish':   return await this.publish(payload);
      case 'crosspost': return await this.crossPost(payload.articleId, payload.platforms);
      default:
        console.error(`Unknown publishing message type: ${type}`);
    }
  }
}

