const fs = require('fs');
const http = require('http');
const path = require('path');
const EventEmitter = require('events');
const libraryService = require('./library.service');
const libraryEdit = require('./library-edit.service');
const security = require('../core/manager-http');
const library = require('../core/library');
const settingsSchema = require('../core/settings-schema');
const profiles = require('../core/profiles');
const glossaries = require('../core/glossaries');
const logger = require('../core/logger').createServiceLogger('MANAGER');

// The listener closes itself once no manager tab has been open for this long.
const IDLE_SHUTDOWN_MS = 5 * 60 * 1000;
const HEARTBEAT_MS = 25 * 1000;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_IMPORT_BYTES = 4 * 1024 * 1024 * 1024;

// POST /api/<name>: body in, result out. Each one changes something on disk,
// so every open tab is told to refresh afterwards.
const ACTIONS = {
  'meeting/info': (body) => libraryEdit.saveInfo(body.id, body.info),
  'meeting/rename': (body) => libraryEdit.renameMeeting(body.id, body.name),
  'meeting/move': (body) => libraryEdit.move(body.ids, body.folder),
  'meeting/tag': (body) => libraryEdit.tag(body.ids, body.tag, body.remove),
  'meeting/trash': (body) => libraryEdit.trash(body.ids, body.what === 'audio' ? 'audio' : 'all'),
  'meeting/edit': (body) => libraryEdit.editTranscript(body.id, body.op),
  'meeting/glossary': (body) => libraryEdit.saveGlossary(body.id, body.text),
  'corrections': (body) => libraryEdit.saveCorrections(body.id || '', body.rules),
  'folder/create': (body) => libraryEdit.createFolder(body.parent, body.name),
  'folder/rename': (body) => libraryEdit.renameFolder(body.id, body.name),
  'folder/delete': (body) => libraryEdit.deleteFolder(body.id),
  'folder/move': (body) => libraryEdit.moveFolder(body.id, body.parent),
  'meeting/glossaries': (body) => libraryEdit.applyGlossaries(body.id, Array.isArray(body.names) ? body.names : []),
  'glossaries/save': (body) => libraryEdit.saveProjectGlossary({ name: body.name, previous: body.previous, text: body.text }),
  'glossaries/delete': (body) => libraryEdit.deleteProjectGlossary(body.name)
};

const ROOT = path.join(__dirname, '..', '..');
const STATIC = {
  '/': { file: path.join(ROOT, 'manager.html'), type: 'text/html; charset=utf-8' },
  '/manager.js': { file: path.join(ROOT, 'src', 'ui', 'manager.js'), type: 'text/javascript; charset=utf-8' },
  '/manager.css': { file: path.join(ROOT, 'src', 'ui', 'manager.css'), type: 'text/css; charset=utf-8' },
  '/flags.js': { file: path.join(ROOT, 'src', 'ui', 'flags.js'), type: 'text/javascript; charset=utf-8' },
  '/glossary-budget.js': { file: path.join(ROOT, 'src', 'core', 'glossary-budget.js'), type: 'text/javascript; charset=utf-8' },
  '/logo.svg': { file: path.join(ROOT, 'assets', 'brand', 'icon.svg'), type: 'image/svg+xml' }
};

