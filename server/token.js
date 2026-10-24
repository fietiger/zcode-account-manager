'use strict';

/**
 * API key / plan-token helpers: shape detection, JWT decoding, masking,
 * stable fingerprinting and dedupe keys.
 *
 * ZCode uses three key shapes in practice:
 *   - BigModel API key     "0123456789abcdef0123456789abcdef.fakeSecretValue1"  (id.secret)
 *   - Plan / coding token  a JWT ("eyJhbGciOi....eyJ1c2VyX2lk....sig")
 *   - Z.ai key             short opaque string
 */

const crypto = require('node:crypto');

function isJwt(key) {
  return typeof key === 'string' && key.split('.').length === 3 && key.startsWith('ey');
}

function decodeJwtPayload(key) {
  if (!isJwt(key)) return null;
  const part = key.split('.')[1];
  try {
    const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** "939a...766.sEGr...9hr" — keep a recognisable head and tail. */
function maskKey(key) {
  if (!key) return '';
  const s = String(key);
  if (s.length <= 12) return `${s.slice(0, 2)}${'*'.repeat(Math.max(0, s.length - 2))}`;
  const head = s.slice(0, 6);
  const tail = s.slice(-4);
  return `${head}${'*'.repeat(10)}${tail}`;
}

/** Stable short hash used for dedupe and for the on-card fingerprint chip. */
function fingerprint(key) {
  return crypto.createHash('sha256').update(String(key || ''), 'utf8').digest('hex').slice(0, 16);
}

/** Key shape, used for the badge on each card. */
function keyKind(key) {
  if (!key) return 'empty';
  if (isJwt(key)) return 'jwt';
  if (/^[0-9a-f]{20,}\.[A-Za-z0-9_-]{8,}$/i.test(key)) return 'id-secret';
  return 'opaque';
}

/**
 * Best-effort account identity from the key itself.
 * Plan tokens carry user_id; nothing carries an email.
 */
function identityFromKey(key) {
  const payload = decodeJwtPayload(key);
  if (!payload) return { userId: null, issuedAt: null, expiresAt: null };
  const userId = payload.user_id || payload.sub || null;
  return {
    userId: userId ? String(userId) : null,
    issuedAt: payload.iat ? payload.iat * 1000 : null,
    expiresAt: payload.exp ? payload.exp * 1000 : null,
  };
}

/**
 * Detect which built-in provider slot a key + baseURL belongs to.
 * Returns a preset id, or null when it cannot be determined.
 */
function detectPresetId(apiKey, baseURL, presets) {
  if (baseURL) {
    const normalized = String(baseURL).replace(/\/+$/, '').toLowerCase();
    const byUrl = presets.find((p) => p.baseURL.replace(/\/+$/, '').toLowerCase() === normalized);
    if (byUrl) return byUrl.id;
  }
  if (!apiKey) return null;
  if (isJwt(apiKey)) {
    // Plan tokens are issued per family; without a URL we cannot tell them
    // apart, so prefer the family whose token style matches the JWT.
    return presets.find((p) => p.accepts === 'jwt')?.id || null;
  }
  if (/^[0-9a-f]{20,}\.[A-Za-z0-9_-]{8,}$/i.test(apiKey)) {
    return presets.find((p) => p.family === 'bigmodel' && p.accepts === 'id-secret')?.id || null;
  }
  return presets.find((p) => p.family === 'zai' && p.accepts === 'opaque')?.id || null;
}

module.exports = {
  isJwt,
  decodeJwtPayload,
  maskKey,
  fingerprint,
  keyKind,
  identityFromKey,
  detectPresetId,
};
