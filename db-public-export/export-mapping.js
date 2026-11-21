/**
 * export-mapping.js
 * Pure mapping from Notion pages to the public JSON shape. No network, no Worker APIs, so the
 * Worker, the tests and scripts/db-export-dry-run.mjs all run the exact same code.
 *
 * ALLOWLIST: only the Notion properties named in DATASETS (plus the filter properties) are ever
 * read. Every other property on a page is ignored and never copied, logged or exported.
 */

/** Keys an exported item may contain. Anything else is a bug (see assertAllowedKeys). */
export const ALLOWED_ITEM_KEYS = [
  'id', 'name', 'url', 'description', 'category', 'tags',
  'platform', 'price', 'pricing', 'rating', 'alternativeTo',
];

/**
 * Per-database config. `fields` maps output key -> Notion property name (exact, case-sensitive).
 * Property names are copied from the live schema as given. "Descripton" in AI Tools is
 * misspelled in Notion on purpose; do not "fix" it here.
 */
export const DATASETS = [
  {
    name: 'smartphone-apps',
    envVar: 'DB_SMARTPHONE_APPS',
    fields: {
      name: 'Name', description: 'Description', platform: 'Platform', price: 'Paid/Free',
      pricing: 'Price', rating: 'Rating', tags: 'Tags', url: 'URL',
    },
    // Read only to decide whether a row is published; never exported.
    filterProps: ['Verdict', 'Discontinued'],
    // Returns a skip reason, or null to keep the row.
    reject(props) {
      if (readProperty(props.Verdict) !== 'Keep') return 'verdict_not_keep';
      if (readProperty(props.Discontinued) === true) return 'discontinued';
      return null;
    },
  },
  {
    name: 'gtk-websites',
    envVar: 'DB_GTK_WEBSITES',
    fields: { name: 'Website', url: 'URL', category: 'Category', description: 'Description', tags: 'Tags' },
  },
  {
    name: 'ai-tools',
    envVar: 'DB_AI_TOOLS',
    fields: { name: 'AI Tool', description: 'Descripton', url: 'URL', price: 'Price', pricing: 'Pricing', tags: 'Tags' },
  },
  {
    name: 'open-source-alternatives',
    envVar: 'DB_OPEN_SOURCE_ALTERNATIVES',
    // "Brief" and "OSAT Link" are third-party text/links with unresolved licensing: not exported.
    fields: { name: 'Name', alternativeTo: 'AlternativeTo', url: 'Home Website', tags: 'Tags' },
  },
];

/** Notion property names a dataset reads, for the schema check and filter_properties. */
export function propertyNames(dataset) {
  return [...new Set([...Object.values(dataset.fields), ...(dataset.filterProps || [])])];
}

const plain = (rich) => (rich || []).map((t) => t.plain_text ?? '').join('');

/** Reads one Notion property value. Unknown property types read as undefined. */
export function readProperty(prop) {
  if (!prop) return undefined;
  switch (prop.type) {
    case 'title': return plain(prop.title);
    case 'rich_text': return plain(prop.rich_text);
    case 'url': return prop.url ?? undefined;
    case 'select': return prop.select?.name;
    case 'status': return prop.status?.name;
    case 'multi_select': return (prop.multi_select || []).map((o) => o.name);
    case 'number': return prop.number ?? undefined;
    case 'checkbox': return prop.checkbox;
    case 'formula': {
      const f = prop.formula;
      const v = f ? f[f.type] : undefined;
      return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : undefined;
    }
    default: return undefined;
  }
}

/** Scalar output fields: trimmed text or a number. Multi-selects join with ", ". Empty = absent. */
function scalar(value) {
  if (Array.isArray(value)) value = value.join(', ');
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

/** https only (http is upgraded); no credentials; host must look like a real domain. */
export function sanitizeUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  let url;
  try { url = new URL(raw.trim()); } catch { return undefined; }
  if (url.protocol === 'http:') url.protocol = 'https:';
  if (url.protocol !== 'https:') return undefined;
  if (url.username || url.password) return undefined;
  if (!url.hostname.includes('.')) return undefined;
  return url.href;
}

