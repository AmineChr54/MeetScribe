const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');
const { app } = require('electron');
const security = require('../core/manager-http');
const lan = require('../core/lan');
const qr = require('../core/qr');
const selfSigned = require('../core/self-signed-cert');
const { receiveImport } = require('./import-upload');
const logger = require('../core/logger').createServiceLogger('PHONE');

// Closes itself after this long without a request. The phone page pings every
// 20 s while it is open, so a long recording keeps it alive.
const IDLE_SHUTDOWN_MS = 10 * 60 * 1000;
const MAX_PING_BYTES = 4 * 1024;
const COOKIE_NAME = 'meetscribe_phone';
// An arbitrary high port; replaced by a random one (and remembered) if it is taken.
const DEFAULT_PORT = 47613;
const PHONE_STATES = ['ready', 'recording', 'paused', 'uploading', 'unsent'];

const ROOT = path.join(__dirname, '..', '..');
const STATIC = {
  '/': { file: path.join(ROOT, 'phone.html'), type: 'text/html; charset=utf-8' },
  '/phone.js': { file: path.join(ROOT, 'src', 'ui', 'phone.js'), type: 'text/javascript; charset=utf-8' },
  '/phone.css': { file: path.join(ROOT, 'src', 'ui', 'phone.css'), type: 'text/css; charset=utf-8' },
  '/logo.svg': { file: path.join(ROOT, 'assets', 'brand', 'icon.svg'), type: 'image/svg+xml' }
};

const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ');

const FORBIDDEN_PAGE =
  '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<title>MeetScribe</title><p style="font-family:system-ui;margin:2em;font-size:1.1em">This link has expired. ' +
  'In MeetScribe, open the Library and click <b>Phone</b>, then scan the new code.</p>';

/**
 * The phone recorder's web server.
 *
 * Unlike the manager (loopback only), this one listens on the local network so
 * a phone can reach it, and so it exposes almost nothing: the recording page
 * and two endpoints, a heartbeat and an upload that becomes a new meeting.
 * Nothing from the library can be read through it.
 *
 * HTTPS with a self-signed certificate (phones only allow the microphone on
 * secure pages), a per-start secret handed over in the QR code and then kept
 * in a cookie, Host checked against this PC's LAN addresses, and an https
 * Origin required on every change. Started only from the manager's Phone
 * button and closed after IDLE_SHUTDOWN_MS without a request.
 */
class PhoneServer extends EventEmitter {
  constructor() {
    super();
    this.server = null;
    this.port = null;
    this.token = null;
    this.hosts = [];
    this.address = null;
    this.idleTimer = null;
    this.uploads = 0;
    this.phone = null; // { state, elapsedMs, seenAt }
    this.upload = null; // { pct }
    this.received = null; // { id, name, at }
    this.api = {};
  }

  /** { rerun(dir, overrides), whisperReady(): boolean } */
  setApi(api) {
    this.api = api || {};
  }

  isRunning() {
    return Boolean(this.server);
  }

  addresses() {
    return lan.candidates(os.networkInterfaces());
  }

  url() {
    if (!this.server || !this.address) return null;
    return `https://${this.address}:${this.port}/?token=${this.token}`;
  }

  status() {
    return {
      running: this.isRunning(),
      url: this.url(),
      address: this.address,
      addresses: this.isRunning() ? this.hosts : this.addresses().map((entry) => entry.address),
      phone: this.phone,
      upload: this.upload,
      received: this.received
    };
  }

  qrSvg() {
    const url = this.url();
    if (!url) throw new Error('The phone link is not running');
    return qr.toSvg(url);
  }

  /** A phone is in the middle of something a restart (new token) would break. */
  _phoneBusy() {
    if (this.uploads > 0) return true;
    const phone = this.phone;
    return Boolean(phone && ['recording', 'paused', 'uploading'].includes(phone.state) && Date.now() - phone.seenAt < 2 * 60 * 1000);
  }

