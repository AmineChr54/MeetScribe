/**
 * Project glossaries: named term lists ("one per project") that a meeting or a
 * profile can combine. Pure: storage is in library-edit.service.js, which keeps
 * each one as <transcriptRoot>/.glossaries/<name>.txt so it can also be edited
 * by hand.
 *
 * A meeting's glossary.txt built from project glossaries starts with a
 * "#@ glossaries:" line naming them, so the pickers can show which ones it was
 * made from. Like every "#" line it never reaches the model.
 */

const MAX_NAME = 60;
const SET_LINE = /^#@[ \t]*glossaries:[ \t]*(.*)$/m;
// Hidden from the library's folder list (it skips dot folders).
const DIR_NAME = '.glossaries';

/** The notes every meeting's glossary.txt starts with. */
const MEETING_HEADER = [
  '# Glossary for this meeting: names, products, file names, jargon.',
  '# One term per line, or several separated by commas.',
  '# Lines starting with "#" are notes and are ignored.',
  '# A line starting with ">" is prose context handed to the model, e.g.',
  '#   > A meeting about the Acme migration.',
  '# Edit this file and re-run the final pass to re-transcribe with it.',
  ''
].join('\n');

/** A meeting's glossary.txt: the notes, then the glossary itself. */
function meetingFile(body) {
  return MEETING_HEADER + String(body || '').trim() + '\n';
}

/** A name that is safe as a Windows file name, or '' when nothing usable is left. */
function cleanName(value) {
  return String(value || '')
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, MAX_NAME);
}

/** A list of names from settings or a request, cleaned, without duplicates. */
function cleanSet(value) {
  const list = Array.isArray(value) ? value : [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const name = cleanName(raw);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(name);
  }
  return out;
}

/** How many terms a glossary text holds ("#" notes and ">" context excluded). */
function countTerms(text) {
  let count = 0;
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('>')) continue;
    count += trimmed.split(',').filter((term) => term.trim()).length;
  }
  return count;
}

/**
 * The text of a meeting glossary built from project glossaries.
 * @param {{ name: string, text: string }[]} chosen  in the order picked
 * @param {string} extra  free text added after them (may be empty)
 * @returns {string} '' when there is nothing at all
 */
function compose(chosen, extra = '') {
  const parts = [];
  const names = [];
  for (const glossary of chosen || []) {
    const text = String(glossary.text || '').trim();
    names.push(glossary.name);
    if (text) parts.push(`# ── ${glossary.name} ──\n${text}`);
  }
  const free = String(extra || '').trim();
  if (free) parts.push(names.length ? `# ── Other terms ──\n${free}` : free);
  if (!names.length) return parts.join('\n\n');
  return `#@ glossaries: ${names.join(', ')}\n` + parts.join('\n\n');
}

/** The project glossaries a meeting glossary was built from, from its "#@" line. */
function setOf(text) {
  const match = SET_LINE.exec(String(text || ''));
  if (!match) return [];
  return cleanSet(match[1].split(','));
}

/**
 * The glossary.txt for a meeting that should use no glossary at all. It must
 * not be empty: the final pass falls back to the settings' glossary then.
 */
function emptyGlossary() {
  return meetingFile('#@ glossaries:\n# No glossary for this meeting.');
}

module.exports = { MAX_NAME, DIR_NAME, MEETING_HEADER, meetingFile, cleanName, cleanSet, countTerms, compose, setOf, emptyGlossary };
