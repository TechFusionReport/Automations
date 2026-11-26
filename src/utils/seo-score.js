import { CATALOG_PROPERTIES as P } from './content-catalog.js';

const SITE_ORIGIN = 'https://techfusionreport.com';
const text = value => typeof value === 'string' ? value.trim() : '';
const words = value => value.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];

function lengthPoints(value, min, max) {
  const length = [...text(value)].length;
  if (length >= min && length <= max) return 15;
  return length >= Math.ceil(min * 0.9) && length <= Math.floor(max * 1.1) ? 12 : 0;
}

function includesKeyword(tokens, keyword) {
  return keyword.length > 0 && ` ${tokens.join(' ')} `.includes(` ${keyword.join(' ')} `);
}

function internalLinkCount(body, internalLinks) {
  const links = new Set();
  const candidates = [
    ...[...body.matchAll(/(?<!!)\[[^\]]*\]\(([^\s)]+)[^)]*\)|<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi)]
      .map(([, markdown, html]) => markdown || html),
    ...(text(internalLinks).match(/https?:\/\/[^\s"'<>),\]]+|(?<![\w/])(?:\.\.?\/|\/(?!\/))[^\s"'<>),\]]+/gi) || []),
  ];
  for (const target of candidates) {
    if (/^(?:#|\/\/|\\)/.test(target)) continue;
    try {
      const url = new URL(target, SITE_ORIGIN);
      if (url.protocol === 'https:' && ['techfusionreport.com', 'www.techfusionreport.com'].includes(url.hostname)) {
        links.add(url.pathname.replace(/\/$/, '') || '/');
      }
    } catch { /* Ignore malformed targets. */ }
  }
  return links.size;
}

export function computeSeoScore(fields) {
  const keyword = words(text(fields.focusKeyword));
  const slug = text(fields.seoSlug);
  const body = text(fields.body)
    .replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[ \t]*$/gm, ' ')
    .replace(/<(script|style|pre|code)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/`[^`\n]*`/g, ' ');
  const bodyWords = words(body
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(?:#[\da-fx]+|[a-z]+);/gi, ' '));
  const slugWords = slug.split('-');
  const h2Count = (body.match(/^ {0,3}##[ \t]+\S.*$/gm) || []).length
    + (body.match(/<h2\b[^>]*>/gi) || []).length;

  const breakdown = {
    seoTitleLength: lengthPoints(fields.seoTitle, 50, 60),
    seoMetaLength: lengthPoints(fields.seoMeta, 140, 160),
    seoSlug: slug.length <= 60 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)
      && keyword.length > 0 && keyword.every(word => slugWords.includes(word)) ? 10 : 0,
    keywordInTitle: includesKeyword(words(text(fields.seoTitle)), keyword) ? 10 : 0,
    keywordInMeta: includesKeyword(words(text(fields.seoMeta)), keyword) ? 10 : 0,
    keywordInOpening: includesKeyword(bodyWords.slice(0, 100), keyword) ? 10 : 0,
    bodyLength: bodyWords.length >= 600 ? 10 : 0,
    h2Headings: h2Count >= 2 ? 5 : 0,
    imageAlt: text(fields.imageAlt) ? 5 : 0,
    internalLinks: internalLinkCount(body, fields.internalLinks) >= 2 ? 5 : 0,
    schemaType: text(fields.schemaType) ? 5 : 0,
  };
  return { score: Object.values(breakdown).reduce((total, points) => total + points, 0), breakdown };
}

/** Catalog values without the publisher's display defaults, plus its effective draft. */
export function readSeoFields(props, body) {
  const rich = name => props[name]?.rich_text?.map(r => r.plain_text || r.text?.content || '').join('').trim() || '';
  return {
    seoTitle: rich(P.seoTitle),
    seoSlug: rich(P.seoSlug),
    seoMeta: rich(P.seoMeta),
    focusKeyword: rich(P.focusKeyword),
    schemaType: props[P.schemaType]?.select?.name || '',
    imageAlt: rich(P.imageAltText),
    internalLinks: rich(P.internalLinks),
    body,
  };
}