  /** Start if needed (or switch the address shown in the QR code). */
  async start(preferred) {
    // Two tabs, or a double click: wait for the start already under way.
    if (this.starting) await this.starting.catch(() => {});
    const ips = this.addresses().map((entry) => entry.address);
    if (!ips.length && !this.server) throw new Error('No network found. Connect this PC to Wi-Fi or Ethernet first.');
    if (this.server) {
      // The certificate and the Host check only know the addresses from the
      // start. Restart only when the address in use is gone, and never under
      // a phone that is recording: a new token would expire its link.
      const usable = ips.filter((ip) => this.hosts.includes(ip));
      if (!usable.length && !this._phoneBusy()) this.stop('network changed');
      else this.address = usable.includes(preferred) ? preferred : usable.includes(this.address) ? this.address : usable[0] || this.address;
    }
    if (!this.server) {
      this.stopRequested = false;
      this.starting = this._start(ips);
      try {
        await this.starting;
      } finally {
        this.starting = null;
      }
      this.address = ips.includes(preferred) ? preferred : ips[0];
      if (this.stopRequested) {
        this.stop('stopped while starting');
        return this.status();
      }
    }
    this._touch();
    this._changed();
    return this.status();
  }

  _start(ips) {
    const { key, cert } = this._certificate(ips);
    this.token = security.newToken();
    this.hosts = ips;
    this.phone = null;
    this.upload = null;
    this.received = null;
    this.uploads = 0;
    this.generation = (this.generation || 0) + 1;
    const server = https.createServer({ key, cert, minVersion: 'TLSv1.2' }, (req, res) => {
      this._handle(req, res).catch((error) => {
        logger.warn('Phone request failed', { error: error.message });
        if (!res.headersSent) this._json(res, 500, { ok: false, error: error.message });
        else res.end();
      });
    });
    // A phone that has not accepted the certificate yet hangs up mid-handshake.
    server.on('tlsClientError', (error) => logger.debug('TLS handshake refused', { error: error.code || error.message }));
    // The same port every time: the page's origin includes it, and the phone
    // keeps unsent recordings per origin.
    const listen = (port) => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '0.0.0.0', () => {
        server.off('error', reject);
        resolve(server.address().port);
      });
    });
    const preferred = this._storedPort();
    return listen(preferred).catch((error) => {
      if (error.code !== 'EADDRINUSE' && error.code !== 'EACCES') throw error;
      logger.info('Phone port taken; using another', { port: preferred });
      return listen(0);
    }).then((port) => {
      this.server = server;
      this.port = port;
      this._storePort(port);
      logger.info('Phone server listening', { port, addresses: ips.length });
    });
  }

  _portFile() {
    return path.join(app.getPath('userData'), 'phone-tls', 'port.txt');
  }

  _storedPort() {
    try {
      const port = Number(fs.readFileSync(this._portFile(), 'utf8').trim());
      if (Number.isInteger(port) && port >= 1024 && port <= 65535) return port;
    } catch (_) { /* first start */ }
    return DEFAULT_PORT;
  }

  _storePort(port) {
    if (port === this._storedPort()) return;
    try {
      fs.mkdirSync(path.dirname(this._portFile()), { recursive: true });
      fs.writeFileSync(this._portFile(), String(port));
    } catch (_) { /* a new port next time; only unsent recordings care */ }
  }

  stop(reason = 'stopped') {
    if (this.starting && !this.server) {
      this.stopRequested = true; // start() stops it as soon as it is up
      return;
    }
    if (!this.server) return;
    clearTimeout(this.idleTimer);
    try {
      this.server.close();
      this.server.closeAllConnections();
    } catch (_) { /* already closed */ }
    this.server = null;
    this.port = null;
    this.token = null;
    this.hosts = [];
    this.address = null;
    this.phone = null;
    this.upload = null;
    this.uploads = 0;
    logger.info('Phone server stopped', { reason });
    this._changed();
    this.emit('stopped');
  }

  /** Reuse the stored certificate while it covers these addresses; the phone then does not warn again. */
  _certificate(ips) {
    const dir = path.join(app.getPath('userData'), 'phone-tls');
    const keyFile = path.join(dir, 'key.pem');
    const certFile = path.join(dir, 'cert.pem');
    let previous = [];
    try {
      const cert = fs.readFileSync(certFile, 'utf8');
      if (selfSigned.stillGood(cert, ips)) return { key: fs.readFileSync(keyFile, 'utf8'), cert };
      previous = selfSigned.addressesOf(cert);
    } catch (_) { /* none yet */ }
    // Keep the addresses the old one covered (home and office Wi-Fi, say), so
    // switching back and forth does not make a new certificate every time.
    const fresh = selfSigned.generate({ ips: [...new Set([...ips, ...previous])].slice(0, 16) });
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(keyFile, fresh.key, { mode: 0o600 });
      fs.writeFileSync(certFile, fresh.cert);
    } catch (error) {
      logger.warn('Could not store the phone certificate', { error: error.message });
    }
    logger.info('New phone certificate made', { addresses: ips.length });
    return fresh;
  }

  _touch() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.uploads > 0) return this._touch();
      return this.stop('idle');
    }, IDLE_SHUTDOWN_MS);
  }

  _changed() {
    this.emit('status', this.status());
  }

  // ── Requests ──

  async _handle(req, res) {
    const url = new URL(req.url, 'https://phone.invalid');
    const verdict = security.checkRequest({
      method: req.method,
      host: req.headers.host,
      origin: req.headers.origin,
      cookieHeader: req.headers.cookie,
      queryToken: url.searchParams.get('token')
    }, { port: this.port, token: this.token, hosts: this.hosts, scheme: 'https', cookieName: COOKIE_NAME });

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');

    if (!verdict.ok) {
      logger.debug('Phone request refused', { reason: verdict.reason });
      req.resume();
      res.writeHead(verdict.status, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(FORBIDDEN_PAGE);
    }
    this._touch();
    // Also when the cookie is already there (the code scanned again): the
    // token should not stay in the address bar or the history.
    if (verdict.setCookie || (req.method === 'GET' && url.searchParams.has('token'))) {
      res.writeHead(302, { 'Set-Cookie': security.sessionCookie(this.token, { cookieName: COOKIE_NAME, secure: true, sameSite: 'Lax' }), Location: '/' });
      return res.end();
    }

    if (req.method === 'GET' && STATIC[url.pathname]) return this._static(res, STATIC[url.pathname]);
    if (req.method === 'POST' && url.pathname === '/api/ping') return this._ping(req, res);
    if (req.method === 'POST' && url.pathname === '/api/upload') return this._upload(req, res, url);
    req.resume();
    return this._json(res, 404, { ok: false, error: 'Not found' });
  }

  _static(res, entry) {
    const body = fs.readFileSync(entry.file);
    const headers = { 'Content-Type': entry.type };
    if (entry.type.startsWith('text/html')) {
      headers['Content-Security-Policy'] = PAGE_CSP;
      headers['Permissions-Policy'] = 'microphone=(self), camera=(), geolocation=()';
    }
    res.writeHead(200, headers);
    res.end(body);
  }

  async _ping(req, res) {
    let body;
    try {
      body = await this._readJson(req);
    } catch (error) {
      return this._json(res, 400, { ok: false, error: error.message });
    }
    const state = PHONE_STATES.includes(body.state) ? body.state : 'ready';
    const elapsedMs = Math.max(0, Math.min(Number(body.elapsedMs) || 0, 7 * 24 * 3600 * 1000));
    this.phone = { state, elapsedMs, seenAt: Date.now() };
    this._changed();
    return this._json(res, 200, { ok: true, whisperReady: this._whisperReady() });
  }

  /** Recordings already received, by the phone's own id: { [clientId]: { dir, id, at } }. */
  _receivedFile() {
    return path.join(app.getPath('userData'), 'phone-tls', 'received.json');
  }

  _receivedLog() {
    try {
      const log = JSON.parse(fs.readFileSync(this._receivedFile(), 'utf8'));
      return log && typeof log === 'object' && !Array.isArray(log) ? log : {};
    } catch (_) {
      return {};
    }
  }

  _remember(clientId, entry) {
    const log = this._receivedLog();
    log[clientId] = entry;
    // The newest hundred are plenty to catch a resend.
    const kept = Object.entries(log).sort((a, b) => b[1].at - a[1].at).slice(0, 100);
    try {
      fs.mkdirSync(path.dirname(this._receivedFile()), { recursive: true });
      fs.writeFileSync(this._receivedFile(), JSON.stringify(Object.fromEntries(kept)));
    } catch (error) {
      logger.warn('Could not note the received recording', { error: error.message });
    }
  }

  /** Answer once the body is drained, so the phone does not see a reset mid-send. */
  _drainThen(req, res, status, body) {
    req.on('end', () => this._json(res, status, body));
    req.on('error', () => res.destroy());
    req.resume();
  }

  async _upload(req, res, url) {
    const query = url.searchParams;
    const clientId = /^[\w-]{1,64}$/.test(query.get('clientId') || '') ? query.get('clientId') : null;
    // A resend whose first answer was lost on the way: the PC has it already.
    if (clientId) {
      const known = this._receivedLog()[clientId];
      if (known && fs.existsSync(known.dir)) {
        logger.info('Phone resent a recording already received');
        return this._drainThen(req, res, 200, { ok: true, id: known.id, duplicate: true, transcribing: false });
      }
      this.inFlight = this.inFlight || new Set();
      if (this.inFlight.has(clientId)) return this._drainThen(req, res, 409, { ok: false, error: 'This recording is already being sent' });
      this.inFlight.add(clientId);
    }
    const generation = this.generation;
    this.uploads++;
    this.upload = { pct: 0 };
    this._changed();
    let lastPct = 0;
    let result;
    try {
      result = await receiveImport(req, {
        name: String(query.get('name') || '').trim() || 'Phone recording',
        startedAt: query.get('startedAt'),
        durationMs: query.get('durationMs'),
        folder: '',
        label: 'Phone',
        ext: query.get('ext')
      }, {
        onProgress: (bytes, size) => {
          const pct = bytes / size;
          if (pct - lastPct < 0.02 && pct < 1) return;
          lastPct = pct;
          this.upload = { pct };
          this._touch();
          this._changed();
        }
      });
    } finally {
      if (clientId) this.inFlight.delete(clientId);
      // Turned off (and maybe on again) meanwhile: that run's counters are not ours.
      if (this.generation === generation && this.server) {
        this.uploads--;
        this.upload = null;
      }
    }
    const current = this.generation === generation && Boolean(this.server);
    let transcribing = false;
    if (result.body.ok) {
      // The file is on disk either way, so it is transcribed even if the link
      // was turned off during the upload.
      transcribing = this._whisperReady() && Boolean(this.api.rerun);
      if (transcribing) this.api.rerun(result.dir, {});
      if (clientId) this._remember(clientId, { dir: result.dir, id: result.body.id, at: Date.now() });
      logger.info('Phone recording received', { transcribing });
      if (current) {
        this.received = { id: result.body.id, name: path.basename(result.dir), at: Date.now() };
        this.phone = { state: 'ready', elapsedMs: 0, seenAt: Date.now() };
      }
      this.emit('received', { id: result.body.id, name: path.basename(result.dir) });
    } else {
      logger.info('Phone upload refused', { error: result.body.error });
    }
    if (current) this._changed();
    if (res.writableEnded || res.destroyed) return undefined;
    return this._json(res, result.status, { ...result.body, transcribing });
  }

  _whisperReady() {
    try {
      return Boolean(this.api.whisperReady && this.api.whisperReady());
    } catch (_) {
      return false;
    }
  }

  _readJson(req) {
    if (!/^application\/json\b/.test(req.headers['content-type'] || '')) {
      req.resume();
      return Promise.reject(new Error('Expected JSON'));
    }
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_PING_BYTES) {
          reject(new Error('Request too large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected an object');
          resolve(parsed);
        } catch (error) {
          reject(new Error('Invalid JSON: ' + error.message));
        }
      });
      req.on('error', reject);
    });
  }

  _json(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  }
}

module.exports = new PhoneServer();
