'use strict';

/**
 * Structured file logger. One JSON object per line, appended to
 * <data dir>/logs/app.log. Console output mirrors at a human level.
 */

const fs = require('node:fs');
const path = require('node:path');
const { logsDir } = require('./paths');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold() {
  if (process.env.ZCAM_LOG_DEBUG === '1') return LEVELS.debug;
  if (process.env.ZCAM_LOG_LEVEL && LEVELS[process.env.ZCAM_LOG_LEVEL]) {
    return LEVELS[process.env.ZCAM_LOG_LEVEL];
  }
  return LEVELS.info;
}

function logFile() {
  return path.join(logsDir(), 'app.log');
}

function write(level, event, fields) {
  if (LEVELS[level] < threshold()) return;
  const record = {
    ts: new Date().toISOString(),
    level,
    event,
    ...(fields && typeof fields === 'object' ? fields : {}),
  };
  try {
    fs.appendFileSync(logFile(), `${JSON.stringify(record)}\n`, 'utf8');
  } catch {
    /* logging must never break the app */
  }
  const line = `[${record.ts}] ${level.toUpperCase().padEnd(5)} ${event}${
    fields ? ` ${JSON.stringify(fields)}` : ''
  }`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

module.exports = {
  debug: (event, fields) => write('debug', event, fields),
  info: (event, fields) => write('info', event, fields),
  warn: (event, fields) => write('warn', event, fields),
  error: (event, fields) => write('error', event, fields),
  logFile,
};