/** Lowercase ASCII slug, max 80 chars. */
export function slugify(name) {
  const slug = String(name).normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80).replace(/-+$/, '');
  return slug || 'item';
}

/** Tolerates a missing or malformed config: anything unusable means "publish no tags". */
export function normalizeTagConfig(config) {
  const allow = Array.isArray(config?.allow) ? config.allow.filter((t) => typeof t === 'string' && t.trim()) : [];
  const aliases = config?.aliases && typeof config.aliases === 'object' && !Array.isArray(config.aliases) ? config.aliases : {};
  const canonical = new Map(allow.map((t) => [t.trim().toLowerCase(), t.trim()]));
  const aliasMap = new Map();
  for (const [from, to] of Object.entries(aliases)) {
    if (typeof to === 'string') aliasMap.set(from.trim().toLowerCase(), to.trim().toLowerCase());
  }
  return { canonical, aliasMap };
}

/** Publishes only allowlisted tags (case-insensitive match, aliases resolved, de-duplicated). */
export function publicTags(rawTags, tagConfig) {
  const { canonical, aliasMap } = tagConfig;
  const out = [];
  for (const raw of rawTags) {
    const key = raw.trim().toLowerCase();
    const target = canonical.get(aliasMap.get(key) ?? key);
    if (target && !out.includes(target)) out.push(target);
  }
  return out;
}

/** Throws if an item carries a key outside the allowlist. */
export function assertAllowedKeys(item) {
  for (const key of Object.keys(item)) {
    if (!ALLOWED_ITEM_KEYS.includes(key)) throw new Error(`unexpected_export_key:${key}`);
  }
}

/**
 * Maps one Notion page. Returns { skip: reason } or { item (without id), rawTags }.
 * Skip order: dataset filter, missing name, missing/invalid url.
 */
export function mapRow(dataset, page, tagConfig) {
  const props = page?.properties || {};
  const rejected = dataset.reject?.(props);
  if (rejected) return { skip: rejected };

  const read = (outKey) => readProperty(props[dataset.fields[outKey]]);
  const name = scalar(read('name'));
  if (!name) return { skip: 'missing_name' };
  const url = sanitizeUrl(read('url'));
  if (!url) return { skip: 'missing_or_invalid_url' };

  const rawTags = dataset.fields.tags && Array.isArray(read('tags')) ? read('tags') : [];
  const item = { name, url };
  for (const key of ['description', 'category', 'platform', 'price', 'pricing', 'rating', 'alternativeTo']) {
    if (!dataset.fields[key]) continue;
    const value = scalar(read(key));
    if (value !== undefined) item[key] = value;
  }
  item.tags = publicTags(rawTags, tagConfig);
  return { item, rawTags };
}

/**
 * Maps a whole database. Items are sorted by name then url before ids are assigned, so ids
 * do not depend on Notion's row order. Collisions get -2, -3, ... suffixes.
 * Returns { output, read, skipped, tagCounts } (tagCounts counts RAW tags of exported rows).
 */
export function buildDataset(dataset, pages, tagConfig, now = new Date()) {
  const skipped = {};
  const tagCounts = new Map();
  const mapped = [];
  for (const page of pages) {
    const row = mapRow(dataset, page, tagConfig);
    if (row.skip) { skipped[row.skip] = (skipped[row.skip] || 0) + 1; continue; }
    for (const tag of row.rawTags) tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
    mapped.push(row.item);
  }
  mapped.sort((a, b) => a.name.localeCompare(b.name, 'en') || a.url.localeCompare(b.url));

  const used = new Set();
  const items = mapped.map((entry) => {
    const base = slugify(entry.name);
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    const item = { id, ...entry };
    assertAllowedKeys(item);
    return item;
  });

  return {
    output: { updated: now.toISOString(), count: items.length, items },
    read: pages.length,
    skipped,
    tagCounts,
  };
}
