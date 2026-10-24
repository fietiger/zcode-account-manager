'use strict';

/**
 * Unit tests. Everything runs against a throwaway ZCODE_HOME / ZCAM_HOME so the
 * real client config is never touched.
 *
 *   node --test test/
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zcam-test-'));
const fakeZcode = path.join(tmpRoot, '.zcode');
fs.mkdirSync(path.join(fakeZcode, 'v2'), { recursive: true });

process.env.ZCODE_HOME = fakeZcode;
process.env.ZCAM_HOME = path.join(tmpRoot, 'appdata');
process.env.ZCAM_LOG_LEVEL = 'error';

const token = require('../server/token');
const store = require('../server/store');
const zcode = require('../server/zcode');
const presets = require('../server/presets');

// Fixtures are synthetic: no real credentials are used or stored here.
const JWT_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VyX2lkIjoiMTAwMDAwMDAwMDAwMDAwMDEiLCJzdWIiOiIxMDAwMDAwMDAwMDAwMDAwMSIsImlhdCI6MTcwMDAwMDAwMH0.fakeSignatureNotVerified';
const BIGMODEL_KEY = '0123456789abcdef0123456789abcdef.fakeSecretValue1';
const FAKE_USER_ID = '10000000000000001';

function resetClient(config) {
  fs.writeFileSync(
    path.join(fakeZcode, 'v2', 'config.json'),
    JSON.stringify(config, null, 2),
    'utf8',
  );
}

function readConfigFile() {
  return JSON.parse(fs.readFileSync(path.join(fakeZcode, 'v2', 'config.json'), 'utf8'));
}

function readSettingFile() {
  return JSON.parse(fs.readFileSync(path.join(fakeZcode, 'v2', 'setting.json'), 'utf8'));
}

const BASE_CONFIG = {
  provider: {
    'builtin:bigmodel-coding-plan': {
      name: 'Bigmodel - Coding Plan',
      kind: 'anthropic',
      options: { apiKey: '', baseURL: 'https://open.bigmodel.cn/api/anthropic' },
      enabled: false,
      source: 'custom',
      models: { 'GLM-5.2': { limit: { context: 1000000 } } },
    },
    'builtin:bigmodel-start-plan': {
      name: 'BigModel- Coding Plan',
      kind: 'anthropic',
      options: { apiKey: JWT_KEY, baseURL: 'https://zcode.z.ai/api/v1/zcode-plan/anthropic' },
      enabled: true,
      source: 'custom',
      models: { 'GLM-5.2': { limit: { context: 1000000 } } },
    },
    'builtin:zai-coding-plan': {
      name: 'Z.ai - Coding Plan',
      kind: 'anthropic',
      options: { apiKey: '', baseURL: 'https://api.z.ai/api/anthropic' },
      enabled: false,
      source: 'custom',
    },
  },
};

/* ------------------------------------------------------------------ *
 * token helpers
 * ------------------------------------------------------------------ */

test('token: masks keys without leaking the middle', () => {
  const masked = token.maskKey(BIGMODEL_KEY);
  assert.ok(masked.startsWith('012345'));
  assert.ok(masked.endsWith('lue1'));
  assert.ok(!masked.includes('abcdef0123456789abcdef'));
  assert.equal(token.maskKey(''), '');
});

test('token: detects key shapes', () => {
  assert.equal(token.keyKind(JWT_KEY), 'jwt');
  assert.equal(token.keyKind(BIGMODEL_KEY), 'id-secret');
  assert.equal(token.keyKind('abcdef123456'), 'opaque');
  assert.equal(token.keyKind(''), 'empty');
});

test('token: decodes JWT identity', () => {
  const id = token.identityFromKey(JWT_KEY);
  assert.equal(id.userId, FAKE_USER_ID);
  assert.equal(id.expiresAt, null);
  assert.equal(token.identityFromKey(BIGMODEL_KEY).userId, null);
});

