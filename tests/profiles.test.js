const test = require('node:test');
const assert = require('node:assert/strict');

const profiles = require('../src/core/profiles');

test('built-in profiles cover every profile key except the glossary', () => {
  for (const profile of profiles.BUILTIN) {
    for (const key of profiles.PROFILE_KEYS) {
      if (key === 'glossary') continue;
      assert.ok(key in profile.values, `${profile.id} is missing ${key}`);
    }
    assert.equal('glossary' in profile.values, false);
  }
});

test('picking a profile keeps the current glossary unless the profile stored one', () => {
  const current = { activeProfile: '', whisperModel: 'medium', glossary: 'Acme, AcmeTrakr' };
  const untouched = profiles.select('english', current, {}).patch;
  assert.equal('glossary' in untouched, false);

  const stored = { german: { glossary: 'Zorblin' } };
  assert.equal(profiles.select('german', current, stored).patch.glossary, 'Zorblin');
});

test('tunisian profile turns live transcription off and uses the final pass', () => {
  const tunisian = profiles.getProfile('tunisian');
  assert.equal(tunisian.values.liveTranscription, false);
  assert.equal(tunisian.values.offlinePassEnabled, true);
});

test('stored edits overlay the built-in values', () => {
  const stored = { german: { folderNamePrefix: 'Standup', glossary: 'Acme, AcmeTrakr' } };
  const german = profiles.getProfile('german', stored);
  assert.equal(german.values.folderNamePrefix, 'Standup');
  assert.equal(german.values.glossary, 'Acme, AcmeTrakr');
  assert.equal(german.values.whisperLanguage, 'de');
  assert.equal(german.edited, true);
});

test('first pick snapshots current settings as "My settings"', () => {
  const current = { activeProfile: '', whisperModel: 'medium', glossary: 'Acme', folderNamePrefix: '' };
  const { patch } = profiles.select('english', current, {});
  assert.equal(patch.activeProfile, 'english');
  assert.equal(patch.whisperModel, 'small.en');
  assert.equal(patch.profiles.custom.whisperModel, 'medium');
  assert.equal(profiles.getProfile('custom', patch.profiles).label, 'My settings');
});

test('switching between profiles does not overwrite the snapshot', () => {
  const stored = { custom: { whisperModel: 'medium' } };
  const { patch } = profiles.select('german', { activeProfile: 'english', whisperModel: 'small.en' }, stored);
  assert.equal(patch.profiles.custom.whisperModel, 'medium');
});

test('edits are written back into the active profile only', () => {
  const settings = { whisperModel: 'small.en', folderNamePrefix: 'Calls', glossary: '' };
  const stored = profiles.recordEdit('english', { folderNamePrefix: 'Calls' }, settings, {});
  assert.equal(stored.english.folderNamePrefix, 'Calls');
  assert.equal(profiles.recordEdit('', { folderNamePrefix: 'x' }, settings, {}).english, undefined);
  assert.deepEqual(profiles.recordEdit('english', { windowGap: 4 }, settings, {}), {});
});

test('reset drops stored edits; unknown profile throws', () => {
  assert.deepEqual(profiles.reset('german', { german: { folderNamePrefix: 'x' } }), {});
  assert.throws(() => profiles.select('nope', {}, {}), /Unknown profile/);
});

test('folder prefix is made safe for Windows paths', () => {
  assert.equal(profiles.sanitizeFolderPrefix('  My: Calls/2026? '), 'My Calls2026');
  assert.equal(profiles.sanitizeFolderPrefix('..'), '');
  assert.equal(profiles.sanitizeFolderPrefix('x'.repeat(100)).length, 40);
  assert.equal(profiles.meetingFolderName('English', '2026-01-02_10-30'), 'English_2026-01-02_10-30');
  assert.equal(profiles.meetingFolderName('', '2026-01-02_10-30'), '2026-01-02_10-30');
});
