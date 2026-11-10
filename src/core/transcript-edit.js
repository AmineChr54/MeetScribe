/**
 * Edits from the browser manager, applied to a transcript held in memory. Pure:
 * the caller reads the file, applies one operation, and writes the result.
 *
 * Every operation names its line by index *and* start time; if the two no
 * longer agree, the file changed since the page loaded it (a re-run, another
 * tab) and the edit is refused rather than applied to the wrong line.
 *
 * Operations:
 *   { op: 'text',          index, startedAt, text }
 *   { op: 'label',         index, startedAt, label }
 *   { op: 'delete',        index, startedAt }
 *   { op: 'merge',         index, startedAt }        line + the next spoken line
 *   { op: 'marker-add',    startedAt, text }
 *   { op: 'marker-delete', index, startedAt }
 */

const { parseLiveTranscript } = require('./library');

const pad = (value) => String(value).padStart(2, '0');
const clockOf = (ms) => {
  const date = new Date(ms);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

function cleanText(value, max = 5000) {
  const text = String(value || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (text.length > max) throw new Error('Text is too long');
  return text;
}

function cleanLabel(value) {
  const label = cleanText(value, 40).replace(/:/g, '');
  if (!label) throw new Error('A speaker label cannot be empty');
  return label;
}

function target(entries, op, kinds) {
  const entry = entries[op.index];
  if (!entry || Number(entry.startedAt) !== Number(op.startedAt)) {
    throw new Error('The transcript changed since it was loaded; reload the meeting');
  }
  if (kinds && !kinds.includes(entry.kind)) throw new Error('That line cannot be edited this way');
  return entry;
}

function nextSpeech(entries, index) {
  for (let i = index + 1; i < entries.length; i++) {
    if (entries[i].kind === 'speech') return i;
  }
  return -1;
}

/** Apply one operation to a parsed transcript.final.json; returns a new object. */
function applyFinalEdit(doc, op) {
  const next = JSON.parse(JSON.stringify(doc));
  const entries = next.entries || (next.entries = []);
  const forget = (startedAt) => {
    next.uncertain = (next.uncertain || []).filter((item) => item.startedAt !== startedAt);
  };

  switch (op && op.op) {
    case 'text': {
      const entry = target(entries, op, ['speech']);
      const text = cleanText(op.text);
      if (!text) throw new Error('Delete the line instead of emptying it');
      // The word timings and confidence belonged to the old words.
      entry.text = text;
      entry.marked = text;
      entry.words = [];
      delete entry.avgLogprob;
      forget(entry.startedAt);
      break;
    }
    case 'label':
      target(entries, op, ['speech']).label = cleanLabel(op.label);
      break;
    case 'delete': {
      const entry = target(entries, op, ['speech']);
      entries.splice(op.index, 1);
      forget(entry.startedAt);
      break;
    }
    case 'merge': {
      const entry = target(entries, op, ['speech']);
      const other = nextSpeech(entries, op.index);
      if (other < 0) throw new Error('There is no next line to merge with');
      const second = entries[other];
      entry.text = `${entry.text} ${second.text}`.trim();
      entry.marked = `${entry.marked || entry.text} ${second.marked || second.text}`.trim();
      entry.endedAt = Math.max(entry.endedAt || 0, second.endedAt || 0);
      entry.words = [...(entry.words || []), ...(second.words || [])];
      entries.splice(other, 1);
      break;
    }
    case 'marker-add': {
      const startedAt = Math.round(Number(op.startedAt));
      if (!Number.isFinite(startedAt)) throw new Error('A marker needs a time');
      const marker = { kind: 'marker', startedAt, endedAt: startedAt, clock: clockOf(startedAt), text: cleanText(op.text, 200), marked: null };
      let at = entries.findIndex((entry) => entry.startedAt > startedAt);
      if (at < 0) at = entries.length;
      entries.splice(at, 0, marker);
      break;
    }
    case 'marker-delete':
      target(entries, op, ['marker']);
      entries.splice(op.index, 1);
      break;
    default:
      throw new Error('Unknown edit');
  }
  return next;
}

/** Screenshots and markers, as events.json stores them for later re-runs. */
function eventsOf(entries) {
  return (entries || [])
    .filter((entry) => entry.kind === 'screenshot' || entry.kind === 'marker')
    .map((entry) => ({ kind: entry.kind, text: entry.text || '', startedAt: entry.startedAt }));
}

const formatLive = (entry) => {
  const stamp = `[${clockOf(entry.startedAt)}]`;
  if (entry.kind === 'marker') return entry.text ? `${stamp} --- mark: ${entry.text} ---` : `${stamp} --- mark ---`;
  if (entry.kind === 'screenshot') return `${stamp} --- screenshot: ${entry.text} ---`;
  return `${stamp} ${entry.label}: ${entry.text}`;
};

/**
 * Apply one operation to a live transcript.txt; returns the new file text.
 * Header and footer comment lines are kept as they are.
 * @param {number} dayStart  the meeting's start, to date the clock times
 */
function applyLiveEdit(text, dayStart, op) {
  const newline = /\r\n/.test(text) ? '\r\n' : '\n';
  const lines = String(text || '').split(/\r?\n/);
  const entries = parseLiveTranscript(text, dayStart);

  switch (op && op.op) {
    case 'text': {
      const entry = target(entries, op, ['speech']);
      const value = cleanText(op.text);
      if (!value) throw new Error('Delete the line instead of emptying it');
      lines[entry.line] = formatLive({ ...entry, text: value });
      break;
    }
    case 'label': {
      const entry = target(entries, op, ['speech']);
      lines[entry.line] = formatLive({ ...entry, label: cleanLabel(op.label) });
      break;
    }
    case 'delete':
      lines.splice(target(entries, op, ['speech']).line, 1);
      break;
    case 'merge': {
      const entry = target(entries, op, ['speech']);
      const other = nextSpeech(entries, op.index);
      if (other < 0) throw new Error('There is no next line to merge with');
      lines[entry.line] = formatLive({ ...entry, text: `${entry.text} ${entries[other].text}`.trim() });
      lines.splice(entries[other].line, 1);
      break;
    }
    case 'marker-add': {
      const startedAt = Math.round(Number(op.startedAt));
      if (!Number.isFinite(startedAt)) throw new Error('A marker needs a time');
      const line = formatLive({ kind: 'marker', startedAt, text: cleanText(op.text, 200) });
      const before = entries.filter((entry) => entry.startedAt <= startedAt).pop();
      const first = entries[0];
      const at = before ? before.line + 1 : first ? first.line : lines.length;
      lines.splice(at, 0, line);
      break;
    }
    case 'marker-delete':
      lines.splice(target(entries, op, ['marker']).line, 1);
      break;
    default:
      throw new Error('Unknown edit');
  }
  return lines.join(newline);
}

module.exports = { applyFinalEdit, applyLiveEdit, eventsOf };
