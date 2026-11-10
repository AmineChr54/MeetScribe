const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const library = require('../src/core/library');

test('folder names with and without a profile prefix are parsed', () => {
  const plain = library.parseFolderName('2026-03-04_09-15');
  assert.equal(plain.prefix, '');
  assert.equal(plain.stamp, '2026-03-04_09-15');
  assert.equal(new Date(plain.startedAt).getHours(), 9);

  const prefixed = library.parseFolderName('Acme Standup_2026-03-04_09-15-2');
  assert.equal(prefixed.prefix, 'Acme Standup');
  assert.equal(prefixed.suffix, 2);
  assert.equal(library.stampOf(prefixed.startedAt), '2026-03-04_09-15');

  assert.equal(library.parseFolderName('Notes'), null);
  assert.equal(library.parseFolderName('2026-02-30_10-00'), null);
});

test('paths are confined to the transcript folder', () => {
  const root = path.resolve('/tmp/meetings');
  assert.equal(library.resolveInside(root, 'Acme/2026-03-04_09-15'), path.join(root, 'Acme', '2026-03-04_09-15'));
  assert.equal(library.resolveInside(root, ''), root);
  for (const bad of ['..', '../other', 'Acme/../../x', '/etc/passwd', 'C:\Windows', '\\server\share', 'a\0b']) {
    assert.throws(() => library.resolveInside(root, bad), `${JSON.stringify(bad)} should be refused`);
  }
  assert.equal(library.idOf(root, path.join(root, 'Acme', 'm1')), 'Acme/m1');
});

test('live transcript lines, screenshots and markers become timeline entries', () => {
  const text = [
    '# Meeting transcript - synthetic',
    '# Them = system audio | You = microphone',
    '',
    '[23:59:50] Them: Welcome to the AcmeTrakr review.',
    '[23:59:58] --- screenshot: shot-01_23-59-58.png ---',
    '[00:00:04] You: Thanks, the Zorblin numbers look fine.',
    '[00:00:09] --- mark: decision ---',
    '[00:00:10] --- mark ---',
    '# Ended synthetic'
  ].join('\r\n');
  const start = new Date(2026, 2, 4, 23, 59, 40).getTime();
  const entries = library.parseLiveTranscript(text, start);
  assert.deepEqual(entries.map((entry) => entry.kind), ['speech', 'screenshot', 'speech', 'marker', 'marker']);
  assert.equal(entries[0].label, 'Them');
  assert.equal(entries[1].text, 'shot-01_23-59-58.png');
  assert.equal(entries[3].text, 'decision');
  assert.equal(entries[4].text, '');
  // Midnight passed between the first and third line.
  assert.equal(entries[2].startedAt - entries[0].startedAt, 14000);
  // A line lasts until the next one, capped at 12 s.
  assert.equal(entries[0].endedAt, entries[0].startedAt + 12000);
});

test('final-pass markup is stripped for plain text', () => {
  assert.equal(library.stripMarkup('the ~Zorblin~ report <is|was> {AcmeTrakr} ready'), 'the Zorblin report is AcmeTrakr ready');
});

test('search needs every term, counts hits and returns snippets', () => {
  const terms = library.queryTerms('acme "launch plan"');
  assert.deepEqual(terms, ['acme', 'launch plan']);
  const text = 'Acme said the launch plan slips. Later Acme confirmed it. ' + 'x '.repeat(100) + 'Acme again.';
  const found = library.searchText(text, terms);
  assert.equal(found.hits, 4);
  assert.ok(found.snippets.length >= 2 && found.snippets.length <= 3);
  assert.equal(library.searchText(text, ['acme', 'missing']), null);
  assert.equal(library.searchText(text, []), null);
});
