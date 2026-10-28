import { AffiliateInserter } from '../utils/affiliates.js';
import { CATALOG_PROPERTIES, CATALOG_STATUS } from '../utils/content-catalog.js';
import { createLlmClient } from '../utils/llm-client.mjs';

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

  sanitizeSlug(rawSlug) {
    if (!rawSlug) return null;
    const cleaned = rawSlug.toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 60);
    return cleaned || null;
  }

  escapeHtml(value = '') {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  stripHtml(value = '') {
    return String(value)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim();
  }

  async getSecrets() {
    const raw = await this.env.CONTENT_KV.get('secrets');
    return raw ? JSON.parse(raw) : {};
  }

  githubHeaders(pat) {
    return {
      'Authorization': `token ${pat}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'TechFusionReport-Bot/1.0'
    };
  }

  async ensureBranch(branchName, secrets) {
    const headers = this.githubHeaders(secrets.github_pat);
    const base = 'https://api.github.com/repos/TechFusionReport/Website';
    const existing = await fetch(`${base}/git/ref/heads/${branchName}`, { headers });
    if (existing.ok) return;
    const mainRef = await fetch(`${base}/git/ref/heads/main`, { headers });
    if (!mainRef.ok) throw new Error(`Failed to read main ref: ${await mainRef.text()}`);
    const { object: { sha } } = await mainRef.json();
    const createRes = await fetch(`${base}/git/refs`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha })
    });
    if (!createRes.ok && createRes.status !== 422) {
      throw new Error(`Failed to create branch ${branchName}: ${await createRes.text()}`);
    }
  }

  async commitFileToBranch(path, contentString, message, branch, secrets, { isBase64 = false } = {}) {
    const headers = { ...this.githubHeaders(secrets.github_pat), 'Content-Type': 'application/json' };
    const apiBase = `https://api.github.com/repos/TechFusionReport/Website/contents/${path}`;
    const checkRes = await fetch(`${apiBase}?ref=${branch}`, { headers });
    const sha = checkRes.ok ? (await checkRes.json()).sha : undefined;
    const content = isBase64 ? contentString : btoa(unescape(encodeURIComponent(contentString)));
    const commitRes = await fetch(apiBase, {
      method: 'PUT', headers,
      body: JSON.stringify({
        message, content, branch, ...(sha ? { sha } : {}),
        committer: { name: 'TechFusion Bot', email: 'bot@techfusionreport.com' }
      })
    });
    if (!commitRes.ok) throw new Error(`GitHub commit failed (${path}): ${await commitRes.text()}`);
    return (await commitRes.json()).content.html_url;
  }

  async openPublishPR(branch, metadata, notionPageId, secrets) {
    const headers = { ...this.githubHeaders(secrets.github_pat), 'Content-Type': 'application/json' };
    const base = 'https://api.github.com/repos/TechFusionReport/Website';
    const prRes = await fetch(`${base}/pulls`, {
      method: 'POST', headers,
      body: JSON.stringify({
        title: `Publish: ${metadata.title}`, head: branch, base: 'main',
        body: [
          `Automated publish for a TechFusion Report Content Catalog v2 record.`, ``,
          `Notion-Page-Id: ${notionPageId}`,
          `Published-Slug: ${metadata.slug}`,
          `Published-Path: ${metadata.path}`, ``,
          `**Agent:** TFR Publisher Bot`,
          `**Task:** N/A — automated pipeline`,
          `**Risk:** Low — new content file + posts.json entry only, no code changes.`
        ].join('\n')
      })
    });
    if (!prRes.ok) throw new Error(`PR creation failed: ${await prRes.text()}`);
    return await prRes.json();
  }

  async tryMergePR(prNumber, secrets) {
    const headers = { ...this.githubHeaders(secrets.github_pat), 'Content-Type': 'application/json' };
    const base = 'https://api.github.com/repos/TechFusionReport/Website';
    const res = await fetch(`${base}/pulls/${prNumber}/merge`, {
      method: 'PUT', headers, body: JSON.stringify({ merge_method: 'squash' })
    });
    if (res.ok) return { merged: true };
    return { merged: false, error: await res.text() };
  }

  async getPRState(prNumber, secrets) {
    const headers = this.githubHeaders(secrets.github_pat);
    const base = 'https://api.github.com/repos/TechFusionReport/Website';
    const res = await fetch(`${base}/pulls/${prNumber}`, { headers });
    if (!res.ok) return null;
    const pr = await res.json();
    return { state: pr.state, merged: pr.merged, html_url: pr.html_url, number: pr.number };
  }

  extractPRNumber(prUrl) {
    const m = String(prUrl || '').match(/\/pull\/(\d+)/);
    return m ? Number(m[1]) : null;
  }

  async updatePostsJsonOnBranch(metadata, branch, secrets) {
    const headers = this.githubHeaders(secrets.github_pat);
    const apiBase = 'https://api.github.com/repos/TechFusionReport/Website/contents/posts.json';
    const existing = await fetch(`${apiBase}?ref=${branch}`, { headers });
    let posts = [];
    if (existing.ok) {
      const data = await existing.json();
      try { posts = JSON.parse(decodeURIComponent(escape(atob(data.content.replace(/\n/g, ''))))); }
      catch { posts = []; }
    }
    const newSlug = `${metadata.date}-${metadata.slug}`;
    posts = posts.filter(p => p.slug !== newSlug);
    posts.unshift({
      title: metadata.title, slug: newSlug, date: metadata.date,
      category: metadata.category, subcategory: metadata.subcategory,
      readTime: `${this.estimateReadingTime(metadata.content || '')} min read`,
      excerpt: metadata.description || '', thumbnail: metadata.image || '', image: metadata.image || '',
      url: `/_posts/${newSlug}.html`, feature: Boolean(metadata.featured),
      file: metadata.path, tags: metadata.tags || []
    });
    await this.commitFileToBranch('posts.json', JSON.stringify(posts, null, 2),
      `Update posts.json: add ${metadata.title}`, branch, secrets);
  }

  async markPublished(pageId, githubUrl, canonicalUrl, date, secrets) {
    const token = secrets.notion_token;
    await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' },
      body: JSON.stringify({
        properties: {
          [CATALOG_PROPERTIES.status]: { status: { name: CATALOG_STATUS.publishedToGithub } },
          [CATALOG_PROPERTIES.publishedUrl]: { url: githubUrl },
          [CATALOG_PROPERTIES.canonicalUrl]: { url: canonicalUrl },
          [CATALOG_PROPERTIES.publishedToGithub]: { checkbox: true },
          [CATALOG_PROPERTIES.publishedDate]: { date: { start: date } },
          [CATALOG_PROPERTIES.publishPrUrl]: { url: null },
          [CATALOG_PROPERTIES.lastError]: { rich_text: [] }
        }
      })
    });
  }

  async markAwaitingMerge(pageId, prUrl, mergeError, secrets) {
    const token = secrets.notion_token;
    await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' },
      body: JSON.stringify({
        properties: {
          [CATALOG_PROPERTIES.status]: { status: { name: CATALOG_STATUS.publishPrOpen } },
          [CATALOG_PROPERTIES.publishPrUrl]: { url: prUrl },
          [CATALOG_PROPERTIES.lastError]: { rich_text: [{ text: { content:
            `Not an error — PR opened, needs a human merge (branch protection requires review): ${(mergeError || '').substring(0, 400)}`
          } }] }
        }
      })
    });
  }

  async markPrClosedUnmerged(pageId, prUrl, secrets) {
    const token = secrets.notion_token;
    await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' },
      body: JSON.stringify({
        properties: {
          [CATALOG_PROPERTIES.status]: { status: { name: CATALOG_STATUS.needsReReview } },
          [CATALOG_PROPERTIES.lastError]: { rich_text: [{ text: { content: `Publish PR was closed without merging: ${prUrl}` } }] }
        }
      })
    });
  }

  async publish({
    notionPageId,
    title,
    content,
    category,
    section,
    subcategory,
    image = null,
    tags,
    featured = false,
    seoTitle = null,
    seoSlug = null,
    seoMeta = null,
    schemaType = 'Article',
    jsonLd = null,
    internalLinks = null,
    focusKeyword = null,
    imageAltText = null,
    defaultAuthor = null
  }) {
    const secrets = await this.getSecrets();
    const date = new Date().toISOString().split('T')[0];
    const slug = this.sanitizeSlug(seoSlug) || this.createSlug(title);
    const path = `_posts/${date}-${slug}.html`;
    const canonicalUrl = `https://www.techfusionreport.com/${path}`;

    const metadata = {
      title,
      seoTitle: seoTitle || title,
      description: seoMeta || this.generateMetaDescription(content),
      date,
      slug,
      path,
      canonicalUrl,
      category: category || 'Technology',
      subcategory: subcategory || section || '',
      section: subcategory || section || '',
      image,
      content,
      tags: tags || [],
      notionPageId,
      featured,
      schemaType: schemaType || 'Article',
      jsonLd,
      internalLinks,
      focusKeyword,
      imageAltText,
      defaultAuthor
    };

    const contentWithAffiliates = this.affiliateInserter.insert(content);
    metadata.relatedArticles = await this.findRelatedArticles(metadata);
    const template = await this.fetchWebsiteTemplate(secrets);
    const html = this.convertToHTML(contentWithAffiliates, metadata, template);

    const branch = `publish/${notionPageId}-${slug}`;
    await this.ensureBranch(branch, secrets);
    const githubUrl = await this.commitFileToBranch(
      path, html, `Add: ${title} [${metadata.category}]`, branch, secrets
    );
    await this.updatePostsJsonOnBranch(metadata, branch, secrets);

    const pr = await this.openPublishPR(branch, metadata, notionPageId, secrets);
    const mergeResult = await this.tryMergePR(pr.number, secrets);

    await this.env.CONTENT_KV.put(`article:${slug}`, JSON.stringify({
      ...metadata,
      githubUrl,
      publishedAt: Date.now(),
      views: 0
    }));

    if (mergeResult.merged) {
      await fetch(`https://api.github.com/repos/TechFusionReport/Website/git/refs/heads/${branch}`,
        { method: 'DELETE', headers: this.githubHeaders(secrets.github_pat) }).catch(() => {});
      await this.markPublished(notionPageId, githubUrl, canonicalUrl, date, secrets);
      return new Response(JSON.stringify({ status: 'published', url: canonicalUrl, github: githubUrl, pr: pr.html_url }),
        { headers: { 'Content-Type': 'application/json' } });
    }

    await this.markAwaitingMerge(notionPageId, pr.html_url, mergeResult.error, secrets);
    return new Response(JSON.stringify({ status: 'awaiting-merge', pr: pr.html_url, reason: mergeResult.error }),
      { headers: { 'Content-Type': 'application/json' } });
  }

  async findRelatedArticles(metadata) {
    try {
      const list = await this.env.CONTENT_KV.list({ prefix: 'article:', limit: 100 });
      const candidates = [];

      for (const key of list.keys || []) {
        const raw = await this.env.CONTENT_KV.get(key.name);
        if (!raw) continue;
        const article = JSON.parse(raw);
        if (!article?.slug || article.slug === metadata.slug) continue;

        let score = 0;
        if (article.category === metadata.category) score += 4;
        if ((article.subcategory || article.section) === metadata.subcategory) score += 2;
        const overlap = (article.tags || []).filter(tag => metadata.tags.includes(tag)).length;
        score += overlap * 2;
        if (metadata.focusKeyword && String(article.focusKeyword || '').toLowerCase() === String(metadata.focusKeyword).toLowerCase()) score += 3;

        if (score > 0) candidates.push({ ...article, relevanceScore: score });
      }

      return candidates
        .sort((a, b) => Number(b.category === metadata.category) - Number(a.category === metadata.category) || b.relevanceScore - a.relevanceScore || (b.publishedAt || 0) - (a.publishedAt || 0))
        .slice(0, 4)
        .map(article => ({
          title: article.title,
          url: article.canonicalUrl || `https://www.techfusionreport.com/_posts/${article.date}-${article.slug}.html`
        }));
    } catch (e) {
      console.warn('Related article lookup failed:', e.message);
      return [];
    }
  }

  normalizeArticleHtml(content, metadata) {
    const source = String(content || '');
    // Preserve the existing trusted article HTML produced by enhancement, but
    // remove executable markup and event-handler attributes before insertion.
    const cleanHtml = value => value
      .replace(/<\\s*(script|style|iframe|object|embed|form|svg|math)\\b[^>]*>[\\s\\S]*?<\\/\\s*\\1\\s*>/gi, '')
      .replace(/<\\s*(script|style|iframe|object|embed|form|svg|math)\\b[^>]*\\/?>/gi, '')
      .replace(/\\s+on[a-z]+\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+)/gi, '')
      .replace(/\\s+(href|src)\\s*=\\s*(["'])\\s*(?:javascript|data|vbscript):[^"']*\\2/gi, '');
    const looksLikeHtml = /<(p|h2|h3|ul|ol|blockquote|pre|table)\\b/i.test(source);
    let html;
    if (looksLikeHtml) {
      html = cleanHtml(source);
    } else {
      const blocks = source.split(/\\n\\s*\\n/).map(block => {
        const safe = this.escapeHtml(block.trim());
        if (!safe) return '';
        const inline = value => value
          .replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>')
          .replace(/\\*(.+?)\\*/g, '<em>$1</em>')
          .replace(/\\[([^\\]]+)\\]\\((https?:\\/\\/[^\\s)]+)\\)/g, '<a href="$2" rel="noopener noreferrer">$1</a>')
          .replace(/`([^`]+)`/g, '<code>$1</code>');
        const heading = safe.match(/^(#{1,3})\\s+([\\s\\S]*)$/);
        if (heading) {
          const level = Math.max(2, heading[1].length);
          return `<h${level}>${inline(heading[2])}</h${level}>`;
        }
        return `<p>${inline(safe).replace(/\\n/g, ' ')}</p>`;
      });
      html = blocks.filter(Boolean).join('\\n');
    }
    html = html.replace(/\\[SPONSOR\\]/gi, this.getSponsorBanner(metadata.category));
    return html.replace(/<h2(?![^>]*\\bid=)([^>]*)>([\\s\\S]*?)<\\/h2>/gi, (match, attrs, inner) => {
      const id = this.createSlug(this.stripHtml(inner)) || 'article-section';
      return `<h2 id="${id}"${attrs}>${inner}</h2>`;
    });
  }

  async fetchWebsiteTemplate(secrets) {
    const response = await fetch('https://api.github.com/repos/TechFusionReport/Website/contents/blog-post-template.html?ref=main', {
      headers: this.githubHeaders(secrets.github_pat)
    });
    if (!response.ok) throw new Error(`Website template fetch failed (HTTP ${response.status})`);
    const data = await response.json();
    if (data.encoding !== 'base64' || !data.content) throw new Error('Invalid Website template response');
    return decodeURIComponent(escape(atob(data.content.replace(/\\s/g, ''))));
  }

  convertToHTML(content, metadata, template) {
    if (!template || !template.includes('{{BODY_HTML}}')) throw new Error('Canonical Website template required');
    const category = String(metadata.category || '').trim();
    const categorySlug = category.toLowerCase();
    if (!['technology', 'entertainment', 'productivity'].includes(categorySlug)) {
      throw new Error(`Invalid Website category: ${category}`);
    }
    const date = metadata.date;
    const datedSlug = `${date}-${metadata.slug}`;
    const articleHtml = this.normalizeArticleHtml(content, metadata);
    const image = String(metadata.image || '').trim();
    if (image && !/^(https?:\\/\\/|\\/)[^\\s"'<>]+$/i.test(image)) throw new Error('Invalid article image URL');
    const related = (metadata.relatedArticles || []).map(item =>
      `<a class="post-card" href="${this.escapeHtml(item.url)}"><h3>${this.escapeHtml(item.title)}</h3></a>`
    ).join('\\n');
    const schema = this.resolveSchema({ ...metadata, canonicalUrl: `https://www.techfusionreport.com/_posts/${datedSlug}.html` });
    schema['@context'] = 'https://schema.org';
    schema['@type'] = 'BlogPosting';
    schema.headline = metadata.title;
    schema.description = metadata.description || '';
    schema.datePublished = date;
    schema.dateModified = metadata.updatedDate || date;
    schema.articleSection = category;
    schema.keywords = (metadata.tags || []).join(', ');
    schema.mainEntityOfPage = `https://www.techfusionreport.com/_posts/${datedSlug}.html`;
    schema.author = metadata.defaultAuthor
      ? { '@type': 'Person', name: metadata.defaultAuthor }
      : { '@type': 'Organization', name: 'TechFusion Report' };
    schema.publisher = { '@type': 'Organization', name: 'TechFusion Report',
      logo: { '@type': 'ImageObject', url: 'https://www.techfusionreport.com/graphics/tfr-logo-clean_transparent.png' } };
    if (image) schema.image = image;
    else delete schema.image;
    const jsonLd = JSON.stringify(schema).replace(/[<>&]/g, ch => String.fromCharCode(92) + ({ '<': 'u003c', '>': 'u003e', '&': 'u0026' })[ch]);
    let html = template.replace(/<script type="application\\/ld\\+json">[\\s\\S]*?<\\/script>/i,
      `<script type="application/ld+json">${jsonLd}</script>`);
    if (!image) {
      html = html.replace(/^\\s*<meta (?:property="og:image"|name="twitter:image")[^>]*>\\s*$/gm, '');
      html = html.replace(/\\s*<figure class="article-hero-media">[\\s\\S]*?<\\/figure>/, '');
    }
    if (!metadata.inlineImage) html = html.replace(/\\s*<figure class="article-inline-art">[\\s\\S]*?<\\/figure>/, '');
    if (!metadata.bodyContinuedHtml) html = html.replace(/\\s*<section class="article-body article-content">\\s*{{BODY_CONTINUED_HTML}}\\s*<\\/section>/, '');
    html = html.replace('<article class="article-shell article-template-shell">',
      `<article class="article-shell article-template-shell" data-category="${this.escapeHtml(category)}" data-section="${this.escapeHtml(metadata.subcategory || '')}">`);
    const displayDate = new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', {
      month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC'
    });
    const fields = {
      TITLE: metadata.title, META_DESCRIPTION: metadata.description || '', SLUG: datedSlug,
      IMAGE: image, IMAGE_ALT: metadata.imageAltText || metadata.title,
      IMAGE_CAPTION: metadata.imageCaption || '', CATEGORY: category, CATEGORY_SLUG: categorySlug,
      SUBCATEGORY: metadata.subcategory || '', TAGS: (metadata.tags || []).join(', '),
      DATE: date, UPDATED_DATE: metadata.updatedDate || date, DISPLAY_DATE: displayDate,
      READ_TIME: `${this.estimateReadingTime(articleHtml)} min read`,
      AUTHOR: metadata.defaultAuthor || 'TechFusion Report', DEK: metadata.dek || metadata.description || '',
      TLDR: this.generateTLDR(articleHtml), BODY_HTML: articleHtml,
      INLINE_IMAGE: metadata.inlineImage || '', INLINE_IMAGE_ALT: metadata.inlineImageAlt || '',
      INLINE_IMAGE_CAPTION: metadata.inlineImageCaption || '',
      BODY_CONTINUED_HTML: metadata.bodyContinuedHtml || '',
      CATEGORY_DESCRIPTION: metadata.categoryDescription || `More stories from ${category}.`,
      RELATED_ARTICLES: related
    };
    html = html.replace(/{{([A-Z_]+)}}/g, (whole, key) => {
      if (!(key in fields)) throw new Error(`Unknown Website template placeholder: ${key}`);
      return key === 'BODY_HTML' || key === 'BODY_CONTINUED_HTML' || key === 'RELATED_ARTICLES'
        ? fields[key] : this.escapeHtml(fields[key]);
    });
    if (/{{[^}]+}}/.test(html)) throw new Error('Unresolved Website template placeholders');
    return html;
  }

  generateMetaDescription(content) {
    const text = this.stripHtml(content);
    return text.length > 155 ? `${text.substring(0, 152).trim()}...` : text;
  }

  generateTOC(html) {
    const headings = [...html.matchAll(/<h2[^>]*id=["']([^"']+)["'][^>]*>([\s\S]*?)<\/h2>/gi)];
    if (!headings.length) return '';
    return '<ul>' + headings.map(h => `<li><a href="#${this.escapeHtml(h[1])}">${this.escapeHtml(this.stripHtml(h[2]))}</a></li>`).join('') + '</ul>';
  }

  generateTLDR(content) {
    const text = this.stripHtml(content);
    return text.length > 200 ? `${text.substring(0, 197).trim()}...` : text;
  }

  estimateReadingTime(content) {
    const text = this.stripHtml(content);
    return Math.max(1, Math.round(text.split(/\s+/).filter(Boolean).length / 200));
  }

  resolveSchema(metadata) {
    if (metadata.jsonLd) {
      try {
        const parsed = typeof metadata.jsonLd === 'string' ? JSON.parse(metadata.jsonLd) : metadata.jsonLd;
        return {
          ...parsed,
          '@context': parsed['@context'] || 'https://schema.org',
          '@type': parsed['@type'] || metadata.schemaType || 'Article',
          headline: parsed.headline || metadata.seoTitle || metadata.title,
          description: parsed.description || metadata.description,
          datePublished: parsed.datePublished || metadata.date,
          mainEntityOfPage: parsed.mainEntityOfPage || metadata.canonicalUrl,
          publisher: parsed.publisher || { '@type': 'Organization', name: 'TechFusion Report', url: 'https://techfusionreport.com' }
        };
      } catch (e) {
        console.warn('Invalid JSON-LD from Notion; using generated schema:', e.message);
      }
    }

    return this.generateSchema(metadata);
  }

  generateSchema(metadata) {
    return {
      '@context': 'https://schema.org',
      '@type': metadata.schemaType || 'Article',
      headline: metadata.seoTitle || metadata.title,
      description: metadata.description,
      datePublished: metadata.date,
      mainEntityOfPage: metadata.canonicalUrl,
      author: metadata.defaultAuthor
        ? { '@type': 'Person', name: metadata.defaultAuthor }
        : { '@type': 'Organization', name: 'TechFusion Report' },
      publisher: { '@type': 'Organization', name: 'TechFusion Report', url: 'https://techfusionreport.com' },
      keywords: [metadata.focusKeyword, ...(metadata.tags || [])].filter(Boolean).join(', ') || undefined
    };
  }

  renderInternalLinks(metadata) {
    const related = metadata.relatedArticles || [];
    if (related.length) {
      return `<div class="internal-links">
        <h3>Related Articles</h3>
        <ul>${related.map(item => `<li><a href="${this.escapeHtml(item.url)}">${this.escapeHtml(item.title)}</a></li>`).join('')}</ul>
      </div>`;
    }

    return `<div class="internal-links">
      <h3>Related Articles</h3>
      <p><a href="/${this.createSlug(metadata.category)}">More ${this.escapeHtml(metadata.category)} articles</a></p>
    </div>`;
  }

  getSponsorBanner(category) {
    return `<div class="sponsor-banner">Sponsored content for ${this.escapeHtml(category)}</div>`;
  }

  suggestInternalLinks(category) {
    return `<p><a href="/${this.createSlug(category)}">More ${this.escapeHtml(category)} articles</a></p>`;
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
      const secrets = await this.getSecrets();
      const { text } = await createLlmClient(this.env, secrets).completeText({
        workflow: 'publishing.social-content',
        prompt,
        temperature: 0.7,
        maxTokens: 1024,
        legacyModel: 'gemini-2.5-flash'
      });

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

  extractSection(text = '', header) {
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
