const fs = require('fs');
const path = require('path');
const settingsStore = require('../core/settings.store');
const library = require('../core/library');
const { mediaType } = require('../core/manager-http');
const logger = require('../core/logger').createServiceLogger('LIBRARY');

// How deep below the transcript folder meetings are looked for.
const MAX_DEPTH = 3;
// A transcript bigger than this is not loaded into the search index.
const MAX_INDEXED_BYTES = 8 * 1024 * 1024;

/**
 * Reads the transcript folder for the browser manager: which meetings exist,
 * what each one contains, its timeline, and full-text search over all of them.
 *
 * A meeting is any folder holding transcript.txt, transcript.final.md or
 * audio/meta.json; every other folder is a grouping folder the user made.
 * Nothing here writes to disk.
 */
class LibraryService {
  constructor() {
    this.index = new Map(); // id -> { mtimeMs, size, text }
    // Injected by main.js: { recordingFolder, runningFolder, queuedFolders }.
    this.busyProvider = () => ({});
  }

  setBusyProvider(fn) {
    this.busyProvider = fn;
  }

  root() {
    return path.resolve(settingsStore.get('transcriptRoot'));
  }

  // ── Listing ──

  /** Every grouping folder and every meeting, newest meeting first. */
  list() {
    const root = this.root();
    const folders = [];
    const meetings = [];
    const busy = this._busy();

    const walk = (dir, depth) => {
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (error) {
        if (dir === root) logger.warn('Could not read the transcript folder', { error: error.message });
        return;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (this._isMeeting(full)) {
          meetings.push(this._summary(root, full, busy));
        } else if (depth < MAX_DEPTH) {
          folders.push({ id: library.idOf(root, full), name: entry.name, parent: library.idOf(root, dir) });
          walk(full, depth + 1);
        }
      }
    };
    walk(root, 1);

    meetings.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    return { root, folders, meetings };
  }

  _isMeeting(dir) {
    return ['transcript.txt', 'transcript.final.md', path.join('audio', 'meta.json')]
      .some((name) => fs.existsSync(path.join(dir, name)));
  }

  _busy() {
    try {
      const status = this.busyProvider() || {};
      const norm = (folder) => (folder ? path.resolve(folder) : null);
      return {
        recording: norm(status.recordingFolder),
        running: norm(status.runningFolder),
        queued: new Set((status.queuedFolders || []).map(norm))
      };
    } catch (_) {
      return { recording: null, running: null, queued: new Set() };
    }
  }

  _stateOf(dir, busy) {
    const full = path.resolve(dir);
    if (busy.recording === full) return 'recording';
    if (busy.running === full) return 'transcribing';
    if (busy.queued.has(full)) return 'queued';
    return null;
  }

