// Enhancement Agent — TechFusion Report
// Runs a multi-step AI pipeline (research → structure → fact-check → finalize)
// then populates the existing Option D template blocks on the Notion record.
// Reads secrets from CONTENT_KV 'secrets' key, not hardcoded env vars.

export class EnhancementOrchestrator {
  constructor(env) {
    this.env = env;
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
          generationConfig: { temperature, maxOutputTokens: 4096 }
        })
      }
    );

    const data = await response.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }

  notionHeaders(token) {
    return {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28'
    };
  }

  rt(text, bold = false, color = 'default') {
    return {
      type: 'text',
      text: { content: text },
      annotations: { bold, color }
    };
  }

  // ─── Find a named toggle block in a page ────────────────────────────────────
  // Scans the page's top-level blocks to find a toggle whose text starts with
  // the given label (e.g. '⚡ TFR BLOG DRAFT'). Returns the block ID.

  async findToggleBlock(notionPageId, label, token) {
    const response = await fetch(
      `https://api.notion.com/v1/blocks/${notionPageId}/children?page_size=50`,
      { headers: this.notionHeaders(token) }
    );

    if (!response.ok) return null;
    const data = await response.json();

    for (const block of data.results || []) {
      if (block.type === 'toggle') {
        const text = block.toggle?.rich_text?.[0]?.text?.content || '';
        if (text.startsWith(label)) return block.id;
      }
      // Also check callout blocks (status banner, AI brief, checklist)
      if (block.type === 'callout') {
        const text = block.callout?.rich_text?.[0]?.text?.content || '';
        if (text.startsWith(label)) return block.id;
      }
    }
    return null;
  }

  // ─── Replace children of a block ────────────────────────────────────────────
  // Deletes existing children then appends new ones.

  async replaceBlockChildren(blockId, children, token) {
    // Get existing children
    const existing = await fetch(
      `https://api.notion.com/v1/blocks/${blockId}/children`,
      { headers: this.notionHeaders(token) }
    );

    if (existing.ok) {
      const data = await existing.json();
      // Delete each existing child
      for (const child of data.results || []) {
        await fetch(`https://api.notion.com/v1/blocks/${child.id}`, {
          method: 'DELETE',
          headers: this.notionHeaders(token)
        });
      }
    }

    // Append new children
    const append = await fetch(
      `https://api.notion.com/v1/blocks/${blockId}/children`,
      {
        method: 'PATCH',
        headers: this.notionHeaders(token),
        body: JSON.stringify({ children })
      }
    );

    if (!append.ok) {
      const err = await append.text();
      throw new Error(`Failed to update block ${blockId}: ${err}`);
    }

    return await append.json();
  }

  // ─── Workflow Entry Point ────────────────────────────────────────────────────

  async start({ notionPageId, videoUrl, category, section, tags }) {
    await this.env.AGENT_STATE.put(`workflow:${notionPageId}`, JSON.stringify({
      status: 'researching',
      notionPageId,
      videoUrl,
      category,
      section,
      tags,
      startedAt: Date.now(),
      agents: {}
    }));

    await this.env.ENHANCEMENT_QUEUE.send({
      type: 'research',
      notionPageId,
      videoUrl,
      category
    });

    return new Response(JSON.stringify({ status: 'started', notionPageId }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // ─── Step 1: Research ────────────────────────────────────────────────────────

  async runResearch({ notionPageId, videoUrl, category }) {
    const state = JSON.parse(await this.env.AGENT_STATE.get(`workflow:${notionPageId}`));

    const prompt = `Research this ${category} video thoroughly:
URL: ${videoUrl}

Provide:
1. Main technical topics (bullet list)
2. Key tools/frameworks mentioned
3. Current versions of technologies
4. Related documentation links
5. Target audience level
6. 3 potential blog angles

Format as structured text.`;

    const findings = await this.callGemini(prompt);

    state.agents.research = { findings, completedAt: Date.now() };
    state.status = 'structuring';
    await this.env.AGENT_STATE.put(`workflow:${notionPageId}`, JSON.stringify(state));

    await this.env.ENHANCEMENT_QUEUE.send({ type: 'structure', notionPageId, category });
  }

  // ─── Step 2: Structure ───────────────────────────────────────────────────────

  async runStructure({ notionPageId, category }) {
    const state = JSON.parse(await this.env.AGENT_STATE.get(`workflow:${notionPageId}`));

    const prompt = `Create detailed blog outline for a ${category} article:

RESEARCH:
${state.agents.research.findings}

Create:
1. SEO title (60 chars max)
2. Meta description (155 chars)
3. URL slug (lowercase, hyphens only)
4. H2/H3 structure (3-5 sections)
5. Key points per section
6. Code snippet suggestions
7. CTA placement

Style: conversational but technical, like CSS-Tricks or Smashing Magazine.`;

    const outline = await this.callGemini(prompt);

    state.agents.structure = { outline, completedAt: Date.now() };
    state.status = 'factchecking';
    await this.env.AGENT_STATE.put(`workflow:${notionPageId}`, JSON.stringify(state));

    await this.env.ENHANCEMENT_QUEUE.send({ type: 'factcheck', notionPageId });
  }

  // ─── Step 3: Fact Check ──────────────────────────────────────────────────────

  async runFactCheck({ notionPageId }) {
    const state = JSON.parse(await this.env.AGENT_STATE.get(`workflow:${notionPageId}`));

    const prompt = `Fact-check this content:

RESEARCH: ${state.agents.research.findings}
OUTLINE: ${state.agents.structure.outline}

Identify:
1. Outdated technology references
2. Unclear explanations needing context
3. Missing beginner context
4. Potential inaccuracies (confidence: high/medium/low)
5. Suggested corrections

Return a structured report.`;

    const verification = await this.callGemini(prompt);

    state.agents.factcheck = { verification, completedAt: Date.now() };
    state.status = 'finalizing';
    await this.env.AGENT_STATE.put(`workflow:${notionPageId}`, JSON.stringify(state));

    await this.env.ENHANCEMENT_QUEUE.send({ type: 'finalize', notionPageId });
  }

  // ─── Step 4: Finalize & Populate Template ────────────────────────────────────

  async finalize({ notionPageId }) {
    const state = JSON.parse(await this.env.AGENT_STATE.get(`workflow:${notionPageId}`));
    const secrets = await this.getSecrets();
    const token = secrets.notion_token || this.env.NOTION_TOKEN;

    // ── Generate blog draft ──────────────────────────────────────────────────
    const blogPrompt = `Write a complete ${state.category} blog post (1500-2000 words):

RESEARCH: ${state.agents.research.findings}
STRUCTURE: ${state.agents.structure.outline}
FACT-CHECK: ${state.agents.factcheck.verification}

Requirements:
- Technical but accessible tone
- TL;DR summary at the top (2-3 sentences)
- Use [CODE_BLOCK: description] as placeholders for code examples
- Use [AFFILIATE: toolname] for affiliate link placeholders
- Clear CTA at the end
- Write in full HTML-ready markdown

Write the complete post now.`;

    const blogDraft = await this.callGemini(blogPrompt, 0.8);

    // ── Generate AI brief (2-3 sentence summary) ────────────────────────────
    const briefPrompt = `Write a 2-3 sentence summary of this ${state.category} video content for an editorial brief. Be specific about the key takeaways and who would benefit from watching it. Keep it under 60 words.

RESEARCH: ${state.agents.research.findings}`;

    const aiBrief = await this.callGemini(briefPrompt, 0.5);

    // ── Generate SEO fields ──────────────────────────────────────────────────
    const seoPrompt = `Based on this blog outline, provide SEO metadata in this exact format:
SLUG: (url-slug-here)
META: (meta description under 155 chars)
KEYWORDS: (5-7 comma-separated focus keywords)

OUTLINE: ${state.agents.structure.outline}`;

    const seoRaw = await this.callGemini(seoPrompt, 0.3);
    const slug = seoRaw.match(/SLUG:\s*(.+)/)?.[1]?.trim() || '';
    const meta = seoRaw.match(/META:\s*(.+)/)?.[1]?.trim() || '';
    const keywords = seoRaw.match(/KEYWORDS:\s*(.+)/)?.[1]?.trim() || '';

    // ── Generate social copy ─────────────────────────────────────────────────
    const socialPrompt = `Write social media copy for this ${state.category} blog post.

BRIEF: ${aiBrief}
TITLE: (from outline) ${state.agents.structure.outline.substring(0, 200)}

Write:
TWITTER: (2-3 punchy sentences + relevant hashtags, under 280 chars)
INSTAGRAM: (engaging caption with emojis + hashtags)
REDDIT: (conversational post title + opening sentence for r/technology or relevant subreddit)
LINKEDIN: (professional tone, 3-4 sentences, highlight the value)`;

    const socialRaw = await this.callGemini(socialPrompt, 0.7);
    const twitter = socialRaw.match(/TWITTER:\s*([\s\S]+?)(?=INSTAGRAM:|$)/)?.[1]?.trim() || '';
    const instagram = socialRaw.match(/INSTAGRAM:\s*([\s\S]+?)(?=REDDIT:|$)/)?.[1]?.trim() || '';
    const reddit = socialRaw.match(/REDDIT:\s*([\s\S]+?)(?=LINKEDIN:|$)/)?.[1]?.trim() || '';
    const linkedin = socialRaw.match(/LINKEDIN:\s*([\s\S]+?)$/)?.[1]?.trim() || '';

    // ── Update Notion template blocks ────────────────────────────────────────
    // Find each named toggle/callout and replace its children with AI content.

    // 1. AI Brief callout
    const aiBriefBlockId = await this.findToggleBlock(notionPageId, '🤖 GEMINI', token);
    if (aiBriefBlockId) {
      await this.replaceBlockChildren(aiBriefBlockId, [
        {
          object: 'block',
          type: 'paragraph',
          paragraph: { rich_text: [this.rt(aiBrief)] }
        }
      ], token);
    }

    // 2. Blog Draft toggle
    const blogToggleId = await this.findToggleBlock(notionPageId, '⚡ TFR BLOG DRAFT', token);
    if (blogToggleId) {
      // Notion blocks have a 2000 char limit per rich_text element — chunk the draft
      const chunks = [];
      for (let i = 0; i < blogDraft.length; i += 1900) {
        chunks.push({
          object: 'block',
          type: 'paragraph',
          paragraph: { rich_text: [this.rt(blogDraft.slice(i, i + 1900))] }
        });
      }
      await this.replaceBlockChildren(blogToggleId, chunks, token);
    }

    // 3. Short Form toggle
    const shortFormToggleId = await this.findToggleBlock(notionPageId, '✂️ SHORT FORM', token);
    if (shortFormToggleId) {
      await this.replaceBlockChildren(shortFormToggleId, [
        {
          object: 'block',
          type: 'paragraph',
          paragraph: { rich_text: [this.rt(aiBrief)] }
        }
      ], token);
    }

    // 4. Social Copy Panel toggle
    const socialToggleId = await this.findToggleBlock(notionPageId, '📲 SOCIAL COPY PANEL', token);
    if (socialToggleId) {
      await this.replaceBlockChildren(socialToggleId, [
        {
          object: 'block',
          type: 'callout',
          callout: {
            rich_text: [
              this.rt('𝕏 / Twitter\n', true),
              this.rt(twitter + '\n\n'),
              this.rt('Instagram\n', true),
              this.rt(instagram + '\n\n'),
              this.rt('Reddit\n', true),
              this.rt(reddit + '\n\n'),
              this.rt('LinkedIn\n', true),
              this.rt(linkedin)
            ],
            icon: { emoji: '📲' },
            color: 'green_background'
          }
        }
      ], token);
    }

    // 5. SEO & Discoverability toggle
    const seoToggleId = await this.findToggleBlock(notionPageId, '🔍 SEO', token);
    if (seoToggleId) {
      await this.replaceBlockChildren(seoToggleId, [
        {
          object: 'block',
          type: 'callout',
          callout: {
            rich_text: [
              this.rt('Slug: ', true), this.rt(slug + '\n'),
              this.rt('Meta Description: ', true), this.rt(meta + '\n'),
              this.rt('Focus Keywords: ', true), this.rt(keywords + '\n'),
              this.rt('Internal Links: ', true), this.rt('Gemini-suggested internal links based on Category + Tags match.')
            ],
            icon: { emoji: '🔍' },
            color: 'orange_background'
          }
        }
      ], token);
    }

    // ── Update page properties ───────────────────────────────────────────────
    await fetch(`https://api.notion.com/v1/pages/${notionPageId}`, {
      method: 'PATCH',
      headers: this.notionHeaders(token),
      body: JSON.stringify({
        properties: {
          // Status — use status type, not select
          'Status': { status: { name: '📝 Draft Review' } },
          // Populate SEO Title property
          '📰 SEO Title': { rich_text: [{ text: { content: meta.substring(0, 100) } }] },
          // Populate Blog Draft property (plain text field)
          '📝 Blog Draft': { rich_text: [{ text: { content: blogDraft.substring(0, 2000) } }] },
          // Populate Short Form property
          '✂️ Short Form': { rich_text: [{ text: { content: twitter } }] }
        }
      })
    });

    // ── Save final state ─────────────────────────────────────────────────────
    state.agents.final = {
      blogDraft,
      aiBrief,
      seo: { slug, meta, keywords },
      social: { twitter, instagram, reddit, linkedin },
      wordCount: blogDraft.split(/\s+/).length
    };
    state.status = 'draft_ready';
    state.completedAt = Date.now();
    await this.env.AGENT_STATE.put(`workflow:${notionPageId}`, JSON.stringify(state));

    console.log(`Enhancement complete for ${notionPageId} — ${state.agents.final.wordCount} words`);
  }

  // ─── Queue Message Router ────────────────────────────────────────────────────

  async processMessage(message) {
    const { type, ...payload } = message;

    switch (type) {
      case 'research':  await this.runResearch(payload);  break;
      case 'structure': await this.runStructure(payload); break;
      case 'factcheck': await this.runFactCheck(payload); break;
      case 'finalize':  await this.finalize(payload);     break;
      default:
        console.error(`Unknown enhancement message type: ${type}`);
    }
  }
}
