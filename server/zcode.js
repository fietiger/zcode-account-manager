'use strict';

/**
 * Bridge to the ZCode client on this machine.
 *
 * What we read:  ~/.zcode/v2/config.json, setting.json, coding-plan-cache.json
 * What we write: config.json (provider apiKey / enabled) and two fields in
 *                setting.json (provider family selection).
 *
 * We deliberately never touch credentials.json: its values are DPAPI-encrypted
 * by the Electron client, and the provider apiKey in config.json is what
 * actually selects which account's quota gets billed.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const paths = require('./paths');
const logger = require('./logger');
const { getPreset, familyOf, PRESETS } = require('./presets');
const { maskKey, fingerprint, detectPresetId, identityFromKey } = require('./token');

/* ------------------------------------------------------------------ *
 * Low level JSON helpers
 * ------------------------------------------------------------------ */

function readJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw new Error(`无法读取 ${file}: ${err.message}`);
  }
}

/** Write via temp file + rename so a crash cannot leave a truncated config. */
function writeJsonAtomic(file, value) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}`);
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

/* ------------------------------------------------------------------ *
 * Reading client state
 * ------------------------------------------------------------------ */

function readConfig() {
  const config = readJson(paths.zcodeFiles.config(), null);
  if (!config || typeof config !== 'object') return null;
  if (!config.provider || typeof config.provider !== 'object') config.provider = {};
  return config;
}

function readSetting() {
  return readJson(paths.zcodeFiles.setting(), {}) || {};
}

function readCodingPlanCache() {
  return readJson(paths.zcodeFiles.codingPlanCache(), {}) || {};
}

/** Is the client installed / has it ever run? */
function clientInstalled() {
  return fs.existsSync(paths.zcodeV2());
}

/**
 * Every provider slot the client knows about, plus the presets it does not
 * have yet, so the UI can show the full picture.
 */
function listProviders() {
  const config = readConfig() || { provider: {} };
  const cache = readCodingPlanCache();
  const status = (cache.entryStatus && cache.entryStatus.items) || {};
  const rows = [];
  const seen = new Set();

  for (const preset of PRESETS) {
    const slot = config.provider[preset.id];
    if (!slot) continue;
    seen.add(preset.id);
    rows.push(rowFromSlot(preset, slot, status[preset.id]));
  }
  for (const [id, slot] of Object.entries(config.provider)) {
    if (seen.has(id)) continue;
    rows.push(rowFromSlot(null, slot, status[id], id));
  }
  return rows;
}

function rowFromSlot(preset, slot, planStatus, fallbackId) {
  const id = preset ? preset.id : fallbackId;
  const apiKey = (slot.options && slot.options.apiKey) || '';
  const baseURL = (slot.options && slot.options.baseURL) || (preset ? preset.baseURL : '');
  return {
    id,
    name: (preset && preset.name) || slot.name || id,
    family: familyOf(id),
    region: preset ? preset.region : familyOf(id) === 'bigmodel' ? '国内' : '国际',
    baseURL,
    enabled: slot.enabled === true,
    hasKey: Boolean(apiKey),
    apiKeyMasked: apiKey ? maskKey(apiKey) : '',
    keyFingerprint: apiKey ? fingerprint(apiKey) : null,
    disabledReason: slot.systemDisabledReason || null,
    planStatus: planStatus ? { status: planStatus.status, reason: planStatus.reason || null } : null,
    isPreset: Boolean(preset),
  };
}

/** The provider slot the client is currently using (enabled + has a key). */
function activeProvider() {
  const config = readConfig();
  if (!config) return null;
  for (const [id, slot] of Object.entries(config.provider)) {
    const apiKey = (slot.options && slot.options.apiKey) || '';
    if (slot.enabled === true && apiKey) {
      return {
        id,
        name: slot.name || id,
        family: familyOf(id),
        baseURL: (slot.options && slot.options.baseURL) || '',
        apiKey,
        apiKeyMasked: maskKey(apiKey),
        keyFingerprint: fingerprint(apiKey),
        identity: identityFromKey(apiKey),
      };
    }
  }
  return null;
}

/**
 * Read the client's live account so it can be imported into the manager.
 * `existing` (fingerprint set) lets us report already-known accounts.
 */
function importFromClient(existingFingerprints = new Set()) {
  const config = readConfig();
  if (!config) {
    return { installed: false, results: [] };
  }
  const results = [];
  for (const [id, slot] of Object.entries(config.provider)) {
    const apiKey = (slot.options && slot.options.apiKey) || '';
    if (!apiKey) {
      results.push({ providerId: id, outcome: 'not-signed-in' });
      continue;
    }
    const fp = fingerprint(apiKey);
    if (existingFingerprints.has(fp)) {
      results.push({ providerId: id, outcome: 'exists', keyFingerprint: fp });
      continue;
    }
    const identity = identityFromKey(apiKey);
    const preset = getPreset(id);
    results.push({
      providerId: id,
      outcome: 'imported',
      keyFingerprint: fp,
      candidate: {
        providerId: id,
        baseURL: (slot.options && slot.options.baseURL) || (preset ? preset.baseURL : ''),
        apiKey,
        email: identity.userId ? `user-${identity.userId}` : '',
        label: preset ? preset.name : slot.name || id,
        activeInClient: slot.enabled === true,
      },
    });
  }
  return { installed: true, results };
}

/* ------------------------------------------------------------------ *
 * Writing: switching the active account
 * ------------------------------------------------------------------ */

function backupConfig() {
  const src = paths.zcodeFiles.config();
  if (!fs.existsSync(src)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(paths.backupsDir(), `config-${stamp}.json`);
  fs.copyFileSync(src, dest);
  logger.info('config.backup', { dest });
  return dest;
}

/**
 * Point the client at `account`.
 *
 * Mutual exclusion: only one built-in provider stays enabled, because ZCode
 * routes every request through the single enabled slot. The previously active
 * slot is disabled rather than deleted so its models and settings survive.
 */
function applyAccount(account, options = {}) {
  const { force = false } = options;

  if (!clientInstalled()) {
    const err = new Error(
      `未检测到 ZCode 客户端数据目录（${paths.zcodeV2()}）。请先安装并登录一次 ZCode。`,
    );
    err.code = 'client_missing';
    throw err;
  }

  const config = readConfig();
  if (!config) {
    const err = new Error('config.json 缺失或无法解析，已中止写入以免覆盖客户端配置。');
    err.code = 'config_invalid';
    throw err;
  }

  const preset = getPreset(account.providerId);
  const targetId = account.providerId;
  let slot = config.provider[targetId];

  if (!slot) {
    // Clone a sibling slot of the same family so models/limits stay intact.
    const sibling = PRESETS.filter((p) => p.family === familyOf(targetId))
      .map((p) => config.provider[p.id])
      .find((s) => s && s.models);
    slot = {
      name: preset ? preset.name : targetId,
      kind: (preset && preset.kind) || 'anthropic',
      options: {},
      enabled: false,
      source: 'custom',
      ...(sibling && sibling.models ? { models: JSON.parse(JSON.stringify(sibling.models)) } : {}),
    };
    config.provider[targetId] = slot;
  }
  if (!slot.options || typeof slot.options !== 'object') slot.options = {};

  const previous = [];
  for (const [id, other] of Object.entries(config.provider)) {
    if (id === targetId) continue;
    if (other.enabled === true) {
      other.enabled = false;
      previous.push(id);
    }
  }

  slot.options.apiKey = account.apiKey;
  if (account.baseURL) slot.options.baseURL = account.baseURL;
  else if (!slot.options.baseURL && preset) slot.options.baseURL = preset.baseURL;
  delete slot.systemDisabledReason;
  slot.enabled = true;

  const setting = readSetting();
  const family = familyOf(targetId);
  setting.providerFamilyDomain = family;
  setting.providerFamilyDomainUpdatedAt = Date.now();
  if (!setting.providerFamilyConnectionSelections || typeof setting.providerFamilyConnectionSelections !== 'object') {
    setting.providerFamilyConnectionSelections = {};
  }
  const plan = (preset && preset.plan) || 'coding-plan';
  if (plan !== 'api') {
    setting.providerFamilyConnectionSelections[family] = { kind: 'individual-coding-plan' };
  }

  const backup = backupConfig();
  writeJsonAtomic(paths.zcodeFiles.config(), config);
  writeJsonAtomic(paths.zcodeFiles.setting(), setting);

  // Read back — the client may have rewritten the file under us.
  const verify = activeProvider();
  const ok = Boolean(verify && verify.keyFingerprint === fingerprint(account.apiKey));
  logger.info('switch.applied', {
    providerId: targetId,
    ok,
    disabled: previous,
    backup,
    force,
  });

  if (!ok) {
    const err = new Error(
      '写入后回读校验失败：客户端可能正在运行并把内存状态写了回去。请完全退出 ZCode 后重试。',
    );
    err.code = 'verify_failed';
    err.backup = backup;
    throw err;
  }

  return { providerId: targetId, baseURL: slot.options.baseURL, disabled: previous, backup };
}

/* ------------------------------------------------------------------ *
 * Client process detection
 * ------------------------------------------------------------------ */

const RUNNING_NAMES = {
  win32: ['ZCode.exe'],
  darwin: ['ZCode'],
  linux: ['zcode'],
};

/** Best-effort: is the desktop client running right now? */
function isClientRunning() {
  const names = RUNNING_NAMES[process.platform] || [];
  if (!names.length) return Promise.resolve(false);

  return new Promise((resolve) => {
    const cmd = process.platform === 'win32' ? 'tasklist' : 'ps';
    const args = process.platform === 'win32' ? ['/FO', 'CSV', '/NH'] : ['-A', '-o', 'comm='];
    execFile(cmd, args, { timeout: 4000, windowsHide: true }, (err, stdout) => {
      if (err) {
        // Fall back to the lockfile the client holds while running.
        resolve(fs.existsSync(path.join(paths.zcodeElectronData(), 'lockfile')));
        return;
      }
      const lower = String(stdout).toLowerCase();
      resolve(names.some((n) => lower.includes(n.toLowerCase())));
    });
  });
}

module.exports = {
  readConfig,
  readSetting,
  readCodingPlanCache,
  clientInstalled,
  listProviders,
  activeProvider,
  importFromClient,
  applyAccount,
  backupConfig,
  isClientRunning,
  detectPresetIdFor: (apiKey, baseURL) => {
    // Order presets so the family already configured in the client wins ties
    // (Z.ai and BigModel Start Plan share the same base URL).
    const setting = readSetting();
    const preferred = setting.providerFamilyDomain;
    const ordered = [...PRESETS].sort((a, b) => {
      const aScore = a.family === preferred ? 0 : 1;
      const bScore = b.family === preferred ? 0 : 1;
      return aScore - bScore;
    });
    return detectPresetId(apiKey, baseURL, ordered);
  },
};