  _readJson(file) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_) {
      return null;
    }
  }

  _summary(root, dir, busy) {
    const name = path.basename(dir);
    const parsed = library.parseFolderName(name);
    const meta = this._readJson(path.join(dir, 'audio', 'meta.json'));
    const info = this._readJson(path.join(dir, 'meeting.json')) || {};

    let files = [];
    try {
      files = fs.readdirSync(dir);
    } catch (_) { /* vanished */ }

    const startedAt = (meta && meta.startedAt) || (parsed && parsed.startedAt) || this._mtime(dir);
    let durationMs = null;
    if (meta) {
      const longest = (meta.streams || []).reduce((max, stream) => Math.max(max, Number(stream.durationMs) || 0), 0);
      durationMs = longest || (meta.stoppedAt && meta.startedAt ? meta.stoppedAt - meta.startedAt : null);
    }

    return {
      id: library.idOf(root, dir),
      name,
      parent: library.idOf(root, path.dirname(dir)),
      title: typeof info.title === 'string' ? info.title : '',
      tags: Array.isArray(info.tags) ? info.tags.filter((tag) => typeof tag === 'string') : [],
      prefix: parsed ? parsed.prefix : '',
      startedAt,
      durationMs,
      hasFinal: files.includes('transcript.final.json') || files.includes('transcript.final.md'),
      hasLive: files.includes('transcript.txt'),
      hasAudio: Boolean(meta && (meta.streams || []).length),
      screenshots: files.filter((file) => /\.(png|jpe?g)$/i.test(file)).length,
      bytes: this._size(dir),
      state: this._stateOf(dir, busy)
    };
  }

  _mtime(file) {
    try {
      return fs.statSync(file).mtimeMs;
    } catch (_) {
      return 0;
    }
  }

  _size(dir) {
    let total = 0;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return 0;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) total += this._size(full);
      else {
        try { total += fs.statSync(full).size; } catch (_) { /* vanished */ }
      }
    }
    return total;
  }

  // ── One meeting ──

  meetingDir(id) {
    const dir = library.resolveInside(this.root(), id);
    if (!id || !this._isMeeting(dir)) throw new Error('Meeting not found');
    return dir;
  }

  /** Everything the meeting view needs: summary, audio streams, timeline. */
  meeting(id) {
    const root = this.root();
    const dir = this.meetingDir(id);
    const summary = this._summary(root, dir, this._busy());
    const meta = this._readJson(path.join(dir, 'audio', 'meta.json'));
    const info = this._readJson(path.join(dir, 'meeting.json')) || {};

    const streams = [];
    for (const stream of (meta && meta.streams) || []) {
      const file = this._streamFile(dir, stream);
      if (!file) continue;
      streams.push({
        stream: stream.stream,
        label: stream.label || stream.stream,
        file,
        startedAt: Number(stream.startedAt) || meta.startedAt,
        durationMs: Number(stream.durationMs) || 0
      });
    }

    const timeline = this._timeline(dir, summary.startedAt);
    return {
      ...summary,
      notes: typeof info.notes === 'string' ? info.notes : '',
      participants: typeof info.participants === 'string' ? info.participants : '',
      stoppedAt: meta && meta.stoppedAt,
      streams,
      source: timeline.source,
      asr: timeline.asr,
      entries: timeline.entries
    };
  }

  /** The archived file for a stream: it may have moved, or become a FLAC since. */
  _streamFile(dir, stream) {
    const audioDir = path.join(dir, 'audio');
    const candidates = [`${stream.stream}.flac`, `${stream.stream}.wav`];
    if (stream.path) candidates.push(path.basename(String(stream.path)));
    const found = candidates.find((name) => mediaType(path.extname(name)) && fs.existsSync(path.join(audioDir, name)));
    return found ? 'audio/' + found : null;
  }

  _timeline(dir, startedAt) {
    const final = this._readJson(path.join(dir, 'transcript.final.json'));
    if (final && Array.isArray(final.entries)) {
      return {
        source: 'final',
        asr: final.asr || null,
        entries: final.entries.map((entry) => ({
          kind: entry.kind,
          label: entry.label,
          streamId: entry.streamId,
          startedAt: entry.startedAt,
          endedAt: entry.endedAt,
          clock: entry.clock,
          text: entry.text,
          marked: entry.marked || null,
          // [start s, end s, word, probability]: compact, the view only needs these.
          words: Array.isArray(entry.words)
            ? entry.words.map((word) => [word.start, word.end, word.word, word.probability])
            : []
        }))
      };
    }
    try {
      const text = fs.readFileSync(path.join(dir, 'transcript.txt'), 'utf8');
      return { source: 'live', asr: null, entries: library.parseLiveTranscript(text, startedAt) };
    } catch (_) {
      return { source: 'none', asr: null, entries: [] };
    }
  }

  /**
   * A media file inside one meeting folder (audio or a screenshot).
   * @returns {{ file: string, type: string, size: number }}
   */
  mediaFile(id, relative) {
    const dir = this.meetingDir(id);
    const file = library.resolveInside(dir, relative);
    const type = mediaType(path.extname(file));
    if (!type) throw new Error('Not a media file');
    const stat = fs.statSync(file);
    if (!stat.isFile()) throw new Error('Not a file');
    return { file, type, size: stat.size };
  }

  // ── Search ──

  search(query) {
    const terms = library.queryTerms(query);
    if (!terms.length) return { query, results: [] };
    const { root, meetings } = this.list();
    const results = [];
    for (const meeting of meetings) {
      const text = this._indexed(root, meeting);
      const found = library.searchText(text, terms);
      if (found) results.push({ id: meeting.id, hits: found.hits, snippets: found.snippets });
    }
    results.sort((a, b) => b.hits - a.hits);
    return { query, results };
  }

  _indexed(root, meeting) {
    const dir = library.resolveInside(root, meeting.id);
    const sources = ['transcript.final.md', 'transcript.txt', 'meeting.json'].map((name) => path.join(dir, name));
    const stamp = sources.map((file) => this._mtime(file)).join(':');
    const cached = this.index.get(meeting.id);
    if (cached && cached.stamp === stamp) return cached.text;

    const parts = [meeting.name];
    const finalPath = sources[0];
    const transcript = fs.existsSync(finalPath) ? finalPath : sources[1];
    try {
      if (fs.existsSync(transcript) && fs.statSync(transcript).size <= MAX_INDEXED_BYTES) {
        parts.push(library.stripMarkup(fs.readFileSync(transcript, 'utf8')));
      }
    } catch (_) { /* unreadable: index what we have */ }
    const info = this._readJson(sources[2]);
    if (info) parts.push(info.title || '', info.notes || '', info.participants || '', (info.tags || []).join(' '));

    const text = parts.join('\n');
    this.index.set(meeting.id, { stamp, text });
    return text;
  }
}

module.exports = new LibraryService();
