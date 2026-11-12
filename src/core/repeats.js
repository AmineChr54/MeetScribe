/**
 * Repetition loops: Whisper sometimes decodes one word or a short phrase over
 * and over ("so, so, so, so, …"), and the real sentence under it is lost. The
 * final pass decodes looped segments again (whisper_offline.py, redo_loops);
 * this is the safety net for whatever still gets through, applied when the
 * transcript is rendered. Pure.
 */

// A phrase of up to MAX_PHRASE words repeated MIN_REPEATS times or more in a
// row is a loop and keeps only its first occurrence. Three in a row ("no, no,
// no") is still something people say.
const MIN_REPEATS = 4;
const MAX_PHRASE = 3;

const keyOf = (token) => String(token || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

function sameAt(keys, a, b, size) {
  if (b + size > keys.length) return false;
  for (let k = 0; k < size; k++) {
    if (!keys[a + k] || keys[a + k] !== keys[b + k]) return false;
  }
  return true;
}

/** The indices of the tokens to keep, in order. */
function keepIndices(tokens) {
  const keys = tokens.map(keyOf);
  const keep = [];
  let i = 0;
  while (i < keys.length) {
    let jump = 0;
    for (let size = 1; size <= MAX_PHRASE && !jump; size++) {
      let repeats = 1;
      while (sameAt(keys, i, i + repeats * size, size)) repeats++;
      if (repeats >= MIN_REPEATS) {
        for (let k = i; k < i + size; k++) keep.push(k);
        jump = repeats * size;
      }
    }
    if (jump) {
      i += jump;
    } else {
      keep.push(i);
      i++;
    }
  }
  return keep;
}

/** Word objects ({ word }) with loops collapsed. Returns the same array when nothing changed. */
function collapseWords(words) {
  const list = Array.isArray(words) ? words : [];
  const keep = keepIndices(list.map((word) => word && word.word));
  return keep.length === list.length ? list : keep.map((index) => list[index]);
}

/** Text with loops collapsed. Returns the text untouched when nothing changed. */
function collapseText(text) {
  const value = String(text || '');
  const tokens = value.split(/\s+/).filter(Boolean);
  const keep = keepIndices(tokens);
  return keep.length === tokens.length ? value : keep.map((index) => tokens[index]).join(' ');
}

module.exports = { MIN_REPEATS, MAX_PHRASE, collapseWords, collapseText };
