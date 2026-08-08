'use strict';

// Minimal Notion helper. Uses fetch to call the Notion API.
// Requires NOTION_TOKEN and (optionally) NOTION_DATABASE_ID in env.

const fetch = (typeof globalThis.fetch === 'function') ? globalThis.fetch : require('node-fetch');

const NOTION_API = 'https://api.notion.com/v1/pages';

async function createNotionPage(properties = {}, notionToken = process.env.NOTION_TOKEN) {
  if (!notionToken) throw new Error('Missing NOTION_TOKEN');

  const body = {
    parent: { database_id: process.env.NOTION_DATABASE_ID || '' },
    properties
  };

  const res = await fetch(NOTION_API, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${notionToken}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Notion API error: ${res.status} ${text}`);
  }

  return res.json();
}

module.exports = { createNotionPage };
