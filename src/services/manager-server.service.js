const fs = require('fs');
const http = require('http');
const path = require('path');
const EventEmitter = require('events');
const libraryService = require('./library.service');
const security = require('../core/manager-http');
const logger = require('../core/logger').createServiceLogger('MANAGER');

// The listener closes itself once no manager tab has been open for this long.
const IDLE_SHUTDOWN_MS = 5 * 60 * 1000;
const HEARTBEAT_MS = 25 * 1000;

const ROOT = path.join(__dirname, '..', '..');
const STATIC = {
  '/': { file: path.join(ROOT, 'manager.html'), type: 'text/html; charset=utf-8' },
  '/manager.js': { file: path.join(ROOT, 'src', 'ui', 'manager.js'), type: 'text/javascript; charset=utf-8' },
  '/manager.css': { file: path.join(ROOT, 'src', 'ui', 'manager.css'), type: 'text/css; charset=utf-8' }
};

const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "media-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ');

const FORBIDDEN_PAGE =
  '<!doctype html><meta charset="utf-8"><title>MeetScribe</title>' +
  '<p style="font-family:system-ui;margin:2em">This link has expired. ' +
  'Open the manager again from MeetScribe (Settings → Open Manager).</p>';

/**
 * The browser manager's local web server.
 *
 * Runs inside the main process (no extra process) and only on demand: nothing
 * listens until the user opens the manager, and it closes itself once no tab
 * has been connected for IDLE_SHUTDOWN_MS. Bound to 127.0.0.1 on a random port;
 * see src/core/manager-http.js for how other pages are kept out.
 *
 * Holds no business logic: meeting data comes from library.service.js, and
 * actions are handed to main.js through `setApi`.
 */
class ManagerServer extends EventEmitter {
  constructor() {
    super();
    this.server = null;
    this.port = null;
    this.token = null;
    this.clients = new Set();
    this.idleTimer = null;
    this.heartbeat = null;
    this.api = {};
  }

  /** { status(): object } and, in later versions, the actions. */
  setApi(api) {
    this.api = api || {};
  }

  isRunning() {
    return Boolean(this.server);
  }

  /** Start if needed; resolves with the one-time URL that signs the browser in. */
  async open() {
    if (!this.server) await this._start();
    this._armIdle();
    return `http://127.0.0.1:${this.port}/?token=${this.token}`;
  }

  _start() {
    this.token = security.newToken();
    const server = http.createServer((req, res) => {
      this._handle(req, res).catch((error) => {
        logger.warn('Manager request failed', { error: error.message });
        if (!res.headersSent) this._json(res, 500, { ok: false, error: error.message });
        else res.end();
      });
    });
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        this.server = server;
        this.port = server.address().port;
        this.heartbeat = setInterval(() => this._send(':\n\n'), HEARTBEAT_MS);
        logger.info('Manager server listening', { port: this.port });
        resolve();
      });
    });
  }

  stop() {
    if (!this.server) return;
    clearTimeout(this.idleTimer);
    clearInterval(this.heartbeat);
    for (const client of this.clients) {
      try { client.end(); } catch (_) { /* gone */ }
    }
    this.clients.clear();
    try {
      this.server.close();
      this.server.closeAllConnections();
    } catch (_) { /* already closed */ }
    this.server = null;
    this.port = null;
    this.token = null;
    logger.info('Manager server stopped');
  }

  /** Close the listener after a quiet period with no open tab. */
  _armIdle() {
    clearTimeout(this.idleTimer);
    if (this.clients.size > 0) return;
    this.idleTimer = setTimeout(() => {
      if (this.clients.size === 0) this.stop();
    }, IDLE_SHUTDOWN_MS);
  }

  /** Push an event to every open manager tab. */
  broadcast(event, data) {
    if (!this.clients.size) return;
    this._send(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  _send(chunk) {
    for (const client of this.clients) {
      try { client.write(chunk); } catch (_) { /* closed; removed on 'close' */ }
    }
  }

  // ── Requests ──

  async _handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const verdict = security.checkRequest({
      method: req.method,
      host: req.headers.host,
      origin: req.headers.origin,
      cookieHeader: req.headers.cookie,
      queryToken: url.searchParams.get('token')
    }, { port: this.port, token: this.token });

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');

    if (!verdict.ok) {
      logger.debug('Manager request refused', { reason: verdict.reason });
      res.writeHead(verdict.status, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(FORBIDDEN_PAGE);
    }
    if (verdict.setCookie) {
      // Swap the token in the URL for a cookie, so it does not stay in the
      // address bar or the history.
      res.writeHead(302, { 'Set-Cookie': security.sessionCookie(this.token), Location: '/' });
      return res.end();
    }

    if (req.method === 'GET' && STATIC[url.pathname]) return this._static(res, STATIC[url.pathname]);
    if (req.method === 'GET' && url.pathname === '/api/events') return this._eventStream(req, res);
    if (req.method === 'GET' && url.pathname === '/media') return this._media(req, res, url);
    if (req.method === 'GET' && url.pathname.startsWith('/api/')) return this._get(res, url);
    return this._json(res, 404, { ok: false, error: 'Not found' });
  }

  _static(res, entry) {
    const body = fs.readFileSync(entry.file);
    const headers = { 'Content-Type': entry.type };
    if (entry.type.startsWith('text/html')) headers['Content-Security-Policy'] = PAGE_CSP;
    res.writeHead(200, headers);
    res.end(body);
  }

  _get(res, url) {
    const query = url.searchParams;
    try {
      switch (url.pathname) {
        case '/api/library':
          return this._json(res, 200, { ok: true, ...libraryService.list() });
        case '/api/meeting':
          return this._json(res, 200, { ok: true, meeting: libraryService.meeting(query.get('id')) });
        case '/api/search':
          return this._json(res, 200, { ok: true, ...libraryService.search(query.get('q')) });
        case '/api/status':
          return this._json(res, 200, { ok: true, ...(this.api.status ? this.api.status() : {}) });
        default:
          return this._json(res, 404, { ok: false, error: 'Not found' });
      }
    } catch (error) {
      return this._json(res, 400, { ok: false, error: error.message });
    }
  }

  _eventStream(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      Connection: 'keep-alive'
    });
    res.write('retry: 3000\n\n');
    this.clients.add(res);
    clearTimeout(this.idleTimer);
    // On the response: a GET request emits 'close' as soon as its (empty) body
    // is read, long before the tab goes away.
    res.on('close', () => {
      this.clients.delete(res);
      this._armIdle();
    });
  }

  /** Audio and screenshots, with byte ranges so the player can seek. */
  _media(req, res, url) {
    let media;
    try {
      media = libraryService.mediaFile(url.searchParams.get('id'), url.searchParams.get('file'));
    } catch (error) {
      return this._json(res, 404, { ok: false, error: error.message });
    }
    const range = security.parseRange(req.headers.range, media.size);
    if (range === 'invalid') {
      res.writeHead(416, { 'Content-Range': `bytes */${media.size}` });
      return res.end();
    }
    const headers = { 'Content-Type': media.type, 'Accept-Ranges': 'bytes' };
    if (range) {
      headers['Content-Range'] = `bytes ${range.start}-${range.end}/${media.size}`;
      headers['Content-Length'] = range.end - range.start + 1;
      res.writeHead(206, headers);
    } else {
      headers['Content-Length'] = media.size;
      res.writeHead(200, headers);
    }
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(media.file, range ? { start: range.start, end: range.end } : {});
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  }

  _json(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  }
}

module.exports = new ManagerServer();