test('token: fingerprint is stable and distinct', () => {
  assert.equal(token.fingerprint(BIGMODEL_KEY), token.fingerprint(BIGMODEL_KEY));
  assert.notEqual(token.fingerprint(BIGMODEL_KEY), token.fingerprint(JWT_KEY));
});

test('token: detects preset from base URL', () => {
  assert.equal(
    token.detectPresetId('', 'https://open.bigmodel.cn/api/anthropic', presets.PRESETS),
    'builtin:bigmodel-coding-plan',
  );
  assert.equal(
    token.detectPresetId(BIGMODEL_KEY, null, presets.PRESETS),
    'builtin:bigmodel-coding-plan',
  );
});

/* ------------------------------------------------------------------ *
 * store
 * ------------------------------------------------------------------ */

test('store: create, dedupe, update, remove', () => {
  const created = store.create({
    apiKey: BIGMODEL_KEY,
    providerId: 'builtin:bigmodel-coding-plan',
    email: 'a@example.com',
    label: '主账号',
    tags: '主力, 团队',
  });
  assert.equal(created.email, 'a@example.com');
  assert.deepEqual(created.tags, ['主力', '团队']);
  assert.ok(created.apiKeyMasked.includes('*'));
  assert.equal(store.list().length, 1);

  // duplicate rejected
  assert.throws(
    () => store.create({ apiKey: BIGMODEL_KEY, providerId: 'builtin:bigmodel-coding-plan' }),
    (err) => err.code === 'duplicate',
  );

  // secret is stored separately and readable
  assert.equal(store.getSecret(created.id).apiKey, BIGMODEL_KEY);

  const updated = store.update(created.id, { label: '备用账号', notes: 'hi' });
  assert.equal(updated.label, '备用账号');
  assert.equal(updated.notes, 'hi');

  // index must not contain the raw key
  const indexRaw = fs.readFileSync(path.join(process.env.ZCAM_HOME, 'accounts.json'), 'utf8');
  assert.ok(!indexRaw.includes(BIGMODEL_KEY));

  store.remove(created.id);
  assert.equal(store.list().length, 0);
  assert.equal(fs.existsSync(path.join(process.env.ZCAM_HOME, 'accounts', created.id + '.json')), false);
});

test('store: batch import reports imported and skipped', () => {
  const report = store.importBatch([
    { email: 'b@example.com', apiKey: BIGMODEL_KEY, providerId: 'builtin:bigmodel-coding-plan' },
    { email: 'b@example.com', apiKey: BIGMODEL_KEY, providerId: 'builtin:bigmodel-coding-plan' },
    { email: 'c@example.com', apiKey: JWT_KEY, providerId: 'builtin:bigmodel-start-plan' },
    { email: 'broken@example.com' },
  ]);
  assert.equal(report.total, 4);
  assert.equal(report.imported.length, 2);
  assert.equal(report.skipped.length, 2);
  assert.ok(report.skipped.some((s) => s.reason === 'duplicate'));
  assert.ok(report.skipped.some((s) => s.reason === 'invalid'));

  // cleanup
  for (const acc of store.list()) store.remove(acc.id);
});

test('store: export includes secrets', () => {
  const created = store.create({ apiKey: BIGMODEL_KEY, providerId: 'builtin:bigmodel-coding-plan' });
  const dump = store.exportAll();
  assert.equal(dump.accounts.length, 1);
  assert.equal(dump.accounts[0].apiKey, BIGMODEL_KEY);
  store.remove(created.id);
});

/* ------------------------------------------------------------------ *
 * client bridge
 * ------------------------------------------------------------------ */

test('zcode: reads the active provider', () => {
  resetClient(BASE_CONFIG);
  const active = zcode.activeProvider();
  assert.equal(active.id, 'builtin:bigmodel-start-plan');
  assert.equal(active.keyFingerprint, token.fingerprint(JWT_KEY));
  assert.equal(active.identity.userId, FAKE_USER_ID);
});

test('zcode: lists every provider slot', () => {
  resetClient(BASE_CONFIG);
  const rows = zcode.listProviders();
  assert.ok(rows.length >= 3);
  const active = rows.find((r) => r.enabled);
  assert.equal(active.id, 'builtin:bigmodel-start-plan');
  assert.ok(rows.every((r) => !r.apiKeyMasked || r.apiKeyMasked.includes('*')));
});

