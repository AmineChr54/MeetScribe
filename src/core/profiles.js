/**
 * Profiles: named sets of settings the user picks with one click.
 *
 * A profile only covers the keys in PROFILE_KEYS. Built-ins live here; whatever
 * the user changes while a profile is active is written back into that
 * profile (stored under settings.profiles), so each profile remembers its own
 * values. Nothing in this file touches Electron or the disk.
 *
 * Built-ins hold no glossary: a glossary is the user's own content and only
 * ever lives in their settings.
 */

const PROFILE_KEYS = [
  'liveTranscription',
  'whisperModel',
  'whisperLanguage',
  'offlineModel',
  'offlinePassEnabled',
  'archiveAudio',
  'showTranscriptOnRecord',
  'folderNamePrefix',
  'glossary'
];

const CUSTOM_ID = 'custom';

const BASE = {
  liveTranscription: true,
  offlinePassEnabled: true,
  archiveAudio: true,
  showTranscriptOnRecord: true,
  glossary: ''
};

const BUILTIN = [
  {
    id: 'english',
    label: 'English',
    flag: 'us',
    summary: 'small.en live, large-v3-turbo final',
    values: {
      ...BASE,
      whisperModel: 'small.en',
      whisperLanguage: 'en',
      offlineModel: 'large-v3-turbo',
      folderNamePrefix: 'English'
    }
  },
  {
    id: 'german',
    label: 'German',
    flag: 'de',
    summary: 'German tiny live, German turbo final',
    values: {
      ...BASE,
      whisperModel: 'scheidti/whisper-tiny-german-1224-ct2',
      whisperLanguage: 'de',
      offlineModel: 'cstr/whisper-large-v3-turbo-german-int8_float32',
      folderNamePrefix: 'German'
    }
  },
  {
    id: 'german-work',
    label: 'German · Work',
    flag: 'de',
    summary: 'German, with your own glossary',
    values: {
      ...BASE,
      whisperModel: 'scheidti/whisper-tiny-german-1224-ct2',
      whisperLanguage: 'de',
      offlineModel: 'cstr/whisper-large-v3-turbo-german-int8_float32',
      folderNamePrefix: 'Work'
    }
  },
  {
    id: 'tunisian',
    label: 'Tunisian',
    flag: 'tn',
    summary: 'Final pass only, Tunisian model',
    values: {
      ...BASE,
      liveTranscription: false,
      showTranscriptOnRecord: false,
      whisperModel: 'small',
      whisperLanguage: 'ar',
      offlineModel: 'medyas/FarukSTT',
      folderNamePrefix: 'Tunisian'
    }
  }
];

/** Only the profile-controlled keys of a settings object. */
function pick(settings) {
  const out = {};
  for (const key of PROFILE_KEYS) {
    if (settings && settings[key] !== undefined) out[key] = settings[key];
  }
  return out;
}

/**
 * All profiles the picker shows, each with its effective values (the built-in
 * overlaid with what the user stored). "My settings" appears only once it holds
 * a snapshot of the settings from before the first profile was picked.
 */
function listProfiles(stored = {}) {
  const profiles = BUILTIN.map((profile) => ({
    ...profile,
    values: { ...profile.values, ...pick(stored[profile.id]) },
    edited: Boolean(stored[profile.id])
  }));
  if (stored[CUSTOM_ID]) {
    profiles.push({
      id: CUSTOM_ID,
      label: 'My settings',
      flag: 'custom',
      summary: 'What you had before profiles',
      values: pick(stored[CUSTOM_ID]),
      edited: true
    });
  }
  return profiles;
}

function getProfile(id, stored = {}) {
  return listProfiles(stored).find((profile) => profile.id === id) || null;
}

/**
 * The settings patch for picking a profile. Picking from "no profile" first
 * snapshots the current values as "My settings" so nothing is lost.
 * @returns {{ patch: object, profiles: object }} patch for the settings store
 */
function select(id, settings, stored = {}) {
  const profile = getProfile(id, stored);
  if (!profile) throw new Error('Unknown profile: ' + id);

  const profiles = { ...stored };
  if (!settings.activeProfile && !profiles[CUSTOM_ID]) profiles[CUSTOM_ID] = pick(settings);
  return { patch: { ...profile.values, activeProfile: id, profiles }, profiles };
}

/** Copy edits made while a profile is active into that profile. */
function recordEdit(activeId, patch, settings, stored = {}) {
  if (!activeId || !patch || !PROFILE_KEYS.some((key) => key in patch)) return stored;
  if (!getProfile(activeId, stored)) return stored;
  return { ...stored, [activeId]: { ...pick(stored[activeId]), ...pick(settings) } };
}

/** Back to the built-in values. "My settings" has no built-in, so it is left alone. */
function reset(id, stored = {}) {
  const profiles = { ...stored };
  if (id !== CUSTOM_ID) delete profiles[id];
  return profiles;
}

/** A name that is safe as the start of a Windows folder name. */
function sanitizeFolderPrefix(value) {
  return String(value || '')
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 40);
}

/** "<prefix>_<base>" when a prefix is set, otherwise just the date-time base. */
function meetingFolderName(prefix, base) {
  const clean = sanitizeFolderPrefix(prefix);
  return clean ? `${clean}_${base}` : base;
}

module.exports = {
  PROFILE_KEYS,
  CUSTOM_ID,
  BUILTIN,
  pick,
  listProfiles,
  getProfile,
  select,
  recordEdit,
  reset,
  sanitizeFolderPrefix,
  meetingFolderName
};
