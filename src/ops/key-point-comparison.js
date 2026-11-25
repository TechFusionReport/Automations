import { createLlmClient } from '../utils/llm-client.mjs';

export async function generateKeyPointComparison(env, transcript, blogDraft) {
  const sourceTranscript = String(transcript || '').trim().slice(0, 120000);
  const draft = String(blogDraft || '').trim().slice(0, 120000);
  if (!sourceTranscript || !draft) throw new Error('Transcript and blog draft are required');
  const raw = await env.CONTENT_KV.get('secrets');
  const secrets = raw ? JSON.parse(raw) : {};
  const { text } = await createLlmClient(env, secrets).completeText({
    workflow: 'enhancement.generate',
    temperature: 0.1,
    maxTokens: 4096,
    legacyModel: 'gemini-2.5-flash',
    prompt: `Compare the original transcript with the generated blog draft for a human editor.
Do not introduce outside facts. Return concise plain text using exactly these headings:

COVERED KEY POINTS
- Points accurately represented in both

OMITTED FROM DRAFT
- Important transcript points missing from the draft

POSSIBLY UNSUPPORTED IN DRAFT
- Draft claims or details not clearly supported by the transcript

CHANGED DETAILS
- Names, numbers, quotes, or technical details that differ

COVERAGE ESTIMATE
- A cautious percentage estimate with one-sentence rationale

ORIGINAL TRANSCRIPT:
${sourceTranscript}

BLOG DRAFT:
${draft}`,
  });
  return text;
}
