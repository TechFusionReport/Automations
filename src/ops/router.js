'use strict';

const { verifyAccess } = require('./access');
const { createNotionPage } = require('./notion');

// Generic handler for /ops/api/* endpoints. Designed for Express-style req/res.
async function handleOps(req, res) {
  try {
    const ok = verifyAccess(req);
    if (!ok) {
      if (res && typeof res.status === 'function') return res.status(401).json({ error: 'Unauthorized' });
      throw new Error('Unauthorized');
    }

    const url = (req && req.url) || '';

    // POST /ops/api/notion -> create a Notion page
    if (req.method === 'POST' && url.includes('/ops/api/notion')) {
      const data = req.body || {};
      const page = await createNotionPage(data);
      if (res && typeof res.status === 'function') return res.status(201).json(page);
      return page;
    }

    if (res && typeof res.status === 'function') return res.status(404).json({ error: 'Not found' });
    throw new Error('Not found');
  } catch (err) {
    if (res && typeof res.status === 'function') return res.status(500).json({ error: err.message });
    throw err;
  }
}

module.exports = { handleOps };
