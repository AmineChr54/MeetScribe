const test = require('node:test');
const assert = require('node:assert/strict');

const glossaries = require('../src/core/glossaries');

test('names are safe file names; sets drop duplicates and junk', () => {
  assert.equal(glossaries.cleanName('  Acme: Billing/Q3? '), 'Acme BillingQ3');
  assert.equal(glossaries.cleanName('..'), '');
  assert.deepEqual(glossaries.cleanSet(['Acme', 'acme', '', 'Zorblin', 7]), ['Acme', 'Zorblin', '7']);
  assert.deepEqual(glossaries.cleanSet('Acme'), []);
});

test('terms are counted without notes or context lines', () => {
  assert.equal(glossaries.countTerms('# note\nAcme, AcmeTrakr\n> A meeting about Acme.\n\nZorblin'), 3);
  assert.equal(glossaries.countTerms(''), 0);
});

test('composed glossaries remember which project glossaries they came from', () => {
  const text = glossaries.compose([{ name: 'Acme', text: 'AcmeTrakr, Zorblin' }, { name: 'Empty', text: '' }], 'Kwerty');
  assert.match(text, /^#@ glossaries: Acme, Empty\n/);
  assert.match(text, /# ── Acme ──\nAcmeTrakr, Zorblin/);
  assert.match(text, /# ── Other terms ──\nKwerty/);
  assert.deepEqual(glossaries.setOf(glossaries.meetingFile(text)), ['Acme', 'Empty']);
  // Free text alone stays exactly what the user wrote.
  assert.equal(glossaries.compose([], 'Kwerty'), 'Kwerty');
  assert.deepEqual(glossaries.setOf('Kwerty'), []);
});

test('"no glossary" is not an empty file, and has no terms', () => {
  const none = glossaries.emptyGlossary();
  assert.ok(none.trim().length > 0);
  assert.equal(glossaries.countTerms(none), 0);
  assert.deepEqual(glossaries.setOf(none), []);
});
