/**
 * Per-run options for a final pass started from the browser manager ("re-run
 * this meeting with large-v3 in German"). Only these settings can be
 * overridden; everything else comes from the user's settings as usual. Pure.
 */

const LANGUAGE = /^(auto|[a-z]{2,3})$/;
const MODEL = /^[\w.\-/]{1,120}$/;

/**
 * @param {object} raw  e.g. { model, diffModel, language, mode, beamSize }
 * @returns {object}    settings-store keys, only the valid ones
 */
function cleanOverrides(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  if (typeof raw.model === 'string' && MODEL.test(raw.model)) out.offlineModel = raw.model;
  if (raw.diffModel === '' || (typeof raw.diffModel === 'string' && MODEL.test(raw.diffModel))) out.offlineDiffModel = raw.diffModel;
  if (typeof raw.language === 'string' && LANGUAGE.test(raw.language)) out.whisperLanguage = raw.language;
  if (raw.mode === 'fast' || raw.mode === 'quality') out.offlineMode = raw.mode;
  const beam = Number(raw.beamSize);
  if (Number.isInteger(beam) && beam >= 1 && beam <= 10) out.offlineBeamSize = beam;
  return out;
}

/** A pending-passes file entry: a bare folder (older builds) or { folder, overrides }. */
function normalizePending(entry) {
  if (typeof entry === 'string') return { folder: entry, overrides: {} };
  if (entry && typeof entry.folder === 'string') return { folder: entry.folder, overrides: entry.overrides && typeof entry.overrides === 'object' ? entry.overrides : {} };
  return null;
}

/** Move `item` by `delta` places inside `list`, clamped; returns a new array. */
function moveItem(list, index, delta) {
  const next = list.slice();
  if (index < 0 || index >= next.length) return next;
  const target = Math.max(0, Math.min(next.length - 1, index + delta));
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item);
  return next;
}

module.exports = { cleanOverrides, normalizePending, moveItem };
