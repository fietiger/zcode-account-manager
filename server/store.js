'use strict';

/**
 * Account storage.
 *
 *   <data dir>/accounts.json        index (no secrets, only masked keys)
 *   <data dir>/accounts/<id>.json   one file per account, holds the apiKey
 *
 * Keeping the index free of secrets means a UI listing can never leak a key by
 * accident, and a corrupt index can be rebuilt from the per-account files.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const paths = require('./paths');
const logger = require('./logger');
const { getPreset, familyOf } = require('./presets');
const { maskKey, fingerprint, keyKind, identityFromKey } = require('./token');

const INDEX_VERSION = 1;
const EXPIRY_SOON_MS = 7 * 24 * 60 * 60 * 1000;

function indexFile() {
  return path.join(paths.dataDir(), 'accounts.json');
}

function accountFile(id) {
  return path.join(paths.accountsDir(), `${id}.json`);
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function readJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return raw.trim() ? JSON.parse(raw) : fallback;
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    logger.error('store.read_failed', { file, message: err.message });
    return fallback;
  }
}

function emptyIndex() {
  return { version: INDEX_VERSION, accounts: [] };
}

function loadIndex() {
  const index = readJson(indexFile(), null);
  if (!index || !Array.isArray(index.accounts)) return emptyIndex();
  return index;
}

function saveIndex(index) {
  writeJsonAtomic(indexFile(), index);
}

function newId() {
  return `acc_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

/* ------------------------------------------------------------------ *
 * Derived view of an account (what the UI receives)
 * ------------------------------------------------------------------ */

function tokenState(expiresAt) {
  if (!expiresAt) return { state: 'unknown', label: '长期有效' };
  const left = expiresAt - Date.now();
  if (left <= 0) return { state: 'expired', label: '已过期', expiresAt };
  if (left < EXPIRY_SOON_MS) return { state: 'expiring', label: '即将过期', expiresAt };
  return { state: 'valid', label: '有效', expiresAt };
}

