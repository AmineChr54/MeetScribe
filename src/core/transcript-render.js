/**
 * Renders transcript.final.md. Pure: used by the final pass right after
 * decoding (offline-pass.service.js), and by the browser manager to rebuild the
 * Markdown after the transcript was edited, from transcript.final.json alone.
 */

// Consecutive segments from one speaker closer than this become one paragraph.
const BLOCK_GAP_MS = 8000;
// A new "## HH:MM" heading is emitted once the clock has moved on this far.
const CHAPTER_INTERVAL_MS = 5 * 60 * 1000;
// How many uncertain spans to list in the index at the end of the transcript.
const UNCERTAIN_INDEX_LIMIT = 40;

const pad = (value) => String(value).padStart(2, '0');
const clockOf = (ms) => {
  const date = new Date(ms);
  return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
};
const hhmmOf = (ms) => {
  const date = new Date(ms);
  return pad(date.getHours()) + ':' + pad(date.getMinutes());
};

function buildMarkdown({
  meta, result, entries, glossary, uncertain, threshold, appliedFixes, glossaryCopies, hasCorrections
}) {
  const started = new Date(meta.startedAt);
  const stopped = new Date(meta.stoppedAt || meta.startedAt);
  const out = [];

  out.push('# Meeting ' + started.toLocaleDateString() + ' · ' + hhmmOf(meta.startedAt) + '–' + hhmmOf(stopped.getTime()));
  out.push('');
  const speakers = meta.streams
    .map((entry) => entry.label + ' (' + (entry.stream === 'mic' ? 'microphone' : 'system audio') + ')')
    .join(' · ');
  out.push('- **Speakers:** ' + speakers);
  out.push('- **ASR:** ' + result.model + ' · ' + (result.mode || 'quality') + ' · beam ' + result.beamSize + ' · ' +
    (result.language || 'auto') + ' · ' + result.device + '/' + result.computeType);
  if (result.diffModel) out.push('- **Cross-checked against:** ' + result.diffModel);
  if (glossary.terms.length > 0) {
    const kept = Number.isInteger(result.glossaryKept) ? result.glossaryKept : glossary.terms.length;
    out.push('- **Glossary:** ' + glossary.terms.slice(0, kept).join(', ') +
      (kept < glossary.terms.length ? ' (first ' + kept + ' of ' + glossary.terms.length + ' terms used)' : ''));
  }
  if (glossary.contextPrompt) out.push('- **Context given to the model:** ' + glossary.contextPrompt);
  const dropped = Array.from(new Set(result.glossaryDropped || []));
  if (dropped.length > 0) {
    const labels = dropped.map((id) => (meta.streams.find((entry) => entry.stream === id) || {}).label || id);
    out.push('- **Glossary was not applied** to ' + labels.join(', ') + ': decoding failed with it');
  }
  if (glossaryCopies > 0) {
    out.push('- **Dropped:** ' + glossaryCopies + ' line' + (glossaryCopies === 1 ? '' : 's') +
      ' that only repeated the glossary');
  }
  out.push('- **Markup:** `~wort~` = the model was unsure (p < ' + threshold + ')' +
    (result.diffModel ? ' · `<a|b>` = the two models disagreed' : '') +
    (hasCorrections ? ' · `{wort}` = replaced from the corrections list' : ''));
  if (appliedFixes.length > 0) {
    out.push('- **Corrections applied:** ' +
      appliedFixes.map((fix) => fix.heard + ' → ' + fix.correct + ' (' + fix.count + '×)').join(', '));
  }
  out.push('');
  out.push('> Produced by the final pass over the archived audio, with context across the whole');
  out.push('> meeting and a glossary. The live `transcript.txt` in this folder is the low-latency');
  out.push('> preview and will differ — where the two disagree, this file is the better one.');
  out.push('');
  out.push('---');
  out.push('');

  let lastChapter = 0;
  let lastLabel = null;
  let lastEndedAt = 0;
  let paragraph = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    out.push('**' + lastLabel + ':** ' + paragraph.join(' '));
    out.push('');
    paragraph = [];
  };

  for (const entry of entries) {
    if (entry.startedAt - lastChapter >= CHAPTER_INTERVAL_MS) {
      flushParagraph();
      lastLabel = null;
      lastChapter = entry.startedAt;
      out.push('## ' + hhmmOf(entry.startedAt));
      out.push('');
    }

    if (entry.kind === 'screenshot') {
      flushParagraph();
      lastLabel = null;
      out.push('*[' + clockOf(entry.startedAt) + '] screenshot: `' + entry.text + '`*');
      out.push('');
      continue;
    }
    if (entry.kind === 'marker') {
      flushParagraph();
      lastLabel = null;
      out.push('*[' + clockOf(entry.startedAt) + '] mark' + (entry.text ? ': ' + entry.text : '') + '*');
      out.push('');
      continue;
    }

    const sameSpeaker = entry.label === lastLabel;
    const closeEnough = entry.startedAt - lastEndedAt <= BLOCK_GAP_MS;
    if (!sameSpeaker || !closeEnough) {
      flushParagraph();
      lastLabel = entry.label;
    }
    paragraph.push(entry.rendered);
    lastEndedAt = entry.endedAt;
  }
  flushParagraph();

  if (uncertain.length > 0) {
    out.push('---');
    out.push('');
    out.push('## Uncertain spans');
    out.push('');
    out.push('The ' + Math.min(uncertain.length, UNCERTAIN_INDEX_LIMIT) + ' least confident places in this transcript, worst first.');
    out.push('Start here when correcting; the rest of the text is comparatively safe.');
    out.push('');
    out.push('| Time | Speaker | Read as | Alternative / confidence |');
    out.push('|---|---|---|---|');

    const ranked = uncertain
      .slice()
      .sort((a, b) => {
        const scoreA = a.kind === 'model-disagreement' ? -1 : a.probability;
        const scoreB = b.kind === 'model-disagreement' ? -1 : b.probability;
        return scoreA - scoreB;
      })
      .slice(0, UNCERTAIN_INDEX_LIMIT);

    for (const item of ranked) {
      const escape = (value) => String(value || '').replace(/\|/g, '\\|');
      if (item.kind === 'model-disagreement') {
        out.push('| ' + item.at + ' | ' + escape(item.label) + ' | ' + escape(item.primary) +
          ' | second model heard "' + escape(item.secondary) + '" |');
      } else {
        out.push('| ' + item.at + ' | ' + escape(item.label) + ' | ' + escape(item.word) +
          ' | p = ' + item.probability.toFixed(2) + ' |');
      }
    }
    out.push('');
  }

  return out.join('\r\n');
}

