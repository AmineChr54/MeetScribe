const test = require('node:test');
const assert = require('node:assert/strict');

const budget = require('../src/core/glossary-budget');
const glossaries = require('../src/core/glossaries');

test('project glossaries take turns in the hotword order', () => {
  const text = glossaries.meetingFile(glossaries.compose([
    { name: 'Acme', text: '> A meeting about Acme.\nAcme, AcmeTrakr, Billing board' },
    { name: 'Zorblin', text: 'Zorblin\nQuandor' }
  ], 'Standup'));
  const { terms, contextPrompt } = budget.hotwords(text);
  assert.deepEqual(terms, ['Acme', 'Zorblin', 'Standup', 'AcmeTrakr', 'Quandor', 'Billing board']);
  assert.equal(contextPrompt, 'A meeting about Acme.');
});

test('a term in several glossaries is offered once', () => {
  const text = glossaries.compose([
    { name: 'Acme', text: 'Acme, Claude, Zorblin' },
    { name: 'Quandor', text: 'Quandor, claude, Acme, Billing' }
  ]);
  assert.deepEqual(budget.hotwords(text).terms, ['Acme', 'Quandor', 'Claude', 'Zorblin', 'Billing']);
  assert.deepEqual(budget.forTexts(['Acme, Claude', 'Claude, Zorblin']), { kept: 3, total: 3 });
  assert.deepEqual(budget.hotwords('Acme, Acme\nACME').terms, ['Acme']);
});

test('a plain glossary keeps its order', () => {
  assert.deepEqual(budget.hotwords('# note\nAcme, Zorblin\nQuandor').terms, ['Acme', 'Zorblin', 'Quandor']);
  assert.deepEqual(budget.hotwords('').terms, []);
});

test('token estimate: words are cheap, acronyms and compounds cost more', () => {
  assert.equal(budget.estimateTokens('Acme'), 2);
  assert.ok(budget.estimateTokens('ACME') >= budget.estimateTokens('Acme'));
  assert.ok(budget.estimateTokens('Rechnungsprüfungsstelle') >= 6);
  assert.equal(budget.estimateTokens(''), 0);
});

test('only the start of a long list fits; separators count', () => {
  const many = Array.from({ length: 60 }, (_, i) => `Zorblin${i}`);
  const kept = budget.fit(many);
  assert.ok(kept > 5 && kept < 60, `kept ${kept}`);
  assert.equal(budget.fit(['Acme', 'Zorblin'], 3), 1);
  assert.equal(budget.fit(['Acme', 'Zorblin'], 6), 2);
});

test('the picker line says when terms are dropped', () => {
  const short = budget.forTexts(['Acme, Zorblin']);
  assert.deepEqual(short, { kept: 2, total: 2 });
  assert.match(budget.describe(short), /^All 2 terms/);
  const long = budget.forTexts([Array.from({ length: 80 }, (_, i) => `AcmeTrakr${i}`).join(', '), 'Zorblin']);
  assert.equal(long.total, 81);
  assert.ok(long.kept < long.total);
  assert.match(budget.describe(long), new RegExp(`^About ${long.kept} of 81 terms`));
  assert.equal(budget.describe(budget.forTexts([])), '');
});
