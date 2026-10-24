'use strict';

/**
 * Local HTTP server: serves the single-page UI and the JSON API.
 * Binds to 127.0.0.1 only — nothing is exposed to the network.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const logger = require('./logger');
const api = require('./api');
const paths = require('./paths');

const HOST = '127.0.0.1';
const DEFAULT_PORT = Number(process.env.ZCAM_PORT || 7777);
const UI_DIR = path.join(__dirname, '..', 'ui');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) {
        reject(api.httpError(413, 'too_large', '请求体过大。'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(api.httpError(400, 'invalid_json', `请求体不是合法 JSON：${err.message}`));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.join(UI_DIR, rel);
  const root = path.resolve(UI_DIR);

  // Directory traversal guard.
  if (!path.resolve(file).startsWith(root)) {
    sendJson(res, 403, { error: 'forbidden' });
    return;
  }

  fs.readFile(file, (err, data) => {
    if (err) {
      sendJson(res, 404, { error: 'not_found', path: pathname });
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'content-length': data.length,
      'cache-control': 'no-store',
    });
    res.end(data);
  });
}

async function route(req, res, url) {
  const { pathname } = url;
  const method = req.method || 'GET';

  if (method === 'GET' && pathname === '/api/status') return sendJson(res, 200, await api.status());
  if (method === 'GET' && pathname === '/api/accounts') return sendJson(res, 200, api.listAccounts());
  if (method === 'GET' && pathname === '/api/providers') return sendJson(res, 200, api.listProviders());
  if (method === 'GET' && pathname === '/api/logs') return sendJson(res, 200, api.recentLogs());

  if (method === 'POST' && pathname === '/api/accounts') {
    return sendJson(res, 201, await api.createAccount(await readBody(req)));
  }
  if (method === 'POST' && pathname === '/api/import/local') {
    return sendJson(res, 200, api.importLocal());
  }
  if (method === 'POST' && pathname === '/api/import/batch') {
    return sendJson(res, 200, api.importBatch(await readBody(req)));
  }
  if (method === 'POST' && pathname === '/api/open-data-dir') {
    const body = await readBody(req);
    return sendJson(res, 200, api.openDataDir(body.which));
  }
  if (method === 'POST' && pathname === '/api/detect') {
    return sendJson(res, 200, api.detectProvider(await readBody(req)));
  }

  if (method === 'GET' && pathname === '/api/export') {
    const payload = api.exportAccounts();
    const body = JSON.stringify(payload, null, 2);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="zcode-accounts-${stamp}.json"`,
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
    });
    return res.end(body);
  }

  const accountMatch = pathname.match(/^\/api\/accounts\/([^/]+)(?:\/([a-z-]+))?$/);
  if (accountMatch) {
    const id = decodeURIComponent(accountMatch[1]);
    const action = accountMatch[2];

    if (method === 'PATCH' && !action) {
      return sendJson(res, 200, api.updateAccount(id, await readBody(req)));
    }
    if (method === 'DELETE' && !action) {
      return sendJson(res, 200, api.deleteAccount(id));
    }
    if (method === 'GET' && action === 'reveal') {
      return sendJson(res, 200, api.revealAccount(id));
    }
    if (method === 'POST' && action === 'activate') {
      return sendJson(res, 200, await api.activateAccount(id, await readBody(req)));
    }
    if (method === 'POST' && action === 'probe') {
      return sendJson(res, 200, await api.probeAccount(id));
    }
  }

  if (pathname.startsWith('/api/')) {
    return sendJson(res, 404, { error: 'not_found', path: pathname });
  }
  return serveStatic(req, res, pathname);
}

function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${HOST}`);
    const started = Date.now();

    // Reject cross-origin writes: this API can hand out secrets.
    if (req.method !== 'GET') {
      const origin = req.headers.origin;
      if (origin && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
        sendJson(res, 403, { error: 'forbidden_origin' });
        return;
      }
    }

    try {
      await route(req, res, url);
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) logger.error('api.error', { path: url.pathname, message: err.message });
      else logger.warn('api.rejected', { path: url.pathname, code: err.code, message: err.message });
      if (!res.headersSent) {
        sendJson(res, status, {
          error: err.code || 'internal_error',
          message: err.message,
          ...(err.extra || {}),
        });
      }
    } finally {
      logger.debug('http', { method: req.method, path: url.pathname, ms: Date.now() - started });
    }
  });
}

function listen(server, port, attempts = 12) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener('listening', onListening);
      if (err.code === 'EADDRINUSE' && attempts > 0) {
        listen(server, port + 1, attempts - 1).then(resolve, reject);
        return;
      }
      reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve(port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, HOST);
  });
}

async function main() {
  const server = createServer();
  const port = await listen(server, DEFAULT_PORT);
  const url = `http://${HOST}:${port}/`;

  logger.info('server.started', { url, dataDir: paths.dataDir(), zcodeHome: paths.zcodeHome() });
  console.log('');
  console.log('  ZCode 账号管理器已启动');
  console.log(`  地址:     ${url}`);
  console.log(`  数据目录: ${paths.dataDir()}`);
  console.log(`  ZCode:    ${paths.zcodeV2()}`);
  console.log('');
  console.log('  按 Ctrl+C 退出。');

  if (process.env.ZCAM_NO_OPEN !== '1' && process.platform === 'win32') {
    require('node:child_process').execFile('cmd', ['/c', 'start', '', url], { windowsHide: true }, () => {});
  }
}

if (require.main === module) {
  main().catch((err) => {
    logger.error('server.failed', { message: err.message });
    console.error(err);
    process.exit(1);
  });
}

module.exports = { createServer, listen, main };
