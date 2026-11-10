/**
 * Pure helpers for the meeting library (the browser manager). No Electron, no
 * disk: everything here takes strings and returns plain data, so it is tested
 * with synthetic text in tests/library.test.js.
 */

const path = require('path');

const pad = (value) => String(value).padStart(2, '0');

// "<prefix>_YYYY-MM-DD_HH-MM" or "YYYY-MM-DD_HH-MM", with an optional "-2"
// suffix when two meetings started in the same minute (meeting.service.js).
const FOLDER_PATTERN = /^(?:(.*)_)?(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})(?:-(\d+))?$/;

/**
 * @returns {{ prefix: string, stamp: string, startedAt: number, suffix: number|null }|null}
 *   startedAt is local time, like the stamp it was written from.
 */
function parseFolderName(name) {
  const match = FOLDER_PATTERN.exec(String(name || ''));
  if (!match) return null;
  const [, prefix, year, month, day, hour, minute, suffix] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));
  if (Number.isNaN(date.getTime()) || date.getMonth() !== Number(month) - 1) return null;
  return {
    prefix: prefix || '',
    stamp: `${year}-${month}-${day}_${hour}-${minute}`,
    startedAt: date.getTime(),
    suffix: suffix ? Number(suffix) : null
  };
}

/** The date-time stamp for a meeting folder, as meeting.service.js writes it. */
function stampOf(ms) {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}`;
}

/**
 * Resolve a library-relative id ("Folder/2026-01-02_10-30") to an absolute
 * path that is guaranteed to stay inside `root`. Throws on anything that would
 * escape it: "..", absolute paths, drive letters, NUL bytes.
 */
function resolveInside(root, relative = '') {
  const value = String(relative || '');
  if (value.includes('\0')) throw new Error('Invalid path');
  if (path.isAbsolute(value) || /^[a-zA-Z]:/.test(value) || value.startsWith('\\\\')) throw new Error('Invalid path');
  const base = path.resolve(root);
  const target = path.resolve(base, value);
  const rel = path.relative(base, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Path is outside the transcript folder');
  return target;
}

/** The id the manager uses for an absolute path: relative, forward slashes. */
function idOf(root, absolute) {
  return path.relative(path.resolve(root), path.resolve(absolute)).split(path.sep).join('/');
}

const LINE_PATTERN = /^\[(\d{2}):(\d{2}):(\d{2})\]\s+(.*)$/;

/**
 * Parse the live transcript.txt into timeline entries.
 *
 * Lines carry only a clock time, so the date comes from `dayStart` (the
 * meeting's start); a clock that jumps backwards by hours means midnight passed.
 * @param {string} text
 * @param {number} dayStart  ms timestamp on the meeting's first day
 */
function parseLiveTranscript(text, dayStart) {
  const start = new Date(dayStart);
  const midnight = new Date(start.getFullYear(), start.getMonth(), start.getDate()).getTime();
  const entries = [];
  let dayOffset = 0;
  let lastClockMs = null;

  const lines = String(text || '').split(/\r?\n/);
  for (let line = 0; line < lines.length; line++) {
    const match = LINE_PATTERN.exec(lines[line].trim());
    if (!match) continue;
    const [, hh, mm, ss, rest] = match;
    const clockMs = ((Number(hh) * 60 + Number(mm)) * 60 + Number(ss)) * 1000;
    if (lastClockMs !== null && clockMs < lastClockMs - 6 * 3600 * 1000) dayOffset += 86400000;
    lastClockMs = clockMs;
    const startedAt = midnight + dayOffset + clockMs;
    const clock = `${hh}:${mm}:${ss}`;

    const event = /^---\s+(screenshot|mark)(?::\s*(.*?))?\s+---$/.exec(rest);
    if (event) {
      entries.push({ kind: event[1] === 'mark' ? 'marker' : 'screenshot', startedAt, endedAt: startedAt, clock, text: event[2] || '', line });
      continue;
    }
    const colon = rest.indexOf(': ');
    if (colon <= 0) continue;
    entries.push({ kind: 'speech', startedAt, endedAt: null, clock, label: rest.slice(0, colon), text: rest.slice(colon + 2), line });
  }

  // A live line has no end time: it lasts until the next line, at most 12 s
  // (the VAD's utterance cap).
  const speech = entries.filter((entry) => entry.kind === 'speech');
  speech.forEach((entry, index) => {
    const next = speech[index + 1];
    entry.endedAt = Math.min(entry.startedAt + 12000, next ? Math.max(entry.startedAt + 1000, next.startedAt) : entry.startedAt + 4000);
  });
  return entries;
}

/** Markup the final pass leaves in `marked` text, removed for plain reading. */
function stripMarkup(text) {
  return String(text || '')
    .replace(/<([^|<>]*)\|[^<>]*>/g, '$1')
    .replace(/~([^~]+)~/g, '$1')
    .replace(/\{([^{}]+)\}/g, '$1');
}

/** Lower-case words of a search query; quotes keep a phrase together. */
function queryTerms(query) {
  const terms = [];
  const pattern = /"([^"]+)"|(\S+)/g;
  let match;
  while ((match = pattern.exec(String(query || '')))) {
    const term = (match[1] || match[2]).trim().toLowerCase();
    if (term) terms.push(term);
  }
  return terms;
}

/**
 * Does `text` contain every term? Returns null when not, otherwise the number
 * of hits and up to `limit` snippets around the first hits.
 */
function searchText(text, terms, { limit = 3, radius = 60 } = {}) {
  if (!terms.length) return null;
  const haystack = String(text || '');
  const lower = haystack.toLowerCase();
  if (!terms.every((term) => lower.includes(term))) return null;

  let hits = 0;
  const positions = [];
  for (const term of terms) {
    let index = lower.indexOf(term);
    while (index !== -1) {
      hits++;
      positions.push(index);
      index = lower.indexOf(term, index + term.length);
    }
  }
  positions.sort((a, b) => a - b);

  const snippets = [];
  let coveredUntil = -1;
  for (const position of positions) {
    if (snippets.length >= limit) break;
    if (position < coveredUntil) continue;
    const from = Math.max(0, position - radius);
    const to = Math.min(haystack.length, position + radius);
    coveredUntil = to;
    snippets.push((from > 0 ? '…' : '') + haystack.slice(from, to).replace(/\s+/g, ' ').trim() + (to < haystack.length ? '…' : ''));
  }
  return { hits, snippets };
}

// ── Names ──

/**
 * The folder name for a renamed meeting: the user's name, then the meeting's
 * original date-time stamp, so folders keep sorting by date in Explorer.
 * Characters Windows refuses in a folder name are dropped.
 */
function renamedFolder(name, currentFolderName, startedAt) {
  const clean = cleanName(name);
  const parsed = parseFolderName(currentFolderName);
  const stamp = parsed ? parsed.stamp : stampOf(startedAt);
  return clean ? `${clean}_${stamp}` : stamp;
}

/** A name that is safe as a Windows folder name, or '' when nothing usable is left. */
function cleanName(value, max = 80) {
  return String(value || '')
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, max)
    .replace(/[.\s]+$/g, '');
}

/** Tags as typed ("#acme, Review") to a clean, unique list. */
function cleanTags(tags) {
  const list = Array.isArray(tags) ? tags : String(tags || '').split(/[,\n]/);
  const out = [];
  for (const tag of list) {
    const clean = String(tag).trim().replace(/^#+/, '').replace(/\s+/g, '-').slice(0, 40);
    if (clean && !out.some((existing) => existing.toLowerCase() === clean.toLowerCase())) out.push(clean);
    if (out.length >= 20) break;
  }
  return out;
}

// ── Export ──

const clockText = (ms) => {
  const date = new Date(ms);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

function entryText(entry, markup) {
  const text = entry.marked && markup ? entry.marked : entry.text;
  return markup ? String(text || '') : stripMarkup(text);
}

/** "[HH:MM:SS] Label: text", one line per spoken line; screenshots and markers inline. */
function toPlainText(entries, { markup = false } = {}) {
  const lines = [];
  for (const entry of entries || []) {
    const stamp = `[${entry.clock || clockText(entry.startedAt)}]`;
    if (entry.kind === 'speech') lines.push(`${stamp} ${entry.label}: ${entryText(entry, markup)}`);
    else if (entry.kind === 'marker') lines.push(`${stamp} --- mark${entry.text ? ': ' + entry.text : ''} ---`);
    else if (entry.kind === 'screenshot') lines.push(`${stamp} --- screenshot: ${entry.text} ---`);
  }
  return lines.join('\n') + '\n';
}

const srtTime = (ms) => {
  const value = Math.max(0, Math.round(ms));
  const h = Math.floor(value / 3600000);
  const m = Math.floor((value % 3600000) / 60000);
  const s = Math.floor((value % 60000) / 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)},${String(value % 1000).padStart(3, '0')}`;
};

