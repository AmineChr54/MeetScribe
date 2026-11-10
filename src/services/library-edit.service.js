const fs = require('fs');
const path = require('path');
const settingsStore = require('../core/settings.store');
const library = require('../core/library');
const transcriptEdit = require('../core/transcript-edit');
const transcriptRender = require('../core/transcript-render');
const corrections = require('./corrections');
const libraryService = require('./library.service');
const logger = require('../core/logger').createServiceLogger('LIBRARY-EDIT');

const MAX_GLOSSARY_BYTES = 64 * 1024;

/**
 * Every change the browser manager makes on disk: meeting details, renaming
 * and moving folders, the Recycle Bin, transcript edits, glossary and
 * corrections. Reading stays in library.service.js.
 *
 * A meeting that is recording, queued or being transcribed is never touched:
 * the recorder and the final pass hold its paths and would write to the old
 * place, or overwrite the edit.
 */
class LibraryEditService {
  constructor() {
    // Injected by main.js: Electron's shell.trashItem, so deletes are recoverable.
    this.trashItem = null;
  }

  setTrash(fn) {
    this.trashItem = fn;
  }

  // ── Guards and file helpers ──

  _assertIdle(dir) {
    const busy = libraryService._busy();
    const state = libraryService._stateOf(dir, busy);
    if (state) throw new Error(`This meeting is ${state}; try again when it has finished`);
  }

  /** No meeting inside this folder may be busy. */
  _assertFolderIdle(dir) {
    const busy = libraryService._busy();
    const inside = (folder) => folder && (folder === dir || folder.startsWith(dir + path.sep));
    const base = path.resolve(dir);
    if (inside(busy.recording) || inside(busy.running) || [...busy.queued].some(inside)) {
      throw new Error('A meeting in this folder is recording or being transcribed');
    }
    return base;
  }

