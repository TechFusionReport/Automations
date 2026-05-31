// Enhancement Agent — TechFusion Report
// Synchronous single-pass enhancement using Gemini.
// Reads secrets from CONTENT_KV, writes results to Notion properties.

// Notion rich_text blocks max out at 2000 chars each; split long strings across multiple blocks.
function splitRichText(text, maxChunk = 2000) {
  const chunks = [];
  for (let i = 0; i < text.length; i += maxChunk) {
    chunks.push({ text: { content: text.slice(i, i + maxChunk) } });
  }
  return chunks.length ? chunks : [{ text: { content: '' } }];
}

export class EnhancementOrchestrator {
  constructor(env) {
    this.env = env;
  }

  async getSecrets() {
    const raw = await this.env.CONTENT_KV.get('secrets');
    return raw ? JSON.parse(raw) : {};
  }

  async callGemini(prompt, secrets, temperature = 0.7) {
    const key = secrets.gemini_api_key;
    if (!key) throw new Error('gemini_api_key missing from secrets');

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature, maxOutputTokens: 4096 }
        })
      }
    );

    if (!res.ok) throw new Error(`Gemini API error: ${res.status} ${await res.text()}`);
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }

  // Fetch real video title + description from YouTube Data API to ground Gemini.
  // Returns null on any failure so callers can fall back gracefully.
  async fetchYouTubeVideoDetails(videoId, secrets) {
    const apiKey = secrets.youtube_api_key;
    if (!apiKey || !videoId) return null;
    try {
      const res = await fetch(
        `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${encodeURIComponent(videoId)}&key=${apiKey}`
      );
      if (!res.ok) return null;
      const data = await res.json();
      const snippet = data.items?.[0]?.snippet;
      if (!snippet) return null;
      return {
        title:       snippet.title || '',
        description: (snippet.description || '').slice(0, 1000)
      };
    } catch (e) {
      console.warn('fetchYouTubeVideoDetails failed:', e.message);
      return null;
    }
  }

  // ─── Main entry point (called by enhancement-poller) ──────────────────────
  async start({ notionPageId, videoUrl, category, section, tags, title = '', videoId = '', sourceDescription = '' }) {
    const secrets = await this.getSecrets();
    const token   = secrets.notion_token;
    if (!token) throw new Error('notion_token missing from secrets');

    // ── Step 0: Resolve grounding context ──────────────────────────────────
    // Use the stored title and optionally fetch live YouTube description so
    // Gemini writes about the actual video, not a training-data guess.
    let groundingTitle = title || videoUrl;
    let groundingDesc  = sourceDescription || '';

    if (videoId) {
      const ytDetails = await this.fetchYouTubeVideoDetails(videoId, secrets);
      if (ytDetails) {
        groundingTitle = ytDetails.title || groundingTitle;
        groundingDesc  = ytDetails.description || groundingDesc;
      }
    }

    // ── Step 1: Generate blog draft ─────────────────────────────────────────
    const descLine = groundingDesc
      ? `Video Description:\n${groundingDesc}\n`
      : '';

    const blogPrompt = `You are a tech blogger writing for TechFusion Report (techfusionreport.com).
Write a complete, engaging blog post about this ${category} content.

Video Title: ${groundingTitle}
${descLine}Video URL: ${videoUrl}
Category: ${category}
Section: ${section}
Tags: ${(tags || []).join(', ')}

Requirements:
- 800–1200 words
- Engaging intro that hooks the reader
- 3–4 clear sections with H2 headings
- Practical takeaways or key points
- Brief conclusion with CTA to watch the video
- Tone: conversational but professional
- Base your post on the provided title and description above — do not invent facts not supported by them

Write the full blog post in HTML (use <h2>, <p>, <ul>, <li> tags).`;

    const blogDraft = await this.callGemini(blogPrompt, secrets, 0.75);
    if (!blogDraft || blogDraft.trim().length < 100) throw new Error('Gemini returned empty or insufficient blog draft');

    // ── Step 1b: Validate topical match ─────────────────────────────────────
    // Catches hallucinated articles whose subject doesn't match the source video.
    const validationAnswer = await this.callGemini(
      `Does this article match the topic "${groundingTitle}"? Reply YES or NO only.\n\nArticle excerpt: ${blogDraft.substring(0, 300)}`,
      secrets, 0.1
    ).catch(e => { console.warn('Topical validation call failed:', e.message); return 'YES'; });

    if (!validationAnswer.trim().toUpperCase().startsWith('YES')) {
      throw new Error(`Content mismatch: generated article does not match video topic "${groundingTitle}"`);
    }

    // ── Step 2: Generate SEO metadata ───────────────────────────────────────
    const seoPrompt = `Generate SEO metadata for this ${category} blog post.
Video Title: ${groundingTitle}
Blog draft excerpt: ${blogDraft.substring(0, 500)}

Return ONLY this exact format (no extra text):
TITLE: [SEO title, max 60 chars]
SLUG: [url-slug-lowercase-hyphens]
META: [meta description, max 155 chars]
KEYWORDS: [5-7 comma-separated keywords]`;

    const seoRaw = await this.callGemini(seoPrompt, secrets, 0.3);

    const getLine = (prefix) => {
      const m = seoRaw.match(new RegExp(`${prefix}:\\s*(.+)`));
      return m ? m[1].trim() : '';
    };

    const seoTitle    = getLine('TITLE');
    const seoSlug     = getLine('SLUG');
    const seoMeta     = getLine('META');
    const seoKeywords = getLine('KEYWORDS');

    // ── Step 3: Generate social copy ────────────────────────────────────────
    const socialPrompt = `Write social media copy for this ${category} content.
Title: ${seoTitle || groundingTitle}
Blog excerpt: ${blogDraft.substring(0, 300)}

Return ONLY this format:
TWITTER: [tweet, max 240 chars, include relevant hashtags]
INSTAGRAM: [Instagram caption, 2-3 sentences + hashtags]
LINKEDIN: [LinkedIn post, professional tone, 3-4 sentences]`;

    const socialRaw = await this.callGemini(socialPrompt, secrets, 0.7);

    const twitter   = socialRaw.match(/TWITTER:\s*(.+)/)?.[1]?.trim() || '';
    const instagram = socialRaw.match(/INSTAGRAM:\s*(.+)/)?.[1]?.trim() || '';
    const linkedin  = socialRaw.match(/LINKEDIN:\s*(.+)/)?.[1]?.trim() || '';

    // ── Step 4: Write all results back to Notion ────────────────────────────
    // Property names must match Content Catalog v2 schema exactly.
    // splitRichText() chunks text into ≤2000-char blocks so long drafts are not silently truncated.
    const seoBlock = [
      seoTitle    ? `SEO Title: ${seoTitle}`   : '',
      seoSlug     ? `Slug: ${seoSlug}`         : '',
      seoMeta     ? `Meta: ${seoMeta}`         : '',
      seoKeywords ? `Keywords: ${seoKeywords}` : '',
    ].filter(Boolean).join('\n');

    const props = {};
    if (blogDraft) props['📝 Blog Draft'] = { rich_text: splitRichText(blogDraft) };
    if (seoTitle)  props['📰 SEO Title']  = { rich_text: [{ text: { content: seoTitle } }] };
    if (twitter || instagram || linkedin || seoBlock) {
      props['✂️ Short Form'] = { rich_text: splitRichText(
        `${seoBlock}\n\nTwitter:\n${twitter}\n\nInstagram:\n${instagram}\n\nLinkedIn:\n${linkedin}`.trim()
      ) };
    }

    const patchRes = await fetch(`https://api.notion.com/v1/pages/${notionPageId}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28'
      },
      body: JSON.stringify({ properties: props })
    });

    if (!patchRes.ok) throw new Error(`Notion PATCH failed: ${await patchRes.text()}`);

    return { notionPageId, seoTitle, seoSlug, blogWordCount: blogDraft.split(/\s+/).length };
  }

  // ─── Queue message handler (kept for backwards compat with index.js) ──────
  async processMessage({ type, notionPageId, videoUrl, category, section, tags }) {
    if (type === 'enhance' || type === 'research' || type === 'structure' || type === 'factcheck' || type === 'finalize') {
      return await this.start({ notionPageId, videoUrl, category, section, tags });
    }
  }
}
