import { AffiliateInserter } from '../utils/affiliates.js';
import { CATALOG_PROPERTIES, CATALOG_STATUS } from '../utils/content-catalog.js';
import { createLlmClient } from '../utils/llm-client.mjs';
import { normalizePageId } from '../utils/ops-receipts.js';

export const AI_ASSISTED_LABEL = 'AI-assisted: drafted by AI from the source material, then reviewed and approved by a human editor before publishing. <a href="/how-tfr-is-made.html">How TFR is made</a>';
const ARTICLE_PATH = /^_posts\/(\d{4}-\d{2}-\d{2})-[a-z0-9-]+\.html$/;

export class PublishingAgent {
  constructor(env) {
    this.env = env;
    this.affiliateInserter = new AffiliateInserter();
    this.repoOwner = env.WEBSITE_REPO_OWNER || 'TechFusionReport';
    this.repoName = env.WEBSITE_REPO_NAME || 'Website';
    this.repoBranch = env.WEBSITE_REPO_BRANCH || 'main';
    this.repo = `${this.repoOwner}/${this.repoName}`;
    this.repoTarget = `${this.repo}@${this.repoBranch}`;
    this.repoApi = `https://api.github.com/repos/${this.repo}`;
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

  async stagePublishBranch(branch, path, html, posts, baseSha, secrets) {
    const headers = { ...this.githubHeaders(secrets.github_pat), 'Content-Type': 'application/json' };
    const ref = this.refPath(branch);
    const request = async (path, method, body) => {
      const response = await fetch(`${this.repoApi}/${path}`, {
        method, headers, ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!response.ok) throw new Error('Could not stage Website publish branch');
      return response.json();
    };
    const existing = await fetch(`${this.repoApi}/git/ref/heads/${ref}`, { headers });
    if (!existing.ok && existing.status !== 404) throw new Error('Could not read publish branch');
    const parent = existing.ok ? (await existing.json()).object.sha : baseSha;
    const base = await request(`git/commits/${baseSha}`, 'GET');
    // Start from the base tree, even on retry, so no stale draft files survive.
    const tree = await request('git/trees', 'POST', {
      base_tree: base.tree.sha,
      tree: [[path, html], ['posts.json', posts]].map(([file, content]) => ({
        path: file, content, mode: '100644', type: 'blob',
      })),
    });
    const commit = await request('git/commits', 'POST', {
      message: 'Stage article and update posts index', tree: tree.sha, parents: [parent],
    });
    if (await this.findPublishPR(branch, secrets)) throw new Error('Publish PR already exists');
    if (existing.ok) {
      await request(`git/refs/heads/${ref}`, 'PATCH', { sha: commit.sha, force: false });
    } else {
      await request('git/refs', 'POST', { ref: `refs/heads/${branch}`, sha: commit.sha });
    }
    return commit.sha;
  }

  async getBaseCommit(secrets) {
    const response = await fetch(`${this.repoApi}/git/ref/heads/${this.refPath(this.repoBranch)}`, {
      headers: this.githubHeaders(secrets.github_pat),
    });
    if (!response.ok) throw new Error('Could not read Website base branch');
    return (await response.json()).object.sha;
  }

  async openPublishPR(branch, metadata, notionPageId, secrets, hash, headSha) {
    const headers = { ...this.githubHeaders(secrets.github_pat), 'Content-Type': 'application/json' };
    const base = this.repoApi;
    const prRes = await fetch(`${base}/pulls`, {
      method: 'POST', headers,
      body: JSON.stringify({
        title: `Publish: ${metadata.title}`, head: branch, base: this.repoBranch,
        body: [
          `Automated publish for a TechFusion Report Content Catalog v2 record.`, ``,
          `Website target: ${this.repoTarget}`,
          `Publish-Payload-SHA256: ${hash}`,
          `Publish-Head-SHA: ${headSha}`,
          `Notion-Page-Id: ${notionPageId}`,
          `Published-Slug: ${metadata.slug}`,
          `Published-Path: ${metadata.path}`, ``,
          `**Agent:** TFR Publisher Bot`,
          `**Task:** N/A — automated pipeline`,
          `**Risk:** Low — new content file + posts.json entry only, no code changes.`
        ].join('\n')
      })
    });
    if (prRes.status === 422) {
      const existing = await this.findPublishPR(branch, secrets);
      if (existing) return existing;
    }
    if (!prRes.ok) throw new Error('Could not open publish PR');
    return await prRes.json();
  }

  async tryMergePR(prNumber, secrets, headSha) {
    const headers = { ...this.githubHeaders(secrets.github_pat), 'Content-Type': 'application/json' };
    const base = this.repoApi;
    const res = await fetch(`${base}/pulls/${prNumber}/merge`, {
      method: 'PUT', headers, body: JSON.stringify({ merge_method: 'squash', sha: headSha })
    });
    return { merged: res.ok && (await res.json()).merged === true };
  }

  async getPRState(prNumber, secrets) {
    const headers = this.githubHeaders(secrets.github_pat);
    const base = this.repoApi;
    const res = await fetch(`${base}/pulls/${prNumber}`, { headers });
    if (!res.ok) return null;
    return res.json();
  }

  refPath(branch) {
    return branch.split('/').map(encodeURIComponent).join('/');
  }

  extractPRNumber(prUrl) {
    try {
      const url = new URL(prUrl);
      const parts = url.pathname.split('/');
      if (url.origin !== 'https://github.com' || parts.length !== 5 || parts[3] !== 'pull'
        || `${parts[1]}/${parts[2]}`.toLowerCase() !== this.repo.toLowerCase()
        || !/^\d+$/.test(parts[4])) return null;
      return Number(parts[4]);
    } catch {
      return null;
    }
  }

  async findPublishPR(branch, secrets) {
    const query = new URLSearchParams({ state: 'all', head: `${this.repoOwner}:${branch}`, base: this.repoBranch });
    const response = await fetch(`${this.repoApi}/pulls?${query}`, { headers: this.githubHeaders(secrets.github_pat) });
    if (!response.ok) throw new Error('Could not look up publish PR');
    const pulls = await response.json();
    // List responses do not provide authoritative merge state.
    return pulls.length ? this.getPRState(pulls[0].number, secrets).then(pr => {
      if (!pr) throw new Error('Could not read existing publish PR');
      return pr;
    }) : null;
  }

  async buildPostsJson(metadata, baseSha, secrets) {
    const headers = this.githubHeaders(secrets.github_pat);
    const apiBase = `${this.repoApi}/contents/posts.json`;
    const existing = await fetch(`${apiBase}?ref=${encodeURIComponent(baseSha)}`, { headers });
    if (!existing.ok) throw new Error('Could not read Website posts index');
    const data = await existing.json();
    let posts = JSON.parse(decodeURIComponent(escape(atob(data.content.replace(/\n/g, '')))));
    const newSlug = `${metadata.date}-${metadata.slug}`;
    posts = posts.filter(p => p.slug !== newSlug);
    posts.unshift({
      title: metadata.title, seoTitle: metadata.seoTitle, slug: newSlug, date: metadata.date,
      category: metadata.category, subcategory: metadata.subcategory,
      readTime: `${this.estimateReadingTime(metadata.content || '')} min read`,
      excerpt: metadata.description || '', thumbnail: metadata.image || '', image: metadata.image || '',
      url: `/_posts/${newSlug}.html`, feature: Boolean(metadata.featured),
      file: `${newSlug}.html`, tags: metadata.tags || []
    });
    return JSON.stringify(posts, null, 2);
  }

  async markPublished(pageId, githubUrl, canonicalUrl, date, secrets) {
    const token = secrets.notion_token || this.env.NOTION_TOKEN;
    const response = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
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
    if (!response.ok) throw new Error('Could not mark article published');
  }

  async markAwaitingMerge(pageId, prUrl, secrets) {
    const token = secrets.notion_token || this.env.NOTION_TOKEN;
    const response = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' },
      body: JSON.stringify({
        properties: {
          [CATALOG_PROPERTIES.status]: { status: { name: CATALOG_STATUS.publishPrOpen } },
          [CATALOG_PROPERTIES.publishPrUrl]: { url: prUrl },
          [CATALOG_PROPERTIES.lastError]: { rich_text: [{ text: { content:
            'Publish PR open. Waiting for merge.'
          } }] }
        }
      })
    });
    if (!response.ok) throw new Error('Could not save publish PR');
  }

