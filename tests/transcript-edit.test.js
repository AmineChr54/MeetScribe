const test = require('node:test');
const assert = require('node:assert/strict');

const render = require('../src/core/transcript-render');
const { applyFinalEdit, applyLiveEdit, eventsOf } = require('../src/core/transcript-edit');
const library = require('../src/core/library');

const T0 = new Date(2026, 2, 4, 9, 15, 0).getTime();

function finalDoc() {
  const speech = (label, streamId, at, text, marked) => ({
    kind: 'speech', label, streamId, startedAt: T0 + at, endedAt: T0 + at + 3000,
    clock: render.clockOf(T0 + at), text, marked, words: [{ word: ' x', start: 0, end: 1, probability: 0.9 }]
  });
  return {
    version: 1,
    meeting: { startedAt: T0, stoppedAt: T0 + 60000 },
    asr: { model: 'large-v3-turbo', device: 'cpu', computeType: 'int8', beamSize: 2, language: 'en', glossary: ['AcmeTrakr'] },
    render: {
      startedAt: T0, stoppedAt: T0 + 60000, speakers: [{ stream: 'system', label: 'Them' }, { stream: 'mic', label: 'You' }],
      mode: 'fast', glossaryKept: 1, glossaryDropped: [], contextPrompt: 'A review of AcmeTrakr.', threshold: 0.5, glossaryCopies: 0, hasCorrections: true
    },
    entries: [
      speech('Them', 'system', 1000, 'Welcome to the AcmeTrakr review.', 'Welcome to the ~AcmeTrakr~ review.'),
      speech('You', 'mic', 5000, 'Thanks, Zorblin is fine.', 'Thanks, {Zorblin} is fine.'),
      { kind: 'marker', startedAt: T0 + 9000, endedAt: T0 + 9000, clock: render.clockOf(T0 + 9000), text: 'decision', marked: null },
      speech('Them', 'system', 10000, 'Then we ship.', 'Then we ship.')
    ],
    corrections: [{ heard: 'zorbin', correct: 'Zorblin', count: 1 }],
    uncertain: [{ kind: 'low-confidence', at: '09:15:01', startedAt: T0 + 1000, label: 'Them', word: 'AcmeTrakr', probability: 0.3, context: '' }]
  };
}

test('markdown rebuilt from the JSON equals the one the final pass wrote', () => {
  const doc = finalDoc();
  // What offline-pass hands buildMarkdown directly after decoding.
  const direct = render.buildMarkdown({
    meta: { startedAt: T0, stoppedAt: T0 + 60000, streams: doc.render.speakers },
    result: { model: 'large-v3-turbo', mode: 'fast', beamSize: 2, language: 'en', device: 'cpu', computeType: 'int8', glossaryKept: 1, glossaryDropped: [] },
    entries: doc.entries.map((entry) => ({ ...entry, rendered: entry.marked })),
    glossary: { terms: ['AcmeTrakr'], contextPrompt: 'A review of AcmeTrakr.' },
    uncertain: doc.uncertain,
    threshold: 0.5,
    appliedFixes: doc.corrections,
    glossaryCopies: 0,
    hasCorrections: true
  });
  assert.equal(render.buildMarkdown(render.fromFinalJson(doc)), direct);
  assert.match(direct, /\*\*Them:\*\* Welcome to the ~AcmeTrakr~ review\./);
  assert.match(direct, /mark: decision/);
});

test('old JSON files without a render block still rebuild', () => {
  const doc = finalDoc();
  delete doc.render;
  const markdown = render.buildMarkdown(render.fromFinalJson(doc));
  assert.match(markdown, /Them \(system audio\) · You \(microphone\)/);
});

test('editing text drops word timings and the line\'s uncertain spans', () => {
  const doc = finalDoc();
  const first = doc.entries[0];
  const next = applyFinalEdit(doc, { op: 'text', index: 0, startedAt: first.startedAt, text: '  Welcome to the\nAcmeTrakr review!  ' });
  assert.equal(next.entries[0].text, 'Welcome to the AcmeTrakr review!');
  assert.equal(next.entries[0].marked, next.entries[0].text);
  assert.deepEqual(next.entries[0].words, []);
  assert.equal(next.uncertain.length, 0);
  assert.equal(doc.entries[0].text, 'Welcome to the AcmeTrakr review.', 'the input is not mutated');
});