/**
 * What the final pass stores in transcript.final.json so the Markdown can be
 * rebuilt later without the audio or the decoder's raw output.
 */
function renderInfo({ meta, result, glossary, threshold, glossaryCopies, hasCorrections }) {
  return {
    startedAt: meta.startedAt,
    stoppedAt: meta.stoppedAt,
    speakers: (meta.streams || []).map((entry) => ({ stream: entry.stream, label: entry.label })),
    mode: result.mode,
    glossaryKept: result.glossaryKept,
    glossaryDropped: result.glossaryDropped || [],
    contextPrompt: glossary.contextPrompt || '',
    threshold,
    glossaryCopies,
    hasCorrections
  };
}

/** buildMarkdown's arguments, recovered from a transcript.final.json. */
function fromFinalJson(doc) {
  const info = doc.render || {};
  const asr = doc.asr || {};
  const meeting = doc.meeting || {};
  // Files from before the render block existed: recover what the entries tell.
  const speakers = info.speakers || [];
  if (!speakers.length) {
    const seen = new Map();
    for (const entry of doc.entries || []) {
      if (entry.kind === 'speech' && entry.streamId && !seen.has(entry.streamId)) seen.set(entry.streamId, entry.label);
    }
    for (const [stream, label] of seen) speakers.push({ stream, label });
  }
  return {
    meta: {
      startedAt: info.startedAt || meeting.startedAt,
      stoppedAt: info.stoppedAt || meeting.stoppedAt,
      streams: speakers
    },
    result: {
      model: asr.model,
      diffModel: asr.diffModel,
      device: asr.device,
      computeType: asr.computeType,
      beamSize: asr.beamSize,
      language: asr.language,
      mode: info.mode,
      glossaryKept: info.glossaryKept,
      glossaryDropped: info.glossaryDropped || []
    },
    entries: (doc.entries || []).map((entry) => ({ ...entry, rendered: entry.marked || entry.text })),
    glossary: { terms: asr.glossary || [], contextPrompt: info.contextPrompt || '' },
    uncertain: doc.uncertain || [],
    threshold: info.threshold || 0.5,
    appliedFixes: doc.corrections || [],
    glossaryCopies: info.glossaryCopies || 0,
    hasCorrections: Boolean(info.hasCorrections)
  };
}

module.exports = { buildMarkdown, renderInfo, fromFinalJson, clockOf, hhmmOf };
