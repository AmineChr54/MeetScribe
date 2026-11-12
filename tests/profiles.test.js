const test = require('node:test');
const assert = require('node:assert/strict');

const profiles = require('../src/core/profiles');

const DEFAULTS = {
  liveTranscription: true,
  whisperModel: 'small',
  whisperLanguage: 'auto',
  offlineModel: 'large-v3-turbo',
  offlinePassEnabled: true,
  archiveAudio: true,
  showTranscriptOnRecord: true,
  folderNamePrefix: '',
  glossary: '',
  glossarySet: []
};

test('built-in profiles cover every profile key except the glossaries', () => {
  for (const profile of profiles.BUILTIN) {
    for (const key of profiles.PROFILE_KEYS) {
      if (key === 'glossary' || key === 'glossarySet') continue;
      assert.ok(key in profile.values, `${profile.id} is missing ${key}`);
    }
    assert.equal('glossary' in profile.values, false);
  }
});

test('"No profile" comes first and stands for the shipped defaults', () => {
  const list = profiles.listProfiles({}, DEFAULTS);
  assert.equal(list[0].id, profiles.NONE_ID);
  assert.equal(list[0].label, 'No profile');
  assert.equal(list[0].values.whisperModel, 'small');
  assert.equal(list.some((profile) => profile.id === 'custom'), false);
});

test('picking "No profile" resets to the defaults but keeps the glossary text', () => {
  const current = { activeProfile: 'german', whisperModel: 'scheidti/whisper-tiny-german-1224-ct2', whisperLanguage: 'de', glossary: 'Acme, AcmeTrakr', glossarySet: ['Acme'] };
  const { patch } = profiles.select(profiles.NONE_ID, current, DEFAULTS);
  assert.equal(patch.activeProfile, '');
  assert.equal(patch.whisperModel, 'small');
  assert.equal(patch.whisperLanguage, 'auto');
  assert.deepEqual(patch.glossarySet, []);
  assert.equal('glossary' in patch, false);
});

test('never having picked a profile reads as "No profile"', () => {
  assert.equal(profiles.activeId({ activeProfile: '' }), profiles.NONE_ID);
  assert.equal(profiles.activeId({ activeProfile: 'gone' }), profiles.NONE_ID);
  assert.equal(profiles.activeId({ activeProfile: 'english' }), 'english');
});

test('picking a profile keeps the current glossary unless the profile stored one', () => {
  const current = { activeProfile: '', whisperModel: 'medium', glossary: 'Acme, AcmeTrakr' };
  const untouched = profiles.select('english', current, DEFAULTS).patch;
  assert.equal('glossary' in untouched, false);
  assert.equal(untouched.activeProfile, 'english');

  const stored = { ...current, profiles: { german: { glossary: 'Zorblin' } } };
  assert.equal(profiles.select('german', stored, DEFAULTS).patch.glossary, 'Zorblin');
});

test('tunisian profile turns live transcription off and uses the final pass', () => {
  const tunisian = profiles.getProfile('tunisian');
  assert.equal(tunisian.values.liveTranscription, false);
  assert.equal(tunisian.values.offlinePassEnabled, true);
});

test('stored edits overlay the built-in values', () => {
  const settings = { profiles: { german: { folderNamePrefix: 'Standup', glossary: 'Acme, AcmeTrakr' } } };
  const german = profiles.getProfile('german', settings);
  assert.equal(german.values.folderNamePrefix, 'Standup');
  assert.equal(german.values.glossary, 'Acme, AcmeTrakr');
  assert.equal(german.values.whisperLanguage, 'de');
  assert.equal(german.edited, true);
});

test('edits are written back into the active profile only', () => {
  const settings = { whisperModel: 'small.en', folderNamePrefix: 'Calls', glossary: '' };
  assert.equal(profiles.recordEdit('english', { folderNamePrefix: 'Calls' }, settings).profiles.english.folderNamePrefix, 'Calls');
  assert.equal(profiles.recordEdit('', { folderNamePrefix: 'x' }, settings), null);
  assert.equal(profiles.recordEdit(profiles.NONE_ID, { folderNamePrefix: 'x' }, settings), null);
  assert.equal(profiles.recordEdit('english', { windowGap: 4 }, settings), null);
  // Picking a profile passes its values through saveSettings: not an edit.
  const picked = profiles.select('english', settings, DEFAULTS).patch;
  assert.equal(profiles.recordEdit('english', picked, { ...settings, ...picked }), null);
});

test('a profile of your own: create from settings, edit, rename, delete', () => {
  const settings = { activeProfile: '', whisperModel: 'medium', whisperLanguage: 'de', windowGap: 4, myProfiles: [] };
  const { id, patch } = profiles.create({ label: 'Acme calls', flag: 'de', values: settings }, settings);
  assert.equal(id, 'my-acme-calls');
  const mine = patch.myProfiles[0];
  assert.equal(mine.values.whisperModel, 'medium');
  assert.equal('windowGap' in mine.values, false);

  const withMine = { ...settings, ...patch, activeProfile: id };
  const listed = profiles.getProfile(id, withMine);
  assert.equal(listed.kind, 'mine');
  assert.equal(listed.flag, 'de');

  const edited = profiles.update(id, { whisperLanguage: 'en' }, withMine, { label: 'Acme', flag: 'us' });
  assert.equal(edited.myProfiles[0].label, 'Acme');
  assert.equal(edited.myProfiles[0].values.whisperLanguage, 'en');
  assert.equal(edited.myProfiles[0].values.whisperModel, 'medium');

  // Edits made while it is active land in it, like a built-in.
  const remembered = profiles.recordEdit(id, { folderNamePrefix: 'Acme' }, { ...withMine, folderNamePrefix: 'Acme' });
  assert.equal(remembered.myProfiles[0].values.folderNamePrefix, 'Acme');

  const removed = profiles.remove(id, withMine);
  assert.deepEqual(removed.myProfiles, []);
  assert.equal(removed.activeProfile, '');
});

test('names must be new and built-ins cannot be deleted', () => {
  assert.throws(() => profiles.create({ label: 'English', values: {} }, {}), /already exists/);
  assert.throws(() => profiles.create({ label: '   ', values: {} }, {}), /name/);
  assert.throws(() => profiles.remove('english', {}), /cannot be deleted/);
  assert.throws(() => profiles.update(profiles.NONE_ID, {}, {}), /cannot be changed/);
  const second = profiles.create({ label: 'Acme!', values: {} }, { myProfiles: [{ id: 'my-acme', label: 'Acme 1', values: {} }] });
  assert.equal(second.id, 'my-acme-2');
});

test('reset drops stored edits; unknown profile throws', () => {
  assert.deepEqual(profiles.reset('german', { profiles: { german: { folderNamePrefix: 'x' } } }), { profiles: {} });
  assert.throws(() => profiles.select('nope', {}, {}), /Unknown profile/);
});

test('folder prefix is made safe for Windows paths', () => {
  assert.equal(profiles.sanitizeFolderPrefix('  My: Calls/2026? '), 'My Calls2026');
  assert.equal(profiles.sanitizeFolderPrefix('..'), '');
  assert.equal(profiles.sanitizeFolderPrefix('x'.repeat(100)).length, 40);
  assert.equal(profiles.meetingFolderName('English', '2026-01-02_10-30'), 'English_2026-01-02_10-30');
  assert.equal(profiles.meetingFolderName('', '2026-01-02_10-30'), '2026-01-02_10-30');
});
