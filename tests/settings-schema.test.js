const test = require('node:test');
const assert = require('node:assert/strict');

const schema = require('../src/core/settings-schema');
const profiles = require('../src/core/profiles');

test('the executable, the transcript folder and devices cannot be changed from the browser', () => {
  const { patch, errors } = schema.validatePatch({
    whisperPython: 'C:/evil/python.exe', transcriptRoot: 'C:/', micDeviceLabel: 'x', profiles: {}, activeProfile: 'german'
  });
  assert.deepEqual(patch, {});
  assert.equal(errors.length, 5);
  const visible = schema.visibleValues({ whisperPython: 'p', transcriptRoot: 'r', offlineModel: 'large-v3' });
  assert.deepEqual(visible, { offlineModel: 'large-v3' });
});

test('values are type- and range-checked', () => {
  const { patch, errors } = schema.validatePatch({
    liveTranscription: false, offlineBeamSize: '3', echoSimilarity: 2, whisperLanguage: 'de', archiveFormat: 'mp3',
    offlineModel: 'Acme/whisper-ct2', offlineDiffModel: '', whisperModel: 'a b', folderNamePrefix: ' Acme\nStandup ', micEnabled: 'yes'
  });
  assert.deepEqual(patch, {
    liveTranscription: false, offlineBeamSize: 3, whisperLanguage: 'de', offlineModel: 'Acme/whisper-ct2', offlineDiffModel: '', folderNamePrefix: 'Acme Standup'
  });
  assert.equal(errors.length, 4);
});

test('every schema field has a label and a known type', () => {
  for (const section of schema.describe()) {
    for (const field of section.fields) {
      assert.ok(field.label, field.key);
      assert.ok(['bool', 'number', 'select', 'model', 'text', 'textarea'].includes(field.type), field.key);
    }
  }
});

test('a profile can be edited directly, keeping only profile keys', () => {
  const stored = profiles.update('german', { whisperLanguage: 'de', folderNamePrefix: 'Standup', glossary: 'Acme', windowGap: 3 }, {});
  assert.deepEqual(stored.german, { whisperLanguage: 'de', folderNamePrefix: 'Standup', glossary: 'Acme' });
  assert.equal(profiles.getProfile('german', stored).values.glossary, 'Acme');
  assert.throws(() => profiles.update('nope', {}, {}), /Unknown profile/);
});