const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  // blob: lets the page read an imported file's length before uploading it.
  "media-src 'self' blob:",
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
    this.emit('stopped');
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
    if (req.method === 'GET' && url.pathname === '/api/export') return this._export(res, url);
    if (req.method === 'GET' && url.pathname === '/api/hub') return this._hub(res, url);
    if (req.method === 'GET' && url.pathname.startsWith('/api/')) return this._get(res, url);
    if (req.method === 'POST' && url.pathname === '/api/import') return this._import(req, res, url);
    if (req.method === 'POST' && url.pathname.startsWith('/api/')) return this._post(req, res, url);
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
        case '/api/glossary': {
          const meeting = libraryEdit.getGlossary(query.get('id'));
          return this._json(res, 200, { ok: true, ...meeting, glossaries: glossaries.setOf(meeting.text) });
        }
        case '/api/glossaries':
          return this._json(res, 200, { ok: true, glossaries: libraryService.projectGlossaries() });
        case '/api/corrections':
          return this._json(res, 200, { ok: true, ...libraryEdit.getCorrections(query.get('id') || '') });
        case '/api/models':
          return this._json(res, 200, { ok: true, models: this.api.models ? this.api.models() : [] });
        case '/api/queue':
          return this._json(res, 200, { ok: true, ...this._queue() });
        case '/api/settings':
          return this._json(res, 200, {
            ok: true,
            values: settingsSchema.visibleValues(this.api.settings ? this.api.settings() : {}),
            schema: settingsSchema.describe(),
            profileKeys: profiles.PROFILE_KEYS
          });
        case '/api/profiles':
          return this._json(res, 200, { ok: true, ...(this.api.profiles ? this.api.profiles() : { profiles: [] }) });
        case '/api/status':
          return this._json(res, 200, { ok: true, ...(this.api.status ? this.api.status() : {}) });
        default:
          return this._json(res, 404, { ok: false, error: 'Not found' });
      }
    } catch (error) {
      return this._json(res, 400, { ok: false, error: error.message });
    }
  }

  async _post(req, res, url) {
    const name = url.pathname.slice('/api/'.length);
    const action = ACTIONS[name] || this._jobActions()[name];
    if (!action) return this._json(res, 404, { ok: false, error: 'Not found' });
    let body;
    try {
      body = await this._readBody(req);
    } catch (error) {
      return this._json(res, 400, { ok: false, error: error.message });
    }
    try {
      const result = await action(body);
      this.broadcast('library', { reason: name });
      return this._json(res, 200, { ok: true, ...result });
    } catch (error) {
      logger.info('Manager action refused', { action: name, error: error.message });
      return this._json(res, 400, { ok: false, error: error.message });
    }
  }

  // ── Final passes ──

  /** The queue, with library ids for the folders inside the transcript folder. */
  _queue() {
    const status = this.api.queue ? this.api.queue() : { jobs: [] };
    const root = libraryService.root();
    const describe = (folder, overrides) => {
      let id = null;
      try {
        const rel = library.idOf(root, folder);
        if (!rel.startsWith('..')) id = rel;
      } catch (_) { /* outside the library */ }
      return { id, name: path.basename(folder), overrides: overrides || {} };
    };
    return {
      running: status.running && status.folder ? { ...describe(status.folder, status.overrides), pct: status.pct || 0 } : null,
      jobs: (status.jobs || []).map((job) => describe(job.folder, job.overrides))
    };
  }

  /** The queue's own path for a meeting, compared the way Windows compares paths. */
  _queuedFolder(id) {
    const dir = path.resolve(libraryService.meetingDir(id));
    const same = (folder) => folder && (process.platform === 'win32'
      ? path.resolve(folder).toLowerCase() === dir.toLowerCase()
      : path.resolve(folder) === dir);
    const status = this.api.queue ? this.api.queue() : { jobs: [] };
    if (status.running && same(status.folder)) return { folder: status.folder, running: true };
    const job = (status.jobs || []).find((entry) => same(entry.folder));
    return job ? { folder: job.folder, running: false } : null;
  }

  _jobActions() {
    const need = (name) => {
      if (!this.api[name]) throw new Error('Not available');
      return this.api[name];
    };
    return {
      rerun: (body) => {
        const overrides = {};
        for (const key of ['model', 'diffModel', 'language', 'mode', 'beamSize']) {
          if (body.overrides && body.overrides[key] !== undefined && body.overrides[key] !== null) overrides[key] = body.overrides[key];
        }
        const ids = Array.isArray(body.ids) ? body.ids : [];
        if (!ids.length) throw new Error('Pick a meeting');
        // null/undefined keeps each meeting's own glossary; a list (maybe
        // empty, "no glossary") rebuilds it from the project glossaries.
        const glossaryNames = Array.isArray(body.glossaries) ? body.glossaries : null;
        const dirs = ids.map((id) => {
          const dir = libraryService.meetingDir(id);
          if (!fs.existsSync(path.join(dir, 'audio', 'meta.json'))) throw new Error(`"${path.basename(dir)}" has no archived audio`);
          if (libraryService._stateOf(dir, libraryService._busy()) === 'recording') throw new Error('That meeting is still recording');
          return dir;
        });
        if (glossaryNames) for (const id of ids) libraryEdit.applyGlossaries(id, glossaryNames);
        for (const dir of dirs) need('rerun')(dir, overrides);
        return { queued: dirs.length };
      },
      'queue/cancel': (body) => {
        const found = this._queuedFolder(body.id);
        if (!found || !found.running) throw new Error('That pass is not running');
        need('cancelRunning')();
        return {};
      },
      'queue/remove': (body) => {
        const found = this._queuedFolder(body.id);
        if (!found || found.running || !need('dequeue')(found.folder)) throw new Error('That pass is not waiting in the queue');
        return {};
      },
      settings: (body) => {
        const { patch, errors } = settingsSchema.validatePatch(body.patch);
        if (errors.length) throw new Error(errors.join('; '));
        if (!Object.keys(patch).length) return {};
        return this._unwrap(need('saveSettings')(patch), () => ({}));
      },
      'profiles/select': (body) => this._unwrap(need('selectProfile')(String(body.id || '')), (result) => ({ active: result.active })),
      'profiles/reset': (body) => this._unwrap(need('resetProfile')(String(body.id || '')), () => ({})),
      'profiles/update': (body) => {
        // Same checks as a settings change, limited to what a profile holds.
        const values = {};
        for (const key of profiles.PROFILE_KEYS) if (body.values && body.values[key] !== undefined) values[key] = body.values[key];
        const { patch, errors } = settingsSchema.validatePatch(values);
        if (errors.length) throw new Error(errors.join('; '));
        const meta = {};
        if (body.label !== undefined) meta.label = String(body.label);
        if (body.flag !== undefined) meta.flag = String(body.flag);
        return this._unwrap(need('updateProfile')(String(body.id || ''), patch, meta), () => ({}));
      },
      'profiles/create': (body) => this._unwrap(need('createProfile')({
        label: String(body.label || ''),
        flag: String(body.flag || 'custom'),
        fromId: body.from ? String(body.from) : null,
        activate: body.activate === true
      }), (result) => ({ id: result.id })),
      'profiles/delete': (body) => this._unwrap(need('deleteProfile')(String(body.id || '')), () => ({})),
      'app/open': () => need('openApp')(),
      'app/library-only': () => this._unwrap(need('libraryOnly')(), () => ({})),
      'models/download': (body) => {
        const options = {};
        if (body.convert !== undefined) options.convert = body.convert === true;
        if (body.category === 'live' || body.category === 'final') options.category = body.category;
        return this._unwrap(need('downloadModel')(String(body.id || ''), options), () => ({}));
      },
      'models/delete': (body) => this._unwrap(need('deleteModel')(String(body.id || '')), (result) => ({ freed: result.freed || 0 })),
      'models/use': (body) => {
        const key = { live: 'whisperModel', final: 'offlineModel', diff: 'offlineDiffModel' }[body.role];
        if (!key) throw new Error('Pick live, final or cross-check');
        const { patch, errors } = settingsSchema.validatePatch({ [key]: body.id === null ? '' : body.id });
        if (errors.length) throw new Error(errors.join('; '));
        return this._unwrap(need('saveSettings')(patch), () => ({}));
      },
      'queue/move': (body) => {
        const found = this._queuedFolder(body.id);
        if (!found || found.running || !need('reorder')(found.folder, body.delta)) throw new Error('That pass is not waiting in the queue');
        return {};
      }
    };
  }

  /** Search Hugging Face through the app (the page itself may only talk to this server). */
  async _hub(res, url) {
    if (!this.api.searchModels) return this._json(res, 404, { ok: false, error: 'Not available' });
    try {
      const results = await this.api.searchModels(url.searchParams.get('q') || '');
      return this._json(res, 200, { ok: true, results });
    } catch (error) {
      return this._json(res, 502, { ok: false, error: error.message });
    }
  }

  /** main.js answers { ok: false, error } instead of throwing; turn that into a refusal. */
  _unwrap(result, pick) {
    if (result && result.ok === false) throw new Error(result.error || 'Refused');
    return pick(result || {});
  }

  /**
   * An audio file streamed straight to disk as a new meeting. Details come in
   * the query string because the body is the file itself.
   */
  async _import(req, res, url) {
    const query = url.searchParams;
    const size = Number(req.headers['content-length']);
    if (!Number.isFinite(size) || size <= 0) return this._json(res, 411, { ok: false, error: 'Empty upload' });
    if (size > MAX_IMPORT_BYTES) return this._json(res, 413, { ok: false, error: 'The file is larger than 4 GB' });

    let target;
    try {
      target = libraryEdit.beginImport({
        name: query.get('name'),
        startedAt: query.get('startedAt'),
        folder: query.get('folder'),
        ext: query.get('ext')
      });
    } catch (error) {
      req.resume();
      return this._json(res, 400, { ok: false, error: error.message });
    }

    const written = await new Promise((resolve) => {
      const out = fs.createWriteStream(target.file);
      let bytes = 0;
      const fail = (error) => {
        out.destroy();
        resolve({ ok: false, error: error.message || String(error) });
      };
      req.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > size) req.destroy(new Error('More data than announced'));
      });
      req.on('aborted', () => fail(new Error('The upload was interrupted')));
      req.on('error', fail);
      out.on('error', fail);
      out.on('finish', () => resolve(bytes === size ? { ok: true } : { ok: false, error: 'The upload was incomplete' }));
      req.pipe(out);
    });
    if (!written.ok) {
      libraryEdit.failImport(target.dir);
      if (!res.writableEnded && !res.destroyed) return this._json(res, 400, written);
      return undefined;
    }

    try {
      const result = libraryEdit.finishImport({
        dir: target.dir,
        file: target.file,
        name: query.get('name'),
        startedAt: query.get('startedAt'),
        durationMs: query.get('durationMs'),
        label: query.get('label')
      });
      if (query.get('transcribe') === '1' && this.api.rerun) this.api.rerun(target.dir, {});
      this.broadcast('library', { reason: 'import' });
      return this._json(res, 200, { ok: true, ...result });
    } catch (error) {
      libraryEdit.failImport(target.dir);
      return this._json(res, 400, { ok: false, error: error.message });
    }
  }

  _readBody(req) {
    if (!/^application\/json\b/.test(req.headers['content-type'] || '')) {
      return Promise.reject(new Error('Expected JSON'));
    }
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
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

  /** A transcript as a download (md, txt, srt, llm). */
  _export(res, url) {
    let file;
    try {
      file = libraryEdit.exportMeeting(url.searchParams.get('id'), url.searchParams.get('format'), url.searchParams.get('markup') === '1');
    } catch (error) {
      return this._json(res, 400, { ok: false, error: error.message });
    }
    // Plain-ASCII fallback for the quoted filename; filename* carries the real one.
    const ascii = file.filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
    res.writeHead(200, {
      'Content-Type': file.type,
      'Content-Disposition': `${url.searchParams.get('inline') === '1' ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`
    });
    res.end(file.body);
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