  /** Temp file + rename, so a crash never leaves half a file. */
  _writeAtomic(file, content) {
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, content, 'utf8');
    try {
      this._retry(() => fs.renameSync(tmp, file));
    } catch (error) {
      fs.rmSync(tmp, { force: true });
      throw error;
    }
  }

  /** OneDrive and virus scanners briefly lock files and folders; one retry clears it. */
  _retry(operation) {
    try {
      return operation();
    } catch (error) {
      if (!['EBUSY', 'EPERM', 'EACCES'].includes(error.code)) throw error;
      // A synchronous 300 ms pause without spinning the CPU.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
      return operation();
    }
  }

  _readJson(file, fallback) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_) {
      return fallback;
    }
  }

  _rename(from, to) {
    if (fs.existsSync(to)) throw new Error(`"${path.basename(to)}" already exists there`);
    try {
      this._retry(() => fs.renameSync(from, to));
    } catch (error) {
      if (error.code === 'EPERM' || error.code === 'EBUSY') {
        throw new Error('Windows is holding a file in that folder open (Explorer, OneDrive, a player); close it and try again');
      }
      throw error;
    }
    libraryService.index.clear();
  }

  // ── Meeting details ──

  saveInfo(id, info = {}) {
    const dir = libraryService.meetingDir(id);
    const file = path.join(dir, 'meeting.json');
    const current = this._readJson(file, {});
    const next = { ...current };
    if (info.title !== undefined) next.title = String(info.title).trim().slice(0, 200);
    if (info.notes !== undefined) next.notes = String(info.notes).slice(0, 100000);
    if (info.participants !== undefined) next.participants = String(info.participants).trim().slice(0, 2000);
    if (info.tags !== undefined) next.tags = library.cleanTags(info.tags);
    this._writeAtomic(file, JSON.stringify(next, null, 2));
    return { id };
  }

  /** Bulk: add or remove one tag on several meetings. */
  tag(ids, tag, remove = false) {
    const [clean] = library.cleanTags([tag]);
    if (!clean) throw new Error('Type a tag');
    for (const id of ids || []) {
      const dir = libraryService.meetingDir(id);
      const current = this._readJson(path.join(dir, 'meeting.json'), {});
      const tags = (current.tags || []).filter((existing) => existing.toLowerCase() !== clean.toLowerCase());
      if (!remove) tags.push(clean);
      this.saveInfo(id, { tags });
    }
    return { count: (ids || []).length };
  }

  // ── Folders on disk ──

  /** Rename keeps the date-time stamp: "<name>_YYYY-MM-DD_HH-MM". */
  renameMeeting(id, name) {
    const dir = libraryService.meetingDir(id);
    this._assertIdle(dir);
    const summary = libraryService._summary(libraryService.root(), dir, libraryService._busy());
    const folderName = library.renamedFolder(name, path.basename(dir), summary.startedAt);
    if (folderName === path.basename(dir)) return { id };
    const to = path.join(path.dirname(dir), folderName);
    this._rename(dir, to);
    logger.info('Meeting renamed');
    return { id: library.idOf(libraryService.root(), to) };
  }

  /** Move meetings into a folder ('' = the transcript folder itself). */
  move(ids, folderId) {
    const root = libraryService.root();
    const destination = library.resolveInside(root, folderId || '');
    if (!fs.existsSync(destination) || !fs.statSync(destination).isDirectory()) throw new Error('That folder does not exist');
    const moved = [];
    for (const id of ids || []) {
      const dir = libraryService.meetingDir(id);
      this._assertIdle(dir);
      if (path.dirname(dir) === destination) continue;
      const to = path.join(destination, path.basename(dir));
      this._rename(dir, to);
      moved.push(library.idOf(root, to));
    }
    return { ids: moved };
  }

  createFolder(parentId, name) {
    const root = libraryService.root();
    const parent = library.resolveInside(root, parentId || '');
    const clean = library.cleanName(name, 60);
    if (!clean) throw new Error('Type a folder name');
    if (library.parseFolderName(clean)) throw new Error('That name looks like a meeting; pick another');
    const dir = path.join(parent, clean);
    if (fs.existsSync(dir)) throw new Error('A folder with that name already exists');
    fs.mkdirSync(dir, { recursive: true });
    return { id: library.idOf(root, dir) };
  }

  renameFolder(id, name) {
    const root = libraryService.root();
    if (!id) throw new Error('Pick a folder');
    const dir = library.resolveInside(root, id);
    if (!fs.existsSync(dir) || libraryService._isMeeting(dir)) throw new Error('Folder not found');
    this._assertFolderIdle(dir);
    const clean = library.cleanName(name, 60);
    if (!clean) throw new Error('Type a folder name');
    const to = path.join(path.dirname(dir), clean);
    if (to === dir) return { id };
    this._rename(dir, to);
    return { id: library.idOf(root, to) };
  }

  /** Only empty folders: meetings are moved or deleted on purpose, never as a side effect. */
  deleteFolder(id) {
    const root = libraryService.root();
    if (!id) throw new Error('Pick a folder');
    const dir = library.resolveInside(root, id);
    if (!fs.existsSync(dir) || libraryService._isMeeting(dir)) throw new Error('Folder not found');
    const left = fs.readdirSync(dir).filter((name) => !/^(desktop\.ini|thumbs\.db)$/i.test(name));
    if (left.length) throw new Error('The folder is not empty; move its meetings out first');
    fs.rmSync(dir, { recursive: true, force: true });
    return { ok: true };
  }

  // ── Recycle Bin ──

  /**
   * Move meetings, or only their audio, to the Recycle Bin.
   * @param {'all'|'audio'} what
   */
  async trash(ids, what = 'all') {
    if (!this.trashItem) throw new Error('Deleting is not available');
    let freed = 0;
    for (const id of ids || []) {
      const dir = libraryService.meetingDir(id);
      this._assertIdle(dir);
      const target = what === 'audio' ? path.join(dir, 'audio') : dir;
      if (!fs.existsSync(target)) continue;
      freed += libraryService._size(target);
      await this.trashItem(target);
    }
    libraryService.index.clear();
    logger.info('Moved to the Recycle Bin', { count: (ids || []).length, what });
    return { freed };
  }

  // ── Transcript ──

  editTranscript(id, op) {
    const dir = libraryService.meetingDir(id);
    this._assertIdle(dir);
    const finalJson = path.join(dir, 'transcript.final.json');

    if (fs.existsSync(finalJson)) {
      const doc = JSON.parse(fs.readFileSync(finalJson, 'utf8'));
      const next = transcriptEdit.applyFinalEdit(doc, op);
      const markdown = transcriptRender.buildMarkdown(transcriptRender.fromFinalJson(next));
      this._writeAtomic(finalJson, JSON.stringify(next, null, 2));
      this._writeAtomic(path.join(dir, 'transcript.final.md'), markdown);
      if (op.op === 'marker-add' || op.op === 'marker-delete') this._writeEvents(dir, transcriptEdit.eventsOf(next.entries));
      return { source: 'final' };
    }

    const live = path.join(dir, 'transcript.txt');
    if (!fs.existsSync(live)) throw new Error('This meeting has no transcript to edit');
    const summary = libraryService._summary(libraryService.root(), dir, libraryService._busy());
    const text = fs.readFileSync(live, 'utf8');
    const next = transcriptEdit.applyLiveEdit(text, summary.startedAt, op);
    this._writeAtomic(live, next);
    if (op.op === 'marker-add' || op.op === 'marker-delete') {
      this._writeEvents(dir, transcriptEdit.eventsOf(library.parseLiveTranscript(next, summary.startedAt)));
    }
    return { source: 'live' };
  }

  /** events.json feeds markers back into a later re-run of the final pass. */
  _writeEvents(dir, events) {
    this._writeAtomic(path.join(dir, 'events.json'), JSON.stringify(events, null, 2));
  }

  // ── Glossary and corrections ──

  _glossaryFile(id) {
    return path.join(libraryService.meetingDir(id), 'glossary.txt');
  }

  getGlossary(id) {
    const file = this._glossaryFile(id);
    return { text: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '' };
  }

  saveGlossary(id, text) {
    const value = String(text || '');
    if (Buffer.byteLength(value) > MAX_GLOSSARY_BYTES) throw new Error('The glossary is too long');
    this._writeAtomic(this._glossaryFile(id), value.replace(/\r?\n/g, '\r\n'));
    return { ok: true };
  }

  _correctionsFile(id) {
    return id
      ? path.join(libraryService.meetingDir(id), corrections.FILE_NAME)
      : settingsStore.userDataFile(corrections.FILE_NAME);
  }

  /** As a list of { from, to }. id '' = the global list every new meeting starts with. */
  getCorrections(id) {
    const data = this._readJson(this._correctionsFile(id), {});
    return { rules: corrections.normalizeRules(data) };
  }

  saveCorrections(id, rules) {
    const data = {};
    for (const rule of rules || []) {
      const from = String((rule && rule.from) || '').trim().slice(0, 200);
      const to = String((rule && rule.to) || '').trim().slice(0, 200);
      if (from && to) data[from] = to;
    }
    if (Object.keys(data).length > 500) throw new Error('Keep it under 500 corrections');
    this._writeAtomic(this._correctionsFile(id), JSON.stringify(data, null, 2) + '\n');
    return { rules: corrections.normalizeRules(data) };
  }

  // ── Export ──

  /** @returns {{ filename: string, type: string, body: string }} */
  exportMeeting(id, format, markup) {
    const meeting = libraryService.meeting(id);
    const dir = libraryService.meetingDir(id);
    const base = library.cleanName(meeting.title, 60) || meeting.name;
    const entries = meeting.entries;
    switch (format) {
      case 'md': {
        const file = path.join(dir, 'transcript.final.md');
        const body = fs.existsSync(file)
          ? fs.readFileSync(file, 'utf8')
          : `# ${meeting.title || meeting.name}\n\n` + library.toPlainText(entries, { markup });
        return { filename: `${base}.md`, type: 'text/markdown; charset=utf-8', body };
      }
      case 'srt': {
        const start = meeting.streams.length ? Math.min(...meeting.streams.map((stream) => stream.startedAt)) : meeting.startedAt;
        return { filename: `${base}.srt`, type: 'application/x-subrip; charset=utf-8', body: library.toSrt(entries, start) };
      }
      case 'llm':
        return { filename: `${base}.txt`, type: 'text/plain; charset=utf-8', body: library.toLlmText(meeting, entries, { markup }) };
      default:
        return { filename: `${base}.txt`, type: 'text/plain; charset=utf-8', body: library.toPlainText(entries, { markup }) };
    }
  }
}

module.exports = new LibraryEditService();
