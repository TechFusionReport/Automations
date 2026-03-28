// Enhancement Agent — TechFusion Report
// Synchronous single-pass enhancement using Gemini.
// Reads secrets from CONTENT_KV, writes results to Notion properties.

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
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${key}`,
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

  // ─── Main entry point (called by enhancement-poller) ──────────────────────
  async start({ notionPageId, videoUrl, category, section, tags }) {
    const secrets = await this.getSecrets();
    const token   = secrets.notion_token;
    if (!token) throw new Error('notion_token missing from secrets');

    // ── Step 1: Generate blog draft ─────────────────────────────────────────
    const blogPrompt = `You are a tech blogger writing for TechFusion Report (techfusionreport.com).
Write a complete, engaging blog post about this ${category} content.

Video URL: ${videoUrl}
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
- Write as if you've watched the video and are summarizing + adding context

Write the full blog post in HTML (use <h2>, <p>, <ul>, <li> tags).`;

    const blogDraft = await this.callGemini(blogPrompt, secrets, 0.75);

    // ── Step 2: Generate SEO metadata ───────────────────────────────────────
    const seoPrompt = `Generate SEO metadata for this ${category} blog post.
Video URL: ${videoUrl}
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
Title: ${seoTitle || videoUrl}
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
    const props = {};

    if (blogDraft)    props['📝 Blog Draft']  = { rich_text: [{ text: { content: blogDraft.substring(0, 2000) } }] };
    if (seoTitle)     props['📰 SEO Title']   = { rich_text: [{ text: { content: seoTitle } }] };
    if (seoMeta)      props['📝 SEO Meta']    = { rich_text: [{ text: { content: seoMeta } }] };
    if (seoKeywords)  props['🔑 Keywords']    = { rich_text: [{ text: { content: seoKeywords } }] };
    if (seoSlug)      props['🔗 Slug']        = { rich_text: [{ text: { content: seoSlug } }] };
    if (twitter || instagram || linkedin) {
      props['✂️ Short Form'] = { rich_text: [{ text: { content:
        `Twitter:\n${twitter}\n\nInstagram:\n${instagram}\n\nLinkedIn:\n${linkedin}`
      } }] };
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