test('label, merge, delete and markers', () => {
  let doc = finalDoc();
  doc = applyFinalEdit(doc, { op: 'label', index: 1, startedAt: T0 + 5000, label: 'Other 1' });
  assert.equal(doc.entries[1].label, 'Other 1');
  // Merge skips the marker in between and joins the next spoken line.
  doc = applyFinalEdit(doc, { op: 'merge', index: 1, startedAt: T0 + 5000 });
  assert.equal(doc.entries[1].text, 'Thanks, Zorblin is fine. Then we ship.');
  assert.equal(doc.entries[1].endedAt, T0 + 13000);
  assert.equal(doc.entries.length, 3);
  doc = applyFinalEdit(doc, { op: 'marker-add', startedAt: T0 + 3000, text: 'intro done' });
  assert.equal(doc.entries[1].kind, 'marker');
  assert.deepEqual(eventsOf(doc.entries).map((event) => event.text), ['intro done', 'decision']);
  doc = applyFinalEdit(doc, { op: 'marker-delete', index: 1, startedAt: T0 + 3000 });
  doc = applyFinalEdit(doc, { op: 'delete', index: 0, startedAt: T0 + 1000 });
  assert.deepEqual(doc.entries.map((entry) => entry.kind), ['speech', 'marker']);
});

test('a stale edit is refused instead of hitting the wrong line', () => {
  const doc = finalDoc();
  assert.throws(() => applyFinalEdit(doc, { op: 'text', index: 0, startedAt: T0 + 5000, text: 'x' }), /changed/);
  assert.throws(() => applyFinalEdit(doc, { op: 'text', index: 2, startedAt: T0 + 9000, text: 'x' }), /cannot be edited/);
  assert.throws(() => applyFinalEdit(doc, { op: 'text', index: 0, startedAt: T0 + 1000, text: '   ' }), /Delete the line/);
  assert.throws(() => applyFinalEdit(doc, { op: 'label', index: 0, startedAt: T0 + 1000, label: ':' }), /empty/);
  assert.throws(() => applyFinalEdit(doc, { op: 'merge', index: 3, startedAt: T0 + 10000 }), /no next line/);
  assert.throws(() => applyFinalEdit(doc, { op: 'nope' }), /Unknown/);
});

test('live transcript edits keep the header, the footer and the line endings', () => {
  const text = [
    '# Meeting transcript - synthetic',
    '',
    '[09:15:01] Them: Welcome to the AcmeTrakr review.',
    '[09:15:05] You: Thanks, Zorblin is fine.',
    '[09:15:10] Them: Then we ship.',
    '',
    '# Ended synthetic'
  ].join('\r\n');
  let next = applyLiveEdit(text, T0, { op: 'text', index: 1, startedAt: T0 + 5000, text: 'Thanks, Zorblin looks fine.' });
  assert.match(next, /\r\n\[09:15:05\] You: Thanks, Zorblin looks fine\.\r\n/);
  next = applyLiveEdit(next, T0, { op: 'marker-add', startedAt: T0 + 7000, text: 'decision' });
  assert.match(next, /\[09:15:05\] You: .*\r\n\[09:15:07\] --- mark: decision ---\r\n\[09:15:10\]/);
  next = applyLiveEdit(next, T0, { op: 'merge', index: 0, startedAt: T0 + 1000 });
  assert.match(next, /\[09:15:01\] Them: Welcome to the AcmeTrakr review\. Thanks, Zorblin looks fine\./);
  next = applyLiveEdit(next, T0, { op: 'label', index: 0, startedAt: T0 + 1000, label: 'Other 1' });
  next = applyLiveEdit(next, T0, { op: 'delete', index: 2, startedAt: T0 + 10000 });
  assert.equal(next.split('\r\n')[0], '# Meeting transcript - synthetic');
  assert.equal(next.split('\r\n').pop(), '# Ended synthetic');
  const entries = library.parseLiveTranscript(next, T0);
  assert.deepEqual(entries.map((entry) => `${entry.kind}:${entry.label || entry.text}`), ['speech:Other 1', 'marker:decision']);
});

test('renaming keeps the date stamp and drops characters Windows refuses', () => {
  assert.equal(library.renamedFolder('Acme: kickoff?', 'German_2026-03-04_09-15', 0), 'Acme kickoff_2026-03-04_09-15');
  assert.equal(library.renamedFolder('', 'Acme_2026-03-04_09-15-2', 0), '2026-03-04_09-15');
  assert.equal(library.renamedFolder('Review', 'imported', T0), 'Review_2026-03-04_09-15');
  assert.deepEqual(library.cleanTags('#Acme, review,acme, , two words'), ['Acme', 'review', 'two-words']);
});

test('exports: plain text, SRT and the LLM header', () => {
  const entries = finalDoc().entries;
  const plain = library.toPlainText(entries);
  assert.match(plain, /^\[09:15:01\] Them: Welcome to the AcmeTrakr review\.$/m);
  assert.match(plain, /--- mark: decision ---/);
  assert.match(library.toPlainText(entries, { markup: true }), /~AcmeTrakr~/);
  const srt = library.toSrt(entries, T0);
  assert.match(srt, /^1\n00:00:01,000 --> 00:00:04,000\nThem: Welcome/);
  assert.equal(srt.split('\n\n').filter(Boolean).length, 3);
  const llm = library.toLlmText({ title: 'Acme review', startedAt: T0 }, entries);
  assert.match(llm, /^Meeting: Acme review\n/);
  assert.match(llm, /Speakers: Them, You/);
});