/** SubRip subtitles, timed from `base` (the start of the audio). */
function toSrt(entries, base) {
  const out = [];
  let index = 0;
  for (const entry of entries || []) {
    if (entry.kind !== 'speech') continue;
    const start = entry.startedAt - base;
    const end = Math.max(start + 500, (entry.endedAt || entry.startedAt + 2000) - base);
    out.push(String(++index), `${srtTime(start)} --> ${srtTime(end)}`, `${entry.label}: ${stripMarkup(entry.text)}`, '');
  }
  return out.join('\n');
}

/** A short header that tells an LLM what it is reading, then the plain transcript. */
function toLlmText(meeting, entries, { markup = false } = {}) {
  const speakers = [...new Set((entries || []).filter((entry) => entry.kind === 'speech').map((entry) => entry.label))];
  const head = [
    `Meeting: ${meeting.title || meeting.name}`,
    `Date: ${new Date(meeting.startedAt).toISOString().slice(0, 16).replace('T', ' ')}`,
    speakers.length ? `Speakers: ${speakers.join(', ')}` : '',
    meeting.participants ? `Participants: ${meeting.participants}` : '',
    markup ? 'Markup: ~word~ = the speech model was unsure, <a|b> = two models disagreed, {word} = auto-corrected.' : ''
  ].filter(Boolean);
  return head.join('\n') + '\n\n' + toPlainText(entries, { markup });
}

module.exports = {
  renamedFolder,
  cleanName,
  cleanTags,
  toPlainText,
  toSrt,
  toLlmText,
  parseFolderName,
  stampOf,
  resolveInside,
  idOf,
  parseLiveTranscript,
  stripMarkup,
  queryTerms,
  searchText
};
