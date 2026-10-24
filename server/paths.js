'use strict';

/**
 * Path resolution for the ZCode client data directory and this app's own
 * data directory.
 *
 * Every path can be overridden for tests / portable installs:
 *   ZCODE_HOME  -> the zcode user data dir (default: ~/.zcode)
 *   ZCAM_HOME   -> this app's data dir
 */

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const APP_DIR_NAME = 'zcode-account-manager';

function homedir() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

function appDataRoot() {
  if (process.platform === 'win32') {
    return process.env.APPDATA || path.join(homedir(), 'AppData', 'Roaming');
  }
  if (process.platform === 'darwin') {
    return path.join(homedir(), 'Library', 'Application Support');
  }
  return process.env.XDG_DATA_HOME || path.join(homedir(), '.local', 'share');
}

/** The zcode client data dir, e.g. ~/.zcode */
function zcodeHome() {
  return process.env.ZCODE_HOME || path.join(homedir(), '.zcode');
}

/** Where the client keeps its v2 (desktop) state. */
function zcodeV2() {
  return path.join(zcodeHome(), 'v2');
}

/** The Electron user data dir, used only to detect a running client. */
function zcodeElectronData() {
  if (process.env.ZCODE_ELECTRON_DATA) return process.env.ZCODE_ELECTRON_DATA;
  if (process.platform === 'win32') return path.join(appDataRoot(), 'ZCode');
  if (process.platform === 'darwin') return path.join(appDataRoot(), 'ZCode');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config'), 'ZCode');
}

/** This app's data dir. */
function dataDir() {
  const dir = process.env.ZCAM_HOME || path.join(appDataRoot(), APP_DIR_NAME);
  ensureDir(dir);
  return dir;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function accountsDir() {
  return ensureDir(path.join(dataDir(), 'accounts'));
}

function backupsDir() {
  return ensureDir(path.join(dataDir(), 'backups'));
}

function logsDir() {
  return ensureDir(path.join(dataDir(), 'logs'));
}

/** Paths of the files we read/write inside the client. */
const zcodeFiles = {
  config: () => path.join(zcodeV2(), 'config.json'),
  setting: () => path.join(zcodeV2(), 'setting.json'),
  codingPlanCache: () => path.join(zcodeV2(), 'coding-plan-cache.json'),
  providerConfig: () => path.join(zcodeV2(), 'provider_config.json'),
  credentials: () => path.join(zcodeV2(), 'credentials.json'),
};

module.exports = {
  APP_DIR_NAME,
  homedir,
  appDataRoot,
  zcodeHome,
  zcodeV2,
  zcodeElectronData,
  dataDir,
  ensureDir,
  accountsDir,
  backupsDir,
  logsDir,
  zcodeFiles,
};
