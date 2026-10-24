'use strict';

/**
 * REST API used by the single-page UI. Every route is plain JSON.
 */

const { execFile } = require('node:child_process');

const paths = require('./paths');
const logger = require('./logger');
const store = require('./store');
const zcode = require('./zcode');
const { PRESETS, getPreset } = require('./presets');
const { maskKey, keyKind, identityFromKey, fingerprint } = require('./token');

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function httpError(status, code, message, extra = {}) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  err.extra = extra;
  return err;
}

/** Fill in providerId when the caller only pasted a key. */
function resolveProvider(input) {
  const apiKey = String(input.apiKey || '').trim();
  const explicit = String(input.providerId || '').trim();
  if (explicit && getPreset(explicit)) return explicit;
  if (explicit) return explicit;
  const detected = zcode.detectPresetIdFor(apiKey, input.baseURL);
  if (detected) return detected;
  throw httpError(400, 'provider_unknown', '无法判断这个 Key 属于哪个套餐，请手动选择。');
}

function normalizeEntry(entry) {
  if (typeof entry === 'string') return { apiKey: entry.trim() };
  if (!entry || typeof entry !== 'object') return null;
  return { ...entry };
}

/* ------------------------------------------------------------------ *
 * Route handlers
 * ------------------------------------------------------------------ */

async function status() {
  const accounts = store.list();
  const active = zcode.activeProvider();
  const running = await zcode.isClientRunning();
  const matched = active ? accounts.find((a) => a.keyFingerprint === active.keyFingerprint) : null;
  return {
    client: {
      installed: zcode.clientInstalled(),
      running,
      path: paths.zcodeV2(),
    },
    active: active
      ? {
          providerId: active.id,
          providerName: (getPreset(active.id) || {}).name || active.name,
          baseURL: active.baseURL,
          apiKeyMasked: active.apiKeyMasked,
          keyFingerprint: active.keyFingerprint,
          accountId: matched ? matched.id : null,
          accountLabel: matched ? matched.label || matched.email : null,
        }
      : null,
    counts: {
      accounts: accounts.length,
      expiring: accounts.filter((a) => a.token.state === 'expiring' || a.token.state === 'expired').length,
    },
    dataDir: paths.dataDir(),
  };
}

function listAccounts() {
  return { accounts: store.list() };
}

async function createAccount(body) {
  const apiKey = String(body.apiKey || '').trim();
  if (!apiKey) throw httpError(400, 'invalid_key', 'API Key 不能为空。');
  const providerId = resolveProvider({ apiKey, providerId: body.providerId, baseURL: body.baseURL });
  const view = store.create({
    apiKey,
    providerId,
    baseURL: body.baseURL,
    email: body.email,
    label: body.label,
    tags: body.tags,
    notes: body.notes,
  });
  return { account: view };
}

function updateAccount(id, body) {
  const patch = { ...body };
  if (patch.providerId && !getPreset(patch.providerId)) {
    delete patch.providerId;
  }
  return { account: store.update(id, patch) };
}

function deleteAccount(id) {
  return store.remove(id);
}

/** The full key, only on an explicit user action. */
function revealAccount(id) {
  const secret = store.getSecret(id);
  if (!secret) throw httpError(404, 'not_found', '账号不存在。');
  logger.info('account.reveal', { id });
  return { apiKey: secret.apiKey };
}

/**
 * Switch the client to this account.
 *
 * Refuses while the client is running unless `force` is set: the desktop app
 * keeps config.json in memory and rewrites it on exit, so a switch made behind
 * its back would silently disappear.
 */
async function activateAccount(id, body = {}) {
  const secret = store.getSecret(id);
  if (!secret) throw httpError(404, 'not_found', '账号不存在。');

  const running = await zcode.isClientRunning();
  if (running && !body.force) {
    throw httpError(
      409,
      'client_running',
      'ZCode 正在运行，它会在退出时把内存里的配置写回磁盘，覆盖这次切换。请先完全退出 ZCode 再切换。',
      { canForce: true },
    );
  }

  const result = zcode.applyAccount(
    { providerId: secret.providerId, apiKey: secret.apiKey, baseURL: secret.baseURL },
    { force: Boolean(body.force) },
  );
  const account = store.markUsed(id);
  return { ok: true, result, account };
}