  async completePublishPR(pageId, pr, secrets, verify) {
    const field = name => pr?.body?.split(/\r?\n/).find(line => line.startsWith(name))?.slice(name.length).trim();
    const path = field('Published-Path:');
    const pathMatch = ARTICLE_PATH.exec(path || '');
    if (!pr || this.extractPRNumber(pr.html_url) !== pr.number || pr.base?.ref !== this.repoBranch
      || normalizePageId(field('Notion-Page-Id:')) !== normalizePageId(pageId) || !pathMatch) {
      console.warn('Publisher Poller: existing PR metadata unavailable');
      return { awaitingMerge: true };
    }

    let merged = pr.merged === true;
    if (!merged && pr.state === 'closed') {
      const token = secrets.notion_token || this.env.NOTION_TOKEN;
      const response = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' },
        body: JSON.stringify({ properties: {
          [CATALOG_PROPERTIES.status]: { status: { name: CATALOG_STATUS.publishFailed } },
          [CATALOG_PROPERTIES.lastError]: { rich_text: [{ text: { content: 'Publish PR closed without merging.' } }] },
        } }),
      });
      if (!response.ok) throw new Error('Could not record closed publish PR');
      return { errored: true };
    }
    if (!merged && pr.state === 'open') {
      const hash = field('Publish-Payload-SHA256:');
      const head = field('Publish-Head-SHA:');
      if (!/^[0-9a-f]{64}$/.test(hash || '') || !/^[0-9a-f]{40}$/.test(head || '') || pr.head?.sha !== head) {
        console.warn('Publisher Poller: open PR has no verified payload binding');
        return { awaitingMerge: true };
      }
      const proof = await verify(hash, true);
      if (!proof.valid) {
        console.warn(`Publisher Poller: skipped merge — ${proof.reason}`);
        return { awaitingMerge: true };
      }
      console.log(`Publisher Poller: merging article to ${this.repoTarget}`);
      merged = (await this.tryMergePR(pr.number, secrets, pr.head.sha)).merged;
    }
    if (!merged) return { awaitingMerge: true };

    const githubUrl = `https://github.com/${this.repo}/blob/${this.refPath(this.repoBranch)}/${path}`;
    const canonicalUrl = `https://www.techfusionreport.com/${path}`;
    await this.markPublished(pageId, githubUrl, canonicalUrl, pathMatch[1], secrets);
    return { processed: true };
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
    schemaType = null,
    jsonLd = null,
    internalLinks = null,
    focusKeyword = null,
    imageAltText = null,
    defaultAuthor = null
  }, { secrets, hash, verify }) {
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
      category,
      subcategory: subcategory || section || '',
      section: subcategory || section || '',
      image,
      content,
      tags: tags || [],
      notionPageId,
      featured,
      schemaType,
      jsonLd,
      internalLinks,
      focusKeyword,
      imageAltText,
      defaultAuthor
    };

    const branch = `publish/${normalizePageId(notionPageId)}`;
    const legacyBranch = `publish/${notionPageId}-${slug}`;
    const existing = await this.findPublishPR(branch, secrets) || await this.findPublishPR(legacyBranch, secrets);
    if (existing) {
      if (existing.state === 'open') await this.markAwaitingMerge(notionPageId, existing.html_url, secrets);
      return this.completePublishPR(notionPageId, existing, secrets, verify);
    }
    if (!content) return { blocked: true, reason: 'missing_draft' };

    const contentWithAffiliates = this.affiliateInserter.insert(content);
    metadata.relatedArticles = await this.findRelatedArticles(metadata);
    const template = await this.fetchWebsiteTemplate(secrets);
    const html = this.convertToHTML(contentWithAffiliates, metadata, template);

    const authorize = async () => {
      const proof = await verify(hash);
      if (!proof.valid) console.warn(`Publisher Poller: skipped — ${proof.reason}`);
      return proof;
    };
    const beforeWrite = await authorize();
    if (!beforeWrite.valid) return { skipped: true, reason: beforeWrite.reason };

    console.log(`Publisher Poller: staging article for ${this.repoTarget}`);
    const legacyRef = await fetch(`${this.repoApi}/git/ref/heads/${this.refPath(legacyBranch)}`, {
      headers: this.githubHeaders(secrets.github_pat),
    });
    if (!legacyRef.ok && legacyRef.status !== 404) throw new Error('Could not check legacy publish branch');
    const publishBranch = legacyRef.ok ? legacyBranch : branch;
    const concurrent = await this.findPublishPR(publishBranch, secrets);
    if (concurrent) return this.completePublishPR(notionPageId, concurrent, secrets, verify);
    const baseSha = await this.getBaseCommit(secrets);
    const posts = await this.buildPostsJson(metadata, baseSha, secrets);
    const headSha = await this.stagePublishBranch(publishBranch, path, html, posts, baseSha, secrets);

    const beforePR = await authorize();
    if (!beforePR.valid) return { skipped: true, reason: beforePR.reason };

    const pr = await this.openPublishPR(publishBranch, metadata, notionPageId, secrets, hash, headSha);
    const state = await this.getPRState(pr.number, secrets);
    if (!state) throw new Error('Could not read new publish PR');
    if (state.state === 'open') await this.markAwaitingMerge(notionPageId, state.html_url, secrets);
    if (state.head?.sha === headSha && state.body?.includes(`Publish-Head-SHA: ${headSha}\n`)) {
      const githubUrl = `https://github.com/${this.repo}/blob/${this.refPath(publishBranch)}/${path}`;
      await this.env.CONTENT_KV.put(`article:${slug}`, JSON.stringify({
        ...metadata, githubUrl, publishedAt: Date.now(), views: 0,
      })).catch(() => console.warn('Publisher Poller: could not cache article metadata'));
    }
    return this.completePublishPR(notionPageId, state, secrets, verify);
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
    } catch {
      console.warn('Related article lookup failed');
      return [];
    }
  }

  normalizeArticleHtml(content, metadata) {
    const source = String(content || '');
    // Preserve the existing trusted article HTML produced by enhancement, but
    // remove executable markup and event-handler attributes before insertion.
    const cleanHtml = value => value
      .replace(/<\s*(script|style|iframe|object|embed|form|svg|math)\b[^>]*>[\s\S]*?<\/\s*\1\s*>/gi, '')
      .replace(/<\s*(script|style|iframe|object|embed|form|svg|math)\b[^>]*\/?>/gi, '')
      .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/\s+(href|src)\s*=\s*(["'])\s*(?:javascript|data|vbscript):[^"']*\2/gi, '');
    const looksLikeHtml = /<(p|h2|h3|ul|ol|blockquote|pre|table)\b/i.test(source);
    let html;
    if (looksLikeHtml) {
      html = cleanHtml(source);
    } else {
      // Parse fences before paragraph splitting so blank lines remain code text.
      const blocks = source.split(/(^```[^\n]*\n[\s\S]*?^```[ \t]*$)/m).flatMap(part => {
        const fenced = part.match(/^```[^\n]*\n([\s\S]*?)^```[ \t]*$/m);
        if (fenced) return [`<pre><code>${this.escapeHtml(fenced[1])}</code></pre>`];
        return part.split(/\n\s*\n/).map(block => {
        const safe = this.escapeHtml(block.trim());
        if (!safe) return '';
        const inline = value => value
          .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
          .replace(/\*(.+?)\*/g, '<em>$1</em>')
          .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" rel="noopener noreferrer">$1</a>')
          .replace(/`([^`]+)`/g, '<code>$1</code>');
        const lines = safe.split('\n');
        for (const [marker, tag] of [[/^\s*[-+*]\s+(.+)$/, 'ul'], [/^\s*\d+\.\s+(.+)$/, 'ol']]) {
          if (lines.every(line => marker.test(line))) {
            return `<${tag}>` + lines.map(line => `<li>${inline(line.match(marker)[1])}</li>`).join('') + `</${tag}>`;
          }
        }
        const heading = safe.match(/^(#{1,3})\s+([\s\S]*)$/);
        if (heading) {
          const level = Math.max(2, heading[1].length);
          return `<h${level}>${inline(heading[2])}</h${level}>`;
        }
        return `<p>${inline(safe).replace(/\n/g, ' ')}</p>`;
        });
      });
      html = blocks.filter(Boolean).join('\n');
    }
    html = html.replace(/\[SPONSOR\]/gi, this.getSponsorBanner(metadata.category));
    return html.replace(/<h2(?![^>]*\bid=)([^>]*)>([\s\S]*?)<\/h2>/gi, (match, attrs, inner) => {
      const id = this.createSlug(this.stripHtml(inner)) || 'article-section';
      return `<h2 id="${id}"${attrs}>${inner}</h2>`;
    });
  }

  async fetchWebsiteTemplate(secrets) {
    const response = await fetch(`${this.repoApi}/contents/blog-post-template.html?ref=${encodeURIComponent(this.repoBranch)}`, {
      headers: this.githubHeaders(secrets.github_pat)
    });
    if (!response.ok) throw new Error(`Website template fetch failed (HTTP ${response.status})`);
    const data = await response.json();
    if (data.encoding !== 'base64' || !data.content) throw new Error('Invalid Website template response');
    return decodeURIComponent(escape(atob(data.content.replace(/\s/g, ''))));
  }

  convertToHTML(content, metadata, template) {
    if (!template || !template.includes('{{BODY_HTML}}')) throw new Error('Canonical Website template required');
    const category = String(metadata.category || '').trim();
    const categorySlug = category.toLowerCase();
    if (!['technology', 'entertainment', 'productivity'].includes(categorySlug)) {
      throw new Error(`Invalid Website category: ${category}`);
    }
    const replaceRequired = (source, pattern, replacement, label) => {
      if (typeof pattern === 'string' ? !source.includes(pattern) : !pattern.test(source)) {
        throw new Error('Website template missing required element: ' + label);
      }
      return source.replace(pattern, () => replacement);
    };
    const date = metadata.date;
    const datedSlug = `${date}-${metadata.slug}`;
    const disclosure = `<p class="ai-assisted-disclosure">${AI_ASSISTED_LABEL}</p>`;
    const articleHtml = this.normalizeArticleHtml(String(content || '').replaceAll(disclosure, '').replaceAll(AI_ASSISTED_LABEL, ''), metadata);
    const image = String(metadata.image || '').trim();
    if (image && !/^(https?:\/\/|\/)[^\s"'<>]+$/i.test(image)) throw new Error('Invalid article image URL');
    const related = (metadata.relatedArticles || []).map(item =>
      `<a class="post-card" href="${this.escapeHtml(item.url)}"><h3>${this.escapeHtml(item.title)}</h3></a>`
    ).join('\n');
    const schema = this.resolveSchema({ ...metadata, canonicalUrl: `https://www.techfusionreport.com/_posts/${datedSlug}.html` });
    const jsonLd = JSON.stringify(schema).replace(/[<>&]/g, ch => String.fromCharCode(92) + ({ '<': 'u003c', '>': 'u003e', '&': 'u0026' })[ch]);
    let html = replaceRequired(template, /<script type="application\/ld\+json">[\s\S]*?<\/script>/i,
      `<script type="application/ld+json">${jsonLd}</script>`, 'JSON-LD script');
    if (!image) {
      html = html.replace(/^\s*<meta (?:property="og:image"|name="twitter:image")[^>]*>\s*$/gm, '');
      html = replaceRequired(html, /\s*<figure class="article-hero-media">[\s\S]*?<\/figure>/, '', 'hero figure');
    }
    if (!metadata.inlineImage) html = replaceRequired(html, /\s*<figure class="article-inline-art">[\s\S]*?<\/figure>/, '', 'inline art figure');
    if (!metadata.bodyContinuedHtml) html = replaceRequired(html, /\s*<section class="article-body article-content">\s*{{BODY_CONTINUED_HTML}}\s*<\/section>/, '', 'continued body section');
    html = replaceRequired(html, '<article class="article-shell article-template-shell">',
      `<article class="article-shell article-template-shell" data-category="${this.escapeHtml(category)}" data-section="${this.escapeHtml(metadata.subcategory || '')}">`, 'article shell');
    const displayDate = new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', {
      month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC'
    });
    const fields = {
      SEO_TITLE: metadata.seoTitle || metadata.title,
      TITLE: metadata.title, META_DESCRIPTION: metadata.description || '', SLUG: datedSlug,
      IMAGE: image, IMAGE_ALT: metadata.imageAltText || metadata.title,
      IMAGE_CAPTION: metadata.imageCaption || '', CATEGORY: category, CATEGORY_SLUG: categorySlug,
      SUBCATEGORY: metadata.subcategory || '', TAGS: (metadata.tags || []).join(', '),
      DATE: date, UPDATED_DATE: metadata.updatedDate || date, DISPLAY_DATE: displayDate,
      READ_TIME: `${this.estimateReadingTime(articleHtml)} min read`,
      AUTHOR: metadata.defaultAuthor || 'TechFusion Report', DEK: metadata.dek || metadata.description || '',
      TLDR: this.generateTLDR(articleHtml), BODY_HTML: `${disclosure}\n${articleHtml}`,
      INLINE_IMAGE: metadata.inlineImage || '', INLINE_IMAGE_ALT: metadata.inlineImageAlt || '',
      INLINE_IMAGE_CAPTION: metadata.inlineImageCaption || '',
      BODY_CONTINUED_HTML: metadata.bodyContinuedHtml || '',
      CATEGORY_DESCRIPTION: metadata.categoryDescription || `More stories from ${category}.`,
      RELATED_ARTICLES: related
    };
    // Validate template tokens before inserting user-authored article content.
    if (/{{[^}]+}}/.test(html.replace(/{{[A-Z_]+}}/g, ''))) {
      throw new Error('Unresolved Website template placeholders');
    }
    html = html.replace(/{{([A-Z_]+)}}/g, (whole, key) => {
      if (!(key in fields)) throw new Error(`Unknown Website template placeholder: ${key}`);
      return key === 'BODY_HTML' || key === 'BODY_CONTINUED_HTML' || key === 'RELATED_ARTICLES'
        ? fields[key] : this.escapeHtml(fields[key]);
    });
    // The canonical template contains unescaped ampersands in its Google Fonts URL.
    // Escape query separators in that attribute so emitted article HTML is HTML5-valid.
    html = html.replace(/<link\b[^>]*href="https:\/\/fonts\.googleapis\.com\/[^"]*"[^>]*>/gi,
      tag => tag.replace(/&(?!(?:amp|quot|lt|gt|#\d+|#x[0-9a-f]+);)/gi, '&amp;'));

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
    if (metadata.jsonLd !== undefined && metadata.jsonLd !== null) {
      let parsed;
      try {
        parsed = typeof metadata.jsonLd === 'string' ? JSON.parse(metadata.jsonLd) : metadata.jsonLd;
        if (!parsed || typeof parsed !== 'object') throw new Error();
      } catch {
        throw new Error('Invalid supplied JSON-LD');
      }
      if (Array.isArray(parsed) || Object.hasOwn(parsed, '@graph')) return parsed;
      const result = { ...parsed };
      const defaults = this.generateSchema({ ...metadata, schemaType: null });
      for (const key of ['@context', '@type', 'headline', 'description', 'datePublished',
        'dateModified', 'mainEntityOfPage', 'author', 'publisher', 'image']) {
        if (!Object.hasOwn(result, key) && Object.hasOwn(defaults, key)) result[key] = defaults[key];
      }
      return result;
    }

    return this.generateSchema(metadata);
  }

  generateSchema(metadata) {
    let type = 'BlogPosting';
    if (['Article', 'NewsArticle'].includes(metadata.schemaType)) type = metadata.schemaType;
    else if (['FAQPage', 'HowTo', 'Review', 'VideoObject'].includes(metadata.schemaType)) {
      console.warn('Schema type requires supplied JSON-LD; falling back to BlogPosting.');
    }
    return {
      '@context': 'https://schema.org',
      '@type': type,
      headline: metadata.title,
      description: metadata.description || '',
      datePublished: metadata.date,
      dateModified: metadata.updatedDate || metadata.date,
      mainEntityOfPage: metadata.canonicalUrl,
      author: metadata.defaultAuthor
        ? { '@type': 'Person', name: metadata.defaultAuthor }
        : { '@type': 'Organization', name: 'TechFusion Report' },
      publisher: { '@type': 'Organization', name: 'TechFusion Report', url: 'https://www.techfusionreport.com' },
      ...(metadata.image ? { image: metadata.image } : {}),
      articleSection: metadata.category,
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
