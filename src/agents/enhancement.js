// Enhancement Agent — TechFusion Report
// Synchronous single-pass enhancement using Gemini.
// Reads secrets from CONTENT_KV, writes draft + full SEO package to Notion.

function splitRichText(text, maxChunk = 2000) {
  const chunks = [];
  const value = String(text || '');
  for (let i = 0; i < value.length; i += maxChunk) {
    chunks.push({ text: { content: value.slice(i, i + maxChunk) } });
  }
  return chunks.length ? chunks : [{ text: { content: '' } }];
}

function uniqueKeywords(values = []) {
  const seen = new Set();
  return values
    .flatMap(v => String(v || '').split(','))
    .map(v => v.trim())
    .filter(Boolean)
    .filter(v => {
      const key = v.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 12);
}

function safeSlug(raw = '') {
  return String(raw)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

function getLine(raw, prefix) {
  const m = String(raw || '').match(new RegExp(`^${prefix}:\\s*(.+)$`, 'im'));
  return m ? m[1].trim() : '';
}

function clampSeoScore(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function calculateSeoScore({ seoTitle, seoMeta, focusKeyword, blogDraft, altText, faq, schemaType }) {
  let score = 0;
  const focus = String(focusKeyword || '').toLowerCase();
  const title = String(seoTitle || '');
  const meta = String(seoMeta || '');
  const draft = String(blogDraft || '').toLowerCase();

  if (title.length >= 35 && title.length <= 60) score += 20;
  else if (title.length > 0 && title.length <= 65) score += 12;
  if (meta.length >= 120 && meta.length <= 155) score += 20;
  else if (meta.length > 0 && meta.length <= 165) score += 12;
  if (focus && title.toLowerCase().includes(focus)) score += 15;
  if (focus && meta.toLowerCase().includes(focus)) score += 10;
  if (focus && draft.includes(focus)) score += 10;
  if (altText) score += 10;
  if (faq) score += 10;
  if (schemaType) score += 5;
  return Math.min(100, score);
}

const VALID_INTENTS = new Set(['Informational', 'Commercial', 'Transactional', 'Navigational']);
const VALID_SCHEMAS = new Set(['Article', 'NewsArticle', 'Review', 'HowTo', 'FAQPage', 'VideoObject']);

const TFR_VOICE_PROMPT = `
You are editing this article in TFR's voice. Follow these rules as hard
constraints, not style suggestions.

BANNED WORDS AND PHRASES (cut on sight):
delve, foster, leverage, utilize, facilitate, empower, streamline, robust,
cutting-edge, paradigm shift, game changer, tapestry, realm, beacon,
multifaceted, meticulous, intricate, paramount, transformative, elevate,
embark, supercharge, harness, ever-evolving, crucial, garner, interplay,
testament, underscore, vibrant, nestled, in the heart of, boasts a,
showcasing, exemplifies, commitment to, groundbreaking, breathtaking,
must-visit, stunning, dive into, In conclusion, It's worth noting,
Furthermore, Additionally, That being said.

STRUCTURAL PATTERNS TO CUT:
- Binary contrasts ("It's not X, it's Y") — state Y directly.
- Colon reveals ("The part that matters: X") — rewrite as a plain sentence.
- Throat-clearing openers ("Here's the thing," "Honestly?") — cut the hook.
- Weasel attribution ("experts agree," "studies show") without a named
  source — name the source or cut the claim. Never invent one.
- Rule-of-three padding — don't force ideas into groups of three.
- Synonym cycling — repeat the clear word instead of rotating synonyms.
- Superficial -ing analysis — replace with the concrete mechanism.
- Importance puffery — state the fact, let the reader judge.
- Summary-recap endings — end on the last concrete point or a real next step.
- Fake-profound closing metaphors — delete them.
- Em dashes and en dashes — none in the final draft.
- Inline-header bullet lists — rewrite as prose unless genuinely enumerable.

TFR VOICE:
- Direct, punchy, technically credible. Assumes the reader is smart and interested.
- First sentence earns attention.
- Has an opinion where the source supports one.
- First-person only where the source supports first-hand experience.
- Lead with stakes.
- Vary sentence length.

NEVER INVENT FACTS:
Every claim, name, number, date, or quote must trace back to the source material.
`;

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
        title: snippet.title || '',
        description: (snippet.description || '').slice(0, 1000)
      };
    } catch (e) {
      console.warn('fetchYouTubeVideoDetails failed:', e.message);
      return null;
    }
  }

  async start({
    notionPageId,
    videoUrl,
    category,
    section,
    tags,
    title = '',
    videoId = '',
    sourceDescription = '',
    seoDefaults = {}
  }) {
    const secrets = await this.getSecrets();
    const token = secrets.notion_token;
    if (!token) throw new Error('notion_token missing from secrets');

    let groundingTitle = title || videoUrl;
    let groundingDesc = sourceDescription || '';

    if (videoId) {
      const ytDetails = await this.fetchYouTubeVideoDetails(videoId, secrets);
      if (ytDetails) {
        groundingTitle = ytDetails.title || groundingTitle;
        groundingDesc = ytDetails.description || groundingDesc;
      }
    }

    const primaryDefaults = uniqueKeywords(seoDefaults.primaryKeywords || []);
    const secondaryDefaults = uniqueKeywords(seoDefaults.secondaryKeywords || []);
    const brandVoice = seoDefaults.brandVoice || '';
    const eeatLevel = seoDefaults.eeatLevel || '';
    const topicCluster = seoDefaults.topicCluster || '';
    const defaultAuthor = seoDefaults.defaultAuthor || '';

    const descLine = groundingDesc ? `Video Description:\n${groundingDesc}\n` : '';
    const creatorGuidance = [
      primaryDefaults.length ? `Creator primary keyword targets: ${primaryDefaults.join(', ')}` : '',
      secondaryDefaults.length ? `Creator secondary keyword targets: ${secondaryDefaults.join(', ')}` : '',
      topicCluster ? `Creator topic cluster: ${topicCluster}` : '',
      brandVoice ? `Creator brand voice: ${brandVoice}` : '',
      eeatLevel ? `Creator E-E-A-T target: ${eeatLevel}. Do not manufacture experience or credentials.` : ''
    ].filter(Boolean).join('\n');

    const blogPrompt = `You are a tech blogger writing for TechFusion Report (techfusionreport.com).
${TFR_VOICE_PROMPT}

Write a complete, engaging blog post about this ${category} content.

Video Title: ${groundingTitle}
${descLine}Video URL: ${videoUrl}
Category: ${category}
Section: ${section}
Tags: ${(tags || []).join(', ')}
${creatorGuidance}

Requirements:
- 800–1200 words
- Engaging intro that hooks the reader
- 3–4 clear sections with H2 headings
- Practical takeaways or key points
- Brief conclusion with CTA to watch the video
- Tone: direct, punchy, technically credible
- Use creator keyword targets naturally when they fit the source; never force or stuff them
- Base the post on the provided source material only

Write the full blog post in HTML (use <h2>, <p>, <ul>, <li> tags).`;

    const blogDraft = await this.callGemini(blogPrompt, secrets, 0.75);
    if (!blogDraft || blogDraft.trim().length < 100) throw new Error('Gemini returned empty or insufficient blog draft');

    const validationAnswer = await this.callGemini(
      `Does this article match the topic "${groundingTitle}"? Reply YES or NO only.\n\nArticle excerpt: ${blogDraft.substring(0, 300)}`,
      secrets,
      0.1
    ).catch(e => {
      console.warn('Topical validation call failed:', e.message);
      return 'YES';
    });

    if (!validationAnswer.trim().toUpperCase().startsWith('YES')) {
      throw new Error(`Content mismatch: generated article does not match video topic "${groundingTitle}"`);
    }

    const seoPrompt = `Create an SEO package for this ${category} TechFusion Report article.

Source title: ${groundingTitle}
Category: ${category}
Subcategory: ${section}
Creator primary keywords: ${primaryDefaults.join(', ') || 'none'}
Creator secondary keywords: ${secondaryDefaults.join(', ') || 'none'}
Creator topic cluster: ${topicCluster || 'none'}
Article excerpt: ${blogDraft.substring(0, 1400)}

Do not invent facts, URLs, products, tests, statistics, or credentials.
Choose the focus keyword from the creator defaults when one accurately matches the article; otherwise choose the strongest phrase supported by the source.
Internal links must be TOPIC/ANCHOR SUGGESTIONS only, not invented URLs.
FAQ answers must be supported by the article/source.

Return ONLY this exact line format:
TITLE: [SEO title, 35-60 chars]
SLUG: [lowercase-hyphen-slug]
META: [120-155 char meta description]
FOCUS: [one focus keyword phrase]
SECONDARY: [4-8 comma-separated secondary keywords]
INTENT: [Informational|Commercial|Transactional|Navigational]
SCHEMA: [Article|NewsArticle|Review|HowTo|FAQPage|VideoObject]
ALT: [concise image alt text grounded in the source title]
INTERNAL: [2-4 semicolon-separated internal-link topic/anchor suggestions, no URLs]
FAQ1Q: [question]
FAQ1A: [answer]
FAQ2Q: [question]
FAQ2A: [answer]`;

    const seoRaw = await this.callGemini(seoPrompt, secrets, 0.25);

    const seoTitle = getLine(seoRaw, 'TITLE').slice(0, 70);
    const seoSlug = safeSlug(getLine(seoRaw, 'SLUG') || seoTitle || groundingTitle);
    const seoMeta = getLine(seoRaw, 'META').slice(0, 165);
    const generatedFocus = getLine(seoRaw, 'FOCUS');
    const focusKeyword = generatedFocus || primaryDefaults[0] || '';
    const generatedSecondary = uniqueKeywords([getLine(seoRaw, 'SECONDARY')]);
    const secondaryKeywords = uniqueKeywords([
      generatedSecondary,
      primaryDefaults.filter(k => k.toLowerCase() !== focusKeyword.toLowerCase()),
      secondaryDefaults
    ]).filter(k => k.toLowerCase() !== focusKeyword.toLowerCase()).slice(0, 10);

    const rawIntent = getLine(seoRaw, 'INTENT');
    const searchIntent = VALID_INTENTS.has(rawIntent) ? rawIntent : 'Informational';
    const rawSchema = getLine(seoRaw, 'SCHEMA');
    const schemaType = VALID_SCHEMAS.has(rawSchema) ? rawSchema : 'Article';
    const altText = getLine(seoRaw, 'ALT').slice(0, 300);
    const internalLinks = getLine(seoRaw, 'INTERNAL').slice(0, 1800);
    const faq1q = getLine(seoRaw, 'FAQ1Q');
    const faq1a = getLine(seoRaw, 'FAQ1A');
    const faq2q = getLine(seoRaw, 'FAQ2Q');
    const faq2a = getLine(seoRaw, 'FAQ2A');
    const faq = [
      faq1q && faq1a ? `Q: ${faq1q}\nA: ${faq1a}` : '',
      faq2q && faq2a ? `Q: ${faq2q}\nA: ${faq2a}` : ''
    ].filter(Boolean).join('\n\n');

    const relatedTopic = topicCluster || secondaryKeywords[0] || category || '';
    const seoScore = clampSeoScore(calculateSeoScore({
      seoTitle,
      seoMeta,
      focusKeyword,
      blogDraft,
      altText,
      faq,
      schemaType
    })) ?? 0;

    const jsonLd = JSON.stringify({
      '@context': 'https://schema.org',
      '@type': schemaType,
      headline: seoTitle || groundingTitle,
      description: seoMeta || undefined,
      author: defaultAuthor ? { '@type': 'Person', name: defaultAuthor } : undefined,
      keywords: uniqueKeywords([focusKeyword, secondaryKeywords]).join(', ') || undefined,
      mainEntity: schemaType === 'FAQPage' && faq1q && faq1a
        ? [
            { '@type': 'Question', name: faq1q, acceptedAnswer: { '@type': 'Answer', text: faq1a } },
            ...(faq2q && faq2a ? [{ '@type': 'Question', name: faq2q, acceptedAnswer: { '@type': 'Answer', text: faq2a } }] : [])
          ]
        : undefined
    }, null, 2);

    const socialPrompt = `Write social media copy for this ${category} content.
Title: ${seoTitle || groundingTitle}
Blog excerpt: ${blogDraft.substring(0, 300)}

Return ONLY this format:
TWITTER: [tweet, max 240 chars, include relevant hashtags]
INSTAGRAM: [Instagram caption, 2-3 sentences + hashtags]
LINKEDIN: [LinkedIn post, professional tone, 3-4 sentences]`;

    const socialRaw = await this.callGemini(socialPrompt, secrets, 0.7);
    const twitter = socialRaw.match(/TWITTER:\s*(.+)/)?.[1]?.trim() || '';
    const instagram = socialRaw.match(/INSTAGRAM:\s*(.+)/)?.[1]?.trim() || '';
    const linkedin = socialRaw.match(/LINKEDIN:\s*(.+)/)?.[1]?.trim() || '';

    const seoBlock = [
      seoTitle ? `SEO Title: ${seoTitle}` : '',
      seoSlug ? `Slug: ${seoSlug}` : '',
      seoMeta ? `Meta: ${seoMeta}` : '',
      focusKeyword ? `Focus: ${focusKeyword}` : '',
      secondaryKeywords.length ? `Secondary: ${secondaryKeywords.join(', ')}` : '',
      `Intent: ${searchIntent}`,
      `Schema: ${schemaType}`,
      `SEO Score: ${seoScore}`
    ].filter(Boolean).join('\n');

    const props = {};
    props['📝 Blog Draft'] = { rich_text: splitRichText(blogDraft) };
    if (seoTitle) props['📰 SEO Title'] = { rich_text: [{ text: { content: seoTitle } }] };
    if (seoSlug) props['📰 SEO Slug'] = { rich_text: [{ text: { content: seoSlug } }] };
    if (seoMeta) props['📰 SEO Meta'] = { rich_text: [{ text: { content: seoMeta } }] };
    if (focusKeyword) props['🔑 Focus Keyword'] = { rich_text: [{ text: { content: focusKeyword.slice(0, 2000) } }] };
    if (secondaryKeywords.length) props['🔑 Secondary Keywords'] = { multi_select: secondaryKeywords.map(name => ({ name: name.slice(0, 100) })) };
    props['🎯 Search Intent'] = { select: { name: searchIntent } };
    props['🧬 Schema Type'] = { select: { name: schemaType } };
    props['📈 SEO Score'] = { number: seoScore };
    if (internalLinks) props['🔄 Internal Links'] = { rich_text: splitRichText(internalLinks) };
    if (relatedTopic) props['🧩 Related Topic'] = { rich_text: [{ text: { content: relatedTopic.slice(0, 2000) } }] };
    if (altText) props['🖼️ Image Alt Text'] = { rich_text: [{ text: { content: altText.slice(0, 2000) } }] };
    if (faq) props['❓ SEO FAQ'] = { rich_text: splitRichText(faq) };
    if (jsonLd) props['🧾 JSON-LD'] = { rich_text: splitRichText(jsonLd) };
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

    return {
      notionPageId,
      seoTitle,
      seoSlug,
      focusKeyword,
      searchIntent,
      schemaType,
      seoScore,
      blogWordCount: blogDraft.split(/\s+/).length
    };
  }

  async processMessage({ type, notionPageId, videoUrl, category, section, tags, seoDefaults }) {
    if (type === 'enhance' || type === 'research' || type === 'structure' || type === 'factcheck' || type === 'finalize') {
      return await this.start({ notionPageId, videoUrl, category, section, tags, seoDefaults });
    }
  }
}
