#!/usr/bin/env node
/**
 * Read-only dry run of the public data export against real Notion.
 *
 * Runs the Worker's own mapping + Notion client code, but writes the would-be JSON to ./out/
 * (gitignored) instead of R2. Never prints row text, URLs, ids or tokens: only counts, skip
 * reasons and tag names with their frequencies.
 *
 * Environment (names only; set them in your shell, never paste them anywhere):
 *   TFR_NOTION_READONLY_TOKEN
 *   TFR_DB_SMARTPHONE_APPS  TFR_DB_GTK_WEBSITES  TFR_DB_AI_TOOLS  TFR_DB_OPEN_SOURCE_ALTERNATIVES
 *
 * Usage: node scripts/db-export-dry-run.mjs
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { DATASETS, buildDataset, normalizeTagConfig } from '../db-public-export/export-mapping.js';
import { createNotionClient, fetchDatasetPages } from '../db-public-export/notion-query.js';

const token = process.env.TFR_NOTION_READONLY_TOKEN;
if (!token) {
  console.error('TFR_NOTION_READONLY_TOKEN is not set in this shell. Export it (do not paste it into chat), then re-run.');
  process.exit(2);
}

const TOP_TAGS = 100;
const tagConfig = normalizeTagConfig(JSON.parse(await readFile(new URL('../db-public-export/public-tags.json', import.meta.url), 'utf8')));
const outDir = new URL('../out/', import.meta.url);
await mkdir(outDir, { recursive: true });
const client = createNotionClient({ token });

let failed = 0;
for (const dataset of DATASETS) {
  const envName = `TFR_${dataset.envVar}`;
  console.log(`\n=== ${dataset.name} ===`);
  const dbId = process.env[envName];
  if (!dbId) { console.log(`SKIPPED: ${envName} is not set`); failed++; continue; }
  try {
    const { pages, warnings } = await fetchDatasetPages(client, dbId, dataset);
    const { output, read, skipped, tagCounts } = buildDataset(dataset, pages, tagConfig);
    await writeFile(new URL(`${dataset.name}.json`, outDir), JSON.stringify(output, null, 2));
    const skippedTotal = Object.values(skipped).reduce((a, b) => a + b, 0);
    console.log(`rows read: ${read}`);
    console.log(`rows exported: ${output.count}`);
    console.log(`rows skipped: ${skippedTotal}${skippedTotal ? ' (' + Object.entries(skipped).map(([k, v]) => `${k}: ${v}`).join(', ') + ')' : ''}`);
    if (warnings.length) console.log(`schema warnings: ${warnings.join(', ')}`);
    const tags = [...tagCounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, TOP_TAGS);
    if (!dataset.fields.tags) console.log('tags: not exported for this database');
    else if (!tags.length) console.log('tags: none on exported rows');
    else {
      console.log(`tag frequency (exported rows, ${tagCounts.size} distinct, top ${tags.length}):`);
      for (const [name, count] of tags) console.log(`  ${String(count).padStart(4)}  ${name}`);
    }
  } catch (error) {
    failed++;
    // Only safe error text (HTTP status + Notion error code, or our own codes) is ever printed.
    const safe = error?.name === 'NotionError' || error?.constructor?.name === 'ExportError' ? error.message : 'unexpected_error';
    console.log(`ERROR: ${safe}`);
  }
}
console.log('\nWould-be JSON written to ./out/ (gitignored). Published tags with the shipped config: none.');
process.exit(failed ? 1 : 0);