function toView(meta) {
  const preset = getPreset(meta.providerId);
  const ttl = tokenState(meta.expiresAt || null);
  return {
    id: meta.id,
    email: meta.email || '',
    label: meta.label || '',
    providerId: meta.providerId,
    providerName: preset ? preset.name : meta.providerId,
    family: familyOf(meta.providerId),
    region: preset ? preset.region : null,
    baseURL: meta.baseURL || (preset ? preset.baseURL : ''),
    apiKeyMasked: meta.apiKeyMasked,
    keyFingerprint: meta.keyFingerprint,
    keyKind: meta.keyKind,
    tags: Array.isArray(meta.tags) ? meta.tags : [],
    notes: meta.notes || '',
    userId: meta.userId || null,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    lastUsedAt: meta.lastUsedAt || null,
    useCount: meta.useCount || 0,
    token: ttl,
  };
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

function list() {
  const index = loadIndex();
  return index.accounts.map(toView).sort((a, b) => {
    const at = a.lastUsedAt || a.createdAt || 0;
    const bt = b.lastUsedAt || b.createdAt || 0;
    return bt - at;
  });
}

/** Full record including the secret. Only used server-side. */
function getSecret(id) {
  const data = readJson(accountFile(id), null);
  if (!data) return null;
  return data;
}

function get(id) {
  const meta = loadIndex().accounts.find((a) => a.id === id);
  return meta ? toView(meta) : null;
}

function findByKey(apiKey) {
  const fp = fingerprint(apiKey);
  return loadIndex().accounts.find((a) => a.keyFingerprint === fp) || null;
}

/**
 * Create an account. `input` accepts {apiKey, providerId, baseURL, email,
 * label, tags, notes}. Duplicate keys are rejected unless `allowDuplicate`.
 */
function create(input, options = {}) {
  const apiKey = String(input.apiKey || '').trim();
  if (!apiKey) {
    const err = new Error('API Key 不能为空。');
    err.code = 'invalid_key';
    throw err;
  }
  const providerId = String(input.providerId || '').trim();
  if (!providerId) {
    const err = new Error('必须指定要绑定到的 provider。');
    err.code = 'invalid_provider';
    throw err;
  }

  const duplicate = findByKey(apiKey);
  if (duplicate && !options.allowDuplicate) {
    const err = new Error(`该 Key 已存在（${duplicate.label || duplicate.email || duplicate.id}）。`);
    err.code = 'duplicate';
    err.accountId = duplicate.id;
    throw err;
  }

  const preset = getPreset(providerId);
  const identity = identityFromKey(apiKey);
  const now = new Date().toISOString();
  const id = newId();

  const meta = {
    id,
    email: String(input.email || '').trim() || (identity.userId ? `user-${identity.userId}` : ''),
    label: String(input.label || '').trim() || (preset ? preset.name : providerId),
    providerId,
    baseURL: String(input.baseURL || '').trim() || (preset ? preset.baseURL : ''),
    apiKeyMasked: maskKey(apiKey),
    keyFingerprint: fingerprint(apiKey),
    keyKind: keyKind(apiKey),
    userId: identity.userId,
    expiresAt: identity.expiresAt,
    tags: normalizeTags(input.tags),
    notes: String(input.notes || ''),
    createdAt: now,
    updatedAt: now,
    lastUsedAt: null,
    useCount: 0,
  };

  writeJsonAtomic(accountFile(id), {
    id,
    providerId,
    baseURL: meta.baseURL,
    apiKey,
    createdAt: now,
  });

  const index = loadIndex();
  index.accounts.push(meta);
  saveIndex(index);
  logger.info('account.created', { id, providerId, email: meta.email });
  return toView(meta);
}

function update(id, patch) {
  const index = loadIndex();
  const meta = index.accounts.find((a) => a.id === id);
  if (!meta) {
    const err = new Error('账号不存在。');
    err.code = 'not_found';
    throw err;
  }

  if (patch.email !== undefined) meta.email = String(patch.email).trim();
  if (patch.label !== undefined) meta.label = String(patch.label).trim();
  if (patch.tags !== undefined) meta.tags = normalizeTags(patch.tags);
  if (patch.notes !== undefined) meta.notes = String(patch.notes);
  if (patch.baseURL !== undefined) meta.baseURL = String(patch.baseURL).trim();
  if (patch.providerId !== undefined && patch.providerId !== meta.providerId) {
    meta.providerId = String(patch.providerId);
    const preset = getPreset(meta.providerId);
    if (preset && !patch.baseURL) meta.baseURL = preset.baseURL;
  }

  // Rotating the key keeps the account identity but refreshes its secrets.
  if (patch.apiKey) {
    const apiKey = String(patch.apiKey).trim();
    const clash = findByKey(apiKey);
    if (clash && clash.id !== id) {
      const err = new Error(`该 Key 已属于另一个账号（${clash.label || clash.email || clash.id}）。`);
      err.code = 'duplicate';
      throw err;
    }
    const identity = identityFromKey(apiKey);
    const secret = getSecret(id) || { id, createdAt: meta.createdAt };
    writeJsonAtomic(accountFile(id), {
      ...secret,
      providerId: meta.providerId,
      baseURL: meta.baseURL,
      apiKey,
    });
    meta.apiKeyMasked = maskKey(apiKey);
    meta.keyFingerprint = fingerprint(apiKey);
    meta.keyKind = keyKind(apiKey);
    meta.userId = identity.userId;
    meta.expiresAt = identity.expiresAt;
  }

  meta.updatedAt = new Date().toISOString();
  saveIndex(index);
  logger.info('account.updated', { id });
  return toView(meta);
}

function remove(id) {
  const index = loadIndex();
  const before = index.accounts.length;
  index.accounts = index.accounts.filter((a) => a.id !== id);
  if (index.accounts.length === before) {
    const err = new Error('账号不存在。');
    err.code = 'not_found';
    throw err;
  }
  saveIndex(index);
  try {
    fs.unlinkSync(accountFile(id));
  } catch (err) {
    if (err.code !== 'ENOENT') logger.warn('account.unlink_failed', { id, message: err.message });
  }
  logger.info('account.removed', { id });
  return { id };
}

function markUsed(id) {
  const index = loadIndex();
  const meta = index.accounts.find((a) => a.id === id);
  if (!meta) return null;
  meta.lastUsedAt = new Date().toISOString();
  meta.useCount = (meta.useCount || 0) + 1;
  saveIndex(index);
  return toView(meta);
}

/** Fingerprints of everything already stored, for dedupe during imports. */
function fingerprints() {
  return new Set(loadIndex().accounts.map((a) => a.keyFingerprint));
}

/**
 * Batch import. Entries may be objects ({email, apiKey|key|token, providerId,
 * baseURL, label, tags}) or bare key strings. Invalid and duplicate entries are
 * skipped and counted, never thrown.
 */
function importBatch(entries) {
  const report = { imported: [], skipped: [], total: 0 };
  if (!Array.isArray(entries)) return report;

  for (const entry of entries) {
    report.total += 1;
    const normalized = normalizeImportEntry(entry);
    if (!normalized) {
      report.skipped.push({ reason: 'invalid', entry: safePreview(entry) });
      continue;
    }
    try {
      const view = create(normalized);
      report.imported.push(view);
    } catch (err) {
      report.skipped.push({
        reason: err.code === 'duplicate' ? 'duplicate' : 'error',
        message: err.message,
        entry: safePreview(entry),
      });
    }
  }
  logger.info('account.batch_import', {
    total: report.total,
    imported: report.imported.length,
    skipped: report.skipped.length,
  });
  return report;
}

function normalizeImportEntry(entry) {
  if (typeof entry === 'string') {
    const apiKey = entry.trim();
    return apiKey ? { apiKey } : null;
  }
  if (!entry || typeof entry !== 'object') return null;
  const apiKey = String(entry.apiKey || entry.key || entry.token || entry.access_token || '').trim();
  if (!apiKey) return null;
  return {
    apiKey,
    providerId: entry.providerId || entry.provider || undefined,
    baseURL: entry.baseURL || entry.base_url || undefined,
    email: entry.email || entry.account || undefined,
    label: entry.label || entry.name || undefined,
    tags: entry.tags,
    notes: entry.notes,
  };
}

function safePreview(entry) {
  if (typeof entry === 'string') return maskKey(entry);
  if (!entry || typeof entry !== 'object') return String(entry);
  const key = entry.apiKey || entry.key || entry.token || '';
  return { ...entry, apiKey: key ? maskKey(key) : undefined, key: undefined, token: undefined };
}

function normalizeTags(tags) {
  if (!tags) return [];
  const list = Array.isArray(tags) ? tags : String(tags).split(/[,，\s]+/);
  return [...new Set(list.map((t) => String(t).trim()).filter(Boolean))].slice(0, 12);
}

/** Full export including secrets — the user asked for a backup. */
function exportAll() {
  const index = loadIndex();
  const accounts = index.accounts.map((meta) => {
    const secret = getSecret(meta.id) || {};
    return {
      email: meta.email,
      label: meta.label,
      providerId: meta.providerId,
      baseURL: meta.baseURL,
      apiKey: secret.apiKey || '',
      tags: meta.tags,
      notes: meta.notes,
      createdAt: meta.createdAt,
      lastUsedAt: meta.lastUsedAt,
    };
  });
  return {
    app: 'zcode-account-manager',
    version: INDEX_VERSION,
    exportedAt: new Date().toISOString(),
    accounts,
  };
}

module.exports = {
  list,
  get,
  getSecret,
  create,
  update,
  remove,
  markUsed,
  fingerprints,
  importBatch,
  exportAll,
  findByKey,
  toView,
};
