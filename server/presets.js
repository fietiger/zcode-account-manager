'use strict';

/**
 * The built-in provider slots ZCode ships with. `id` is the key used inside
 * ~/.zcode/v2/config.json under `provider`.
 *
 * `family` decides which provider domain the account belongs to (international
 * Z.ai vs domestic BigModel). `accepts` is the key shape that slot expects and
 * is used for auto-detection when the user pastes a key.
 */
const PRESETS = [
  {
    id: 'builtin:zai-coding-plan',
    name: 'Z.ai · Coding Plan',
    family: 'zai',
    kind: 'anthropic',
    baseURL: 'https://api.z.ai/api/anthropic',
    accepts: 'opaque',
    plan: 'coding-plan',
    region: '国际',
  },
  {
    id: 'builtin:zai-start-plan',
    name: 'Z.ai · Start Plan',
    family: 'zai',
    kind: 'anthropic',
    baseURL: 'https://zcode.z.ai/api/v1/zcode-plan/anthropic',
    accepts: 'jwt',
    plan: 'start-plan',
    region: '国际',
  },
  {
    id: 'builtin:bigmodel-coding-plan',
    name: 'BigModel · Coding Plan',
    family: 'bigmodel',
    kind: 'anthropic',
    baseURL: 'https://open.bigmodel.cn/api/anthropic',
    accepts: 'id-secret',
    plan: 'coding-plan',
    region: '国内',
  },
  {
    id: 'builtin:bigmodel-start-plan',
    name: 'BigModel · Start Plan',
    family: 'bigmodel',
    kind: 'anthropic',
    baseURL: 'https://zcode.z.ai/api/v1/zcode-plan/anthropic',
    accepts: 'jwt',
    plan: 'start-plan',
    region: '国内',
  },
  {
    id: 'builtin:zai',
    name: 'Z.ai · API Key',
    family: 'zai',
    kind: 'anthropic',
    baseURL: 'https://api.z.ai/api/anthropic',
    accepts: 'opaque',
    plan: 'api',
    region: '国际',
  },
  {
    id: 'builtin:bigmodel',
    name: 'BigModel · API Key',
    family: 'bigmodel',
    kind: 'anthropic',
    baseURL: 'https://open.bigmodel.cn/api/anthropic',
    accepts: 'id-secret',
    plan: 'api',
    region: '国内',
  },
];

const byId = new Map(PRESETS.map((p) => [p.id, p]));

function getPreset(id) {
  return byId.get(id) || null;
}

function familyOf(providerId) {
  const preset = byId.get(providerId);
  if (preset) return preset.family;
  return String(providerId).includes('bigmodel') ? 'bigmodel' : 'zai';
}

module.exports = { PRESETS, getPreset, familyOf };
