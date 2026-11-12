const test = require('node:test');
const assert = require('node:assert/strict');

const repeats = require('../src/core/repeats');

test('a word repeated four times or more collapses to one', () => {
  assert.equal(repeats.collapseText('Then so, so, so, so, so, so the Acme deploy.'), 'Then so, the Acme deploy.');
  assert.equal(repeats.collapseText('So So so SO.'), 'So');
});

test('short phrases that loop collapse too', () => {
  assert.equal(repeats.collapseText('and then and then and then and then it worked'), 'and then it worked');
  assert.equal(repeats.collapseText('ask Zorblin ok ask Zorblin ok ask Zorblin ok ask Zorblin ok'), 'ask Zorblin ok');
});

test('three in a row and ordinary text stay as they are', () => {
  const text = 'No, no, no.  That is   fine.';
  assert.equal(repeats.collapseText(text), text);
  assert.equal(repeats.collapseText(''), '');
});

test('word objects collapse the same way and keep their timing', () => {
  const words = ['We', ' so', ' so', ' so', ' so', ' ship'].map((word, index) => ({ word, start: index, end: index + 1 }));
  const out = repeats.collapseWords(words);
  assert.deepEqual(out.map((word) => word.word), ['We', ' so', ' ship']);
  assert.equal(out[2].start, 5);
  const plain = words.slice(0, 3);
  assert.equal(repeats.collapseWords(plain), plain);
});