function importLocal() {
  const report = zcode.importFromClient(store.fingerprints());
  if (!report.installed) {
    throw httpError(400, 'client_missing', `未检测到 ZCode 数据目录（${paths.zcodeV2()}）。`);
  }
  const created = [];
  const results = [];
  for (const row of report.results) {
    if (row.outcome !== 'imported') {
      results.push(row);
      continue;
    }
    try {
      const account = store.create(row.candidate);
      created.push(account);
      results.push({ ...row, outcome: 'imported', accountId: account.id });
    } catch (err) {
      results.push({ ...row, outcome: err.code === 'duplicate' ? 'exists' : 'error', message: err.message });
    }
  }
  return { imported: created.length, accounts: created, results };
}

function importBatch(body) {
  const raw = body.entries ?? body.accounts ?? body.data ?? body;
  let entries = raw;
  if (entries && !Array.isArray(entries) && typeof entries === 'object' && Array.isArray(entries.accounts)) {
    entries = entries.accounts;
  }
  if (!Array.isArray(entries)) {
    throw httpError(400, 'invalid_payload', '批量导入需要 JSON 数组，或包含 accounts 数组的对象。');
  }

  const prepared = [];
  const preSkipped = [];
  for (const item of entries) {
    const entry = normalizeEntry(item);
    if (!entry) {
      preSkipped.push({ reason: 'invalid', entry: String(item) });
      continue;
    }
    const apiKey = String(entry.apiKey || entry.key || entry.token || entry.access_token || '').trim();
    if (!apiKey) {
      preSkipped.push({ reason: 'invalid', entry: item });
      continue;
    }
    try {
      prepared.push({ ...entry, apiKey, providerId: resolveProvider({ ...entry, apiKey }) });
    } catch (err) {
      preSkipped.push({ reason: 'invalid', message: err.message, entry: { ...entry, apiKey: maskKey(apiKey) } });
    }
  }

  const report = store.importBatch(prepared);
  report.skipped = [...preSkipped, ...report.skipped];
  report.total = entries.length;
  return report;
}

function exportAccounts() {
  const payload = store.exportAll();
  logger.info('account.export', { count: payload.accounts.length });
  return payload;
}

function listProviders() {
  return { providers: zcode.listProviders(), presets: PRESETS };
}

function openDataDir(which) {
  const target = which === 'logs' ? paths.logsDir() : which === 'backups' ? paths.backupsDir() : paths.dataDir();
  const cmd = process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  execFile(cmd, [target], { windowsHide: true }, () => {});
  return { opened: target };
}

function recentLogs() {
  const fs = require('node:fs');
  const file = logger.logFile();
  try {
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').slice(-80).reverse();
    return {
      file,
      entries: lines
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return { raw: line };
          }
        }),
    };
  } catch {
    return { file, entries: [] };
  }
}

/** Which provider slot does this key belong to? Used by the add form. */
function detectProvider(body = {}) {
  const apiKey = String(body.apiKey || '').trim();
  const baseURL = String(body.baseURL || '').trim();
  if (!apiKey && !baseURL) return { providerId: null, keyKind: null };
  let providerId = null;
  try {
    providerId = resolveProvider({ apiKey, baseURL });
  } catch {
    providerId = null;
  }
  return {
    providerId,
    keyKind: apiKey ? keyKind(apiKey) : null,
    identity: apiKey ? identityFromKey(apiKey) : null,
    masked: apiKey ? maskKey(apiKey) : '',
    fingerprint: apiKey ? fingerprint(apiKey) : null,
  };
}

/** Local connectivity probe for a stored account's endpoint. */
async function probeAccount(id) {
  const secret = store.getSecret(id);
  if (!secret) throw httpError(404, 'not_found', '账号不存在。');
  const base = String(secret.baseURL || '').replace(/\/+$/, '');
  if (!base) return { ok: false, message: '该账号没有配置 Base URL。' };

  const started = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(base, { method: 'GET', signal: controller.signal });
    clearTimeout(timer);
    return {
      ok: true,
      status: res.status,
      ms: Date.now() - started,
      message: `端点可达（HTTP ${res.status}，${Date.now() - started}ms）`,
    };
  } catch (err) {
    return { ok: false, message: `端点不可达：${err.message}` };
  }
}

module.exports = {
  status,
  listAccounts,
  createAccount,
  updateAccount,
  deleteAccount,
  revealAccount,
  activateAccount,
  importLocal,
  importBatch,
  exportAccounts,
  listProviders,
  openDataDir,
  recentLogs,
  probeAccount,
  detectProvider,
  httpError,
  // exported for tests
  resolveProvider,
};
