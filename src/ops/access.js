// Cloudflare Access JWT verification for the /ops dashboard API.
// Runs in the Cloudflare Workers isolate — Web Crypto only, no Node APIs.
//
// When Cloudflare Access sits in front of techfusionreport.com/ops, it injects
// a signed identity JWT on every request it proxies to this Worker, in the
// `Cf-Access-Jwt-Assertion` header (also mirrored in the CF_Authorization
// cookie). We verify that JWT against the team's public JWKS and check aud/exp.
//
// KV cache: `ops_access_jwks` (JWKS JSON, ~1h TTL). On a kid miss we refetch.

const JWKS_KV_KEY = 'ops_access_jwks';
const JWKS_TTL_SECONDS = 3600;

// ── base64url → bytes ────────────────────────────────────────────────────────
function base64UrlToBytes(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (str.length % 4)) % 4);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function base64UrlToJson(str) {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(str)));
}

// Split a compact JWS into its parts. Throws on malformed input.
export function parseJwt(token) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed JWT: expected 3 segments');
  const [h, p, s] = parts;
  return {
    header: base64UrlToJson(h),
    payload: base64UrlToJson(p),
    signingInput: `${h}.${p}`,
    signatureBytes: base64UrlToBytes(s),
  };
}

// Pull the Access JWT from the header Access injects, falling back to the cookie.
function readAccessToken(request) {
  const header = request.headers.get('Cf-Access-Jwt-Assertion');
  if (header) return header.trim();
  const cookie = request.headers.get('Cookie') || request.headers.get('cookie');
  if (cookie) {
    const match = cookie.match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
    if (match) return match[1].trim();
  }
  return null;
}

async function getJwks(env, fetchImpl, { forceRefresh = false } = {}) {
  if (!forceRefresh) {
    const cached = await env.CONTENT_KV.get(JWKS_KV_KEY);
    if (cached) {
      try { return JSON.parse(cached); } catch { /* fall through to refetch */ }
    }
  }
  const url = `https://${env.ACCESS_TEAM_DOMAIN}.cloudflareaccess.com/cdn-cgi/access/certs`;
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const jwks = await res.json();
  await env.CONTENT_KV.put(JWKS_KV_KEY, JSON.stringify(jwks), { expirationTtl: JWKS_TTL_SECONDS });
  return jwks;
}

function findKey(jwks, kid) {
  return (jwks.keys || []).find((k) => k.kid === kid) || null;
}

async function verifySignature(jwk, signingInput, signatureBytes) {
  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );
  return crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5', key, signatureBytes, new TextEncoder().encode(signingInput)
  );
}

function audMatches(payloadAud, expected) {
  const expectedAudiences = String(expected || '').split(',').map((value) => value.trim()).filter(Boolean);
  const tokenAudiences = Array.isArray(payloadAud) ? payloadAud : [payloadAud];
  return expectedAudiences.some((audience) => tokenAudiences.includes(audience));
}

/**
 * Verify a request carries a valid Cloudflare Access identity.
 * @returns {{ ok: true, email: string } | { ok: false, status: number, error: string }}
 */
export async function verifyAccessRequest(request, env, { fetchImpl = fetch, now = Date.now } = {}) {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
    return { ok: false, status: 500, error: 'Access not configured (ACCESS_TEAM_DOMAIN / ACCESS_AUD allowlist)' };
  }

  const token = readAccessToken(request);
  if (!token) return { ok: false, status: 403, error: 'missing Access token' };

  let parsed;
  try {
    parsed = parseJwt(token);
  } catch (e) {
    return { ok: false, status: 403, error: `invalid token: ${e.message}` };
  }

  const { header, payload, signingInput, signatureBytes } = parsed;
  if (header.alg !== 'RS256') return { ok: false, status: 403, error: `unexpected alg: ${header.alg}` };

  // Resolve signing key; refetch JWKS once if the kid isn't cached (rotation).
  let jwks = await getJwks(env, fetchImpl);
  let jwk = findKey(jwks, header.kid);
  if (!jwk) {
    jwks = await getJwks(env, fetchImpl, { forceRefresh: true });
    jwk = findKey(jwks, header.kid);
  }
  if (!jwk) return { ok: false, status: 403, error: 'no matching signing key' };

  let validSig = false;
  try {
    validSig = await verifySignature(jwk, signingInput, signatureBytes);
  } catch (e) {
    return { ok: false, status: 403, error: `signature check failed: ${e.message}` };
  }
  if (!validSig) return { ok: false, status: 403, error: 'bad signature' };

  const nowSec = Math.floor(now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp <= nowSec) {
    return { ok: false, status: 403, error: 'token expired' };
  }
  if (!audMatches(payload.aud, env.ACCESS_AUD)) {
    return { ok: false, status: 403, error: 'audience mismatch' };
  }
  if (!payload.email) return { ok: false, status: 403, error: 'no email in token' };

  return { ok: true, email: payload.email };
}
