const test = require('node:test');
const assert = require('node:assert/strict');

const { cleanOverrides, normalizePending, moveItem } = require('../src/core/pass-options');

test('only known, valid overrides reach the settings', () => {
  assert.deepEqual(cleanOverrides({
    model: 'large-v3', diffModel: '', language: 'de', mode: 'quality', beamSize: '3', glossary: 'x', whisperPython: 'evil.exe'
  }), { offlineModel: 'large-v3', offlineDiffModel: '', whisperLanguage: 'de', offlineMode: 'quality', offlineBeamSize: 3 });
  assert.deepEqual(cleanOverrides({ model: 'Acme/whisper-ct2', language: 'auto' }), { offlineModel: 'Acme/whisper-ct2', whisperLanguage: 'auto' });
  assert.deepEqual(cleanOverrides({ model: 'a b', language: 'German', mode: 'turbo', beamSize: 99 }), {});
  assert.deepEqual(cleanOverrides(null), {});
});

test('pending passes from older builds (bare folders) are still read', () => {
  assert.deepEqual(normalizePending('C:/m/2026-01-01_10-00'), { folder: 'C:/m/2026-01-01_10-00', overrides: {} });
  assert.deepEqual(normalizePending({ folder: 'x', overrides: { model: 'medium' } }), { folder: 'x', overrides: { model: 'medium' } });
  assert.equal(normalizePending(42), null);
});

test('queue reordering is clamped and does not mutate', () => {
  const list = ['a', 'b', 'c'];
  assert.deepEqual(moveItem(list, 2, -1), ['a', 'c', 'b']);
  assert.deepEqual(moveItem(list, 0, -5), ['a', 'b', 'c']);
  assert.deepEqual(moveItem(list, 0, 9), ['b', 'c', 'a']);
  assert.deepEqual(list, ['a', 'b', 'c']);
});
