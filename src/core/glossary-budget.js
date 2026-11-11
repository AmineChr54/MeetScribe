/**
 * How much of a glossary reaches the model. The final pass hands Whisper at
 * most HOTWORD_TOKEN_BUDGET tokens of hotwords (whisper_offline.py counts them
 * exactly with the model's tokenizer and has the last word); the rest of the
 * list is silently dropped. This estimates that count, so the pickers can say
 * "about 23 of 93 terms" before a meeting instead of after it.
 *
 * Several project glossaries take turns: the first term of each, then the
 * second of each, and so on, so the first one picked cannot use up the whole
 * budget on its own.
 *
 * Pure. Shared by Node (final pass, tests) and both pickers: the app's Settings
 * window loads this file directly, the library serves it as /glossary-budget.js.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MeetScribeGlossaryBudget = api;
})(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  // Keep in step with HOTWORD_TOKEN_BUDGET in scripts/whisper_offline.py.
  const HOTWORD_TOKEN_BUDGET = 96;
  // The section line glossaries.compose() writes before each project glossary.
  const SECTION = /^#\s*──\s*(.+?)\s*──\s*$/;

  /**
   * Whisper's tokenizer, measured on sample terms: about 3 characters per token
   * for words, under 2 for capitals and digits (acronyms split up). Errs high,
   * so the estimate rather says too few terms fit than too many.
   */
  function estimateTokens(term) {
    let tokens = 0;
    for (const word of String(term || '').split(/\s+/).filter(Boolean)) {
      const tight = (word.match(/[\p{Lu}\p{N}]/gu) || []).length;
      tokens += Math.max(1, Math.ceil(tight / 1.8 + (word.length - tight) / 3.5));
    }
    return tokens;
  }

  /** Terms per section (one section per project glossary) and the ">" context. */
  function parse(raw) {
    const sections = [[]];
    let contextPrompt = '';
    for (const line of String(raw || '').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // "#" is a note and never reaches the model, except that a section line
      // starts the next project glossary.
      if (trimmed.startsWith('#')) {
        if (SECTION.test(trimmed) && sections[sections.length - 1].length) sections.push([]);
        continue;
      }
      if (trimmed.startsWith('>')) {
        contextPrompt += (contextPrompt ? ' ' : '') + trimmed.replace(/^>+\s*/, '');
        continue;
      }
      for (const term of trimmed.split(',')) {
        const clean = term.trim();
        if (clean) sections[sections.length - 1].push(clean);
      }
    }
    return { sections: sections.filter((section) => section.length), contextPrompt: contextPrompt.trim() };
  }

  /** One term from each section in turn. */
  function interleave(sections) {
    const out = [];
    const longest = Math.max(0, ...sections.map((section) => section.length));
    for (let i = 0; i < longest; i++) {
      for (const section of sections) if (i < section.length) out.push(section[i]);
    }
    return out;
  }

  /** A glossary file's hotwords in the order they are offered to the model. */
  function hotwords(raw) {
    const { sections, contextPrompt } = parse(raw);
    return { terms: interleave(sections), contextPrompt };
  }

  /** How many terms, from the start, fit the budget (", " between terms costs a token). */
  function fit(terms, budget = HOTWORD_TOKEN_BUDGET) {
    let used = 0;
    let kept = 0;
    for (const term of terms) {
      const cost = estimateTokens(term) + (kept ? 1 : 0);
      if (used + cost > budget) break;
      used += cost;
      kept++;
    }
    return kept;
  }

  /** About how many terms of these project glossaries, picked together, reach the model. */
  function forTexts(texts) {
    const terms = interleave((texts || []).map((text) => [].concat(...parse(text).sections)));
    return { kept: fit(terms), total: terms.length };
  }

  /** A short line for under a picker, or '' when nothing is picked. */
  function describe({ kept, total }) {
    if (!total) return '';
    if (kept >= total) return `All ${total} term${total === 1 ? '' : 's'} reach the model.`;
    return `About ${kept} of ${total} terms reach the model; the rest are ignored. Short lists of words that are actually said work best.`;
  }

  return { HOTWORD_TOKEN_BUDGET, estimateTokens, parse, interleave, hotwords, fit, forTexts, describe };
});
