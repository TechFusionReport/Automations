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
      url: `https://techfusionreport.com/${path}`,
      github: githubUrl,
      social,
      variants: variants ? variants.map(v => v.headline) : null
    }), { headers: { 'Content-Type': 'application/json' }});
  }

  async commitToGitHub(path, html, metadata) {
    const base64Content = btoa(unescape(encodeURIComponent(html)));

    // Check if file exists
    const checkRes = await fetch(`https://api.github.com/repos/TechFusionReport/Website/contents/${path}`, {
      headers: {
        'Authorization': `token ${this.env.GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json'
      }
    });

    const sha = checkRes.ok ? (await checkRes.json()).sha : undefined;

    // Create or update file
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
      throw new Error(`GitHub commit failed: ${await commitRes.text()}`);
    }

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
          Status: { select: { name: status } },
          "Published URL": { url }
        }
      })
    });
  }

  convertToHTML(markdown, metadata, variants = null) {
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

    const toc = this.generateTOC(markdown);
    const abScript = variants ? this.generateABScript(variants, metadata.slug) : '';
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
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${this.env.GEMINI_API_KEY}`, {
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
