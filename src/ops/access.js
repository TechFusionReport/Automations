'use strict';

// Simple access check for /ops endpoints.
// Looks for an X-API-KEY header and compares it to process.env.OPS_API_KEY.

function getHeader(req, name) {
  // Support both Express-like objects and Fetch Request headers
  if (!req || !name) return '';
  if (req.headers) {
    if (typeof req.headers.get === 'function') return req.headers.get(name) || '';
    if (typeof req.headers === 'object') return (req.headers[name] || req.headers[name.toLowerCase()] || '');
  }
  return '';
}

function verifyAccess(req) {
  const expected = process.env.OPS_API_KEY || '';
  if (!expected) return false; // no key configured
  const header = getHeader(req, 'x-api-key');
  return header === expected;
}

module.exports = { verifyAccess };
