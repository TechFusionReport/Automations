export class EnhancementOrchestrator {
  constructor(env) {
    this.env = env;
  }
  
  async callGemini(prompt, temperature = 0.7) {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${this.env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature, maxOutputTokens: 2048 }
      })
    });
    
    const data = await response.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }
  
  async start({ notionPageId, videoUrl, category, section, tags }) {
    // Initialize workflow state
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
    
    // Queue research job
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
    
    // Queue next step
    await this.env.ENHANCEMENT_QUEUE.send({
      type: 'structure',
      notionPageId,
      category
    });
  }
  
  async runStructure({ notionPageId, category }) {
    const state = JSON.parse(await this.env.AGENT_STATE.get(`workflow:${notionPageId}`));
    
    const prompt = `Create detailed blog outline for ${category} article:

RESEARCH:
${state.agents.research.findings}

Create:
1. SEO title (60 chars max)
2. Meta description (155 chars)
3. URL slug
4. H2/H3 structure (3-5 sections)
5. Key points per section
6. Code snippet suggestions
7. CTA placement

Match CSS-Tricks/Smashing Magazine style.`;
    
    const outline = await this.callGemini(prompt);
    
    state.agents.structure = { outline, completedAt: Date.now() };
    state.status = 'factchecking';
    await this.env.AGENT_STATE.put(`workflow:${notionPageId}`, JSON.stringify(state));
    
    await this.env.ENHANCEMENT_QUEUE.send({
      type: 'factcheck',
      notionPageId
    });
  }
  
  async runFactCheck({ notionPageId }) {
    const state = JSON.parse(await this.env.AGENT_STATE.get(`workflow:${notionPageId}`));
    
    const prompt = `Fact-check this content:

RESEARCH: ${state.agents.research.findings}
OUTLINE: ${state.agents.structure.outline}

Identify:
1. Outdated technology references
2. Unclear explanations
3. Missing beginner context
4. Potential inaccuracies (confidence: high/medium/low)
5. Suggested corrections

Return structured report.`;
    
    const verification = await this.callGemini(prompt);
    
    state.agents.factcheck = { verification, completedAt: Date.now() };
    state.status = 'finalizing';
    await this.env.AGENT_STATE.put(`workflow:${notionPageId}`, JSON.stringify(state));
    
    await this.env.ENHANCEMENT_QUEUE.send({
      type: 'finalize',
      notionPageId
    });
  }
  
  async finalize({ notionPageId }) {
    const state = JSON.parse(await this.env.AGENT_STATE.get(`workflow:${notionPageId}`));
    
    const prompt = `Create complete ${state.category} blog post (1500-2000 words):

RESEARCH: ${state.agents.research.findings}
STRUCTURE: ${state.agents.structure.outline}
FACT-CHECK: ${state.agents.factcheck.verification}

Requirements:
- Technical but accessible
- Code examples as [CODE_BLOCK: description]
- Affiliate placeholders: [AFFILIATE: toolname]
- TL;DR at top
- Clear CTA

Write complete markdown now.`;
    
    const content = await this.callGemini(prompt, 0.8);
    
    // Update Notion with draft
    await fetch(`https://api.notion.com/v1/blocks/${notionPageId}/children`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${this.env.NOTION_TOKEN}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28'
      },
      body: JSON.stringify({
        children: [
          {
            object: 'block',
            type: 'paragraph',
            paragraph: {
              rich_text: [{ text: { content: `AI Draft Generated [${state.category}]` } }]
            }
          },
          {
            object: 'block',
            type: 'code',
            code: {
              language: 'markdown',
              rich_text: [{ text: { content: content.substring(0, 2000) + '...' } }]
            }
          }
        ]
      })
    });
    
    // Update status
    await fetch(`https://api.notion.com/v1/pages/${notionPageId}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${this.env.NOTION_TOKEN}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28'
      },
      body: JSON.stringify({
        properties: { Status: { select: { name: 'Draft Review' } } }
      })
    });
    
    state.agents.final = { content, wordCount: content.split(/\s+/).length };
    state.status = 'draft_ready';
    state.completedAt = Date.now();
    await this.env.AGENT_STATE.put(`workflow:${notionPageId}`, JSON.stringify(state));
  }
}