test('zcode: switching writes the key, disables the old slot, and verifies', () => {
  resetClient(BASE_CONFIG);
  const result = zcode.applyAccount({
    providerId: 'builtin:bigmodel-coding-plan',
    apiKey: BIGMODEL_KEY,
    baseURL: 'https://open.bigmodel.cn/api/anthropic',
  });

  assert.equal(result.providerId, 'builtin:bigmodel-coding-plan');
  assert.deepEqual(result.disabled, ['builtin:bigmodel-start-plan']);

  const config = readConfigFile();
  assert.equal(config.provider['builtin:bigmodel-coding-plan'].options.apiKey, BIGMODEL_KEY);
  assert.equal(config.provider['builtin:bigmodel-coding-plan'].enabled, true);
  assert.equal(config.provider['builtin:bigmodel-start-plan'].enabled, false);

  // only one enabled slot survives
  const enabled = Object.values(config.provider).filter((p) => p.enabled === true);
  assert.equal(enabled.length, 1);

  // family selection follows the account
  assert.equal(readSettingFile().providerFamilyDomain, 'bigmodel');

  // a backup was taken before writing
  assert.ok(result.backup && fs.existsSync(result.backup));
});

test('zcode: switching creates a missing slot from a sibling', () => {
  resetClient({
    provider: {
      'builtin:bigmodel-start-plan': BASE_CONFIG.provider['builtin:bigmodel-start-plan'],
    },
  });
  zcode.applyAccount({
    providerId: 'builtin:zai-coding-plan',
    apiKey: 'zai-key-abcdefghijklmnop',
  });
  const config = readConfigFile();
  const slot = config.provider['builtin:zai-coding-plan'];
  assert.ok(slot, 'slot should be created');
  assert.equal(slot.options.apiKey, 'zai-key-abcdefghijklmnop');
  assert.equal(slot.options.baseURL, 'https://api.z.ai/api/anthropic');
  assert.equal(readSettingFile().providerFamilyDomain, 'zai');
});

test('zcode: import from client reports each slot outcome', () => {
  resetClient(BASE_CONFIG);
  const report = zcode.importFromClient(new Set());
  assert.equal(report.installed, true);
  const imported = report.results.filter((r) => r.outcome === 'imported');
  const empty = report.results.filter((r) => r.outcome === 'not-signed-in');
  assert.equal(imported.length, 1);
  assert.equal(imported[0].providerId, 'builtin:bigmodel-start-plan');
  assert.equal(empty.length, 2);

  // second pass sees it as existing
  const again = zcode.importFromClient(new Set([token.fingerprint(JWT_KEY)]));
  assert.ok(again.results.some((r) => r.outcome === 'exists'));
});

test('zcode: refuses to write when the client is missing', () => {
  const previous = process.env.ZCODE_HOME;
  process.env.ZCODE_HOME = path.join(tmpRoot, 'nope');
  assert.throws(
    () => zcode.applyAccount({ providerId: 'builtin:zai-coding-plan', apiKey: 'k' }),
    (err) => err.code === 'client_missing',
  );
  process.env.ZCODE_HOME = previous;
});

test('zcode: config.json is written atomically and stays valid JSON', () => {
  resetClient(BASE_CONFIG);
  zcode.applyAccount({ providerId: 'builtin:bigmodel-coding-plan', apiKey: BIGMODEL_KEY });
  const raw = fs.readFileSync(path.join(fakeZcode, 'v2', 'config.json'), 'utf8');
  assert.doesNotThrow(() => JSON.parse(raw));
  const leftovers = fs.readdirSync(path.join(fakeZcode, 'v2')).filter((f) => f.includes('.tmp-'));
  assert.deepEqual(leftovers, []);
});

/* ------------------------------------------------------------------ *
 * cleanup
 * ------------------------------------------------------------------ */

test.after(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});
