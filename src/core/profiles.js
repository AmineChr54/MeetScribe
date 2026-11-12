/**
 * Profiles: named sets of settings the user picks with one click.
 *
 * A profile only covers the keys in PROFILE_KEYS. There are three kinds:
 *   - "No profile" (id NONE_ID): the shipped defaults. Picking it resets the
 *     profile keys to those defaults, and edits made while it is active are not
 *     remembered anywhere but the settings themselves.
 *   - Built-ins (BUILTIN): whatever the user changes while one is active is
 *     written back into it (settings.profiles[id]), so each remembers its own
 *     values; "Reset" drops those edits.
 *   - The user's own (settings.myProfiles): made from the current settings or
 *     as a copy of another profile, renamed, edited and deleted freely.
 *
 * Built-ins hold no glossary text: a glossary is the user's own content and
 * only ever lives in their settings. So picking one leaves the current
 * glossary alone unless that profile has stored one of its own.
 *
 * Nothing in this file touches Electron or the disk. Functions that change
 * something return a settings patch for the store.
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
  'glossary',
  'glossarySet'
];

const NONE_ID = 'none';
const MY_PREFIX = 'my-';
const MAX_MY_PROFILES = 50;
const FLAG_CHOICES = ['us', 'gb', 'de', 'tn', 'fr', 'es', 'custom'];

const BASE = {
  liveTranscription: true,
  offlinePassEnabled: true,
  archiveAudio: true,
  showTranscriptOnRecord: true
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
    summary: 'small live, German turbo final',
    values: {
      ...BASE,
      // Not the German tiny fine-tune: against the final pass it got most
      // words wrong, small gets about a third wrong and still keeps up live.
      whisperModel: 'small',
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
      whisperModel: 'small',
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

const isMine = (id) => String(id || '').startsWith(MY_PREFIX);
const myList = (settings) => (Array.isArray(settings && settings.myProfiles) ? settings.myProfiles : [])
  .filter((profile) => profile && isMine(profile.id) && typeof profile.label === 'string');

function cleanLabel(value) {
  return String(value || '').replace(/[\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
}

function cleanFlag(value) {
  return FLAG_CHOICES.includes(value) ? value : 'custom';
}

/** One line for a card: which models a profile uses. */
function summaryOf(values) {
  const live = values.liveTranscription === false ? 'no live transcript' : `${values.whisperModel || '?'} live`;
  const final = values.offlinePassEnabled === false ? 'no final pass' : `${values.offlineModel || '?'} final`;
  return `${live}, ${final}`;
}

/**
 * Every profile the pickers show, "No profile" first, each with its effective
 * values. `defaults` are the shipped settings (what "No profile" stands for).
 * @param {object} settings  the full settings object (profiles, myProfiles)
 * @param {object} defaults  settings-store defaults
 */
function listProfiles(settings = {}, defaults = {}) {
  const stored = (settings && settings.profiles) || {};
  const none = {
    id: NONE_ID,
    label: 'No profile',
    flag: 'none',
    summary: 'The default multilingual settings; change anything you like',
    values: { ...pick(defaults), glossarySet: [] },
    kind: 'none',
    edited: false
  };
  const builtins = BUILTIN.map((profile) => ({
    ...profile,
    values: { ...profile.values, ...pick(stored[profile.id]) },
    kind: 'builtin',
    edited: Boolean(stored[profile.id])
  }));
  const mine = myList(settings).map((profile) => {
    const values = pick(profile.values);
    return {
      id: profile.id,
      label: profile.label,
      flag: cleanFlag(profile.flag),
      summary: summaryOf(values),
      values,
      kind: 'mine',
      edited: false
    };
  });
  return [none, ...builtins, ...mine];
}

function getProfile(id, settings = {}, defaults = {}) {
  return listProfiles(settings, defaults).find((profile) => profile.id === id) || null;
}

/** The active profile id as the pickers know it: '' (never picked) is "No profile". */
function activeId(settings) {
  const id = settings && settings.activeProfile;
  return id && getProfile(id, settings) ? id : NONE_ID;
}

/**
 * The settings patch for picking a profile.
 *
 * "No profile" puts the profile keys back to the shipped defaults, except the
 * glossary text: that is the user's own writing and is never thrown away by a
 * click. Its project glossaries are unticked, though.
 */
function select(id, settings = {}, defaults = {}) {
  const profile = getProfile(id, settings, defaults);
  if (!profile) throw new Error('Unknown profile: ' + id);
  if (profile.kind === 'none') {
    const values = { ...profile.values };
    delete values.glossary;
    return { patch: { ...values, activeProfile: '' } };
  }
  return { patch: { ...profile.values, activeProfile: id } };
}

/**
 * Copy edits made while a profile is active into that profile.
 * @returns {object|null} a settings patch, or null when nothing is remembered
 */
function recordEdit(active, patch, settings = {}) {
  if (!active || active === NONE_ID || !patch || !PROFILE_KEYS.some((key) => key in patch)) return null;
  // Picking a profile writes its own values; that is not an edit of it.
  if ('activeProfile' in patch || 'profiles' in patch || 'myProfiles' in patch) return null;
  return update(active, pick(settings), settings, { quiet: true });
}

/**
 * Change a profile directly (the browser manager's editor), whether or not it
 * is the active one. Only profile keys are kept; the user's own profiles can
 * also be renamed and given another flag.
 * @returns {object|null} a settings patch
 */
function update(id, values, settings = {}, { label, flag, quiet = false } = {}) {
  if (id === NONE_ID) {
    if (quiet) return null;
    throw new Error('"No profile" cannot be changed; save the settings as a new profile instead');
  }
  if (isMine(id)) {
    const list = myList(settings);
    const index = list.findIndex((profile) => profile.id === id);
    if (index < 0) {
      if (quiet) return null;
      throw new Error('Unknown profile: ' + id);
    }
    const current = list[index];
    const next = { ...current, values: { ...pick(current.values), ...pick(values) } };
    if (label !== undefined) {
      next.label = cleanLabel(label);
      if (!next.label) throw new Error('Give the profile a name');
    }
    if (flag !== undefined) next.flag = cleanFlag(flag);
    const myProfiles = list.slice();
    myProfiles[index] = next;
    return { myProfiles };
  }
  if (!BUILTIN.some((profile) => profile.id === id)) {
    if (quiet) return null;
    throw new Error('Unknown profile: ' + id);
  }
  const stored = (settings && settings.profiles) || {};
  return { profiles: { ...stored, [id]: { ...pick(stored[id]), ...pick(values) } } };
}

/** A short id that is not taken yet: "my-acme", "my-acme-2", … */
function newId(label, taken) {
  const slug = label.toLowerCase().normalize('NFKD').replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'profile';
  let id = MY_PREFIX + slug;
  for (let n = 2; taken.has(id); n++) id = `${MY_PREFIX}${slug}-${n}`;
  return id;
}

/**
 * A new profile of the user's own, from `values` (usually the current
 * settings, or a copy of another profile).
 * @returns {{ id: string, patch: object }}
 */
function create({ label, flag, values }, settings = {}) {
  const clean = cleanLabel(label);
  if (!clean) throw new Error('Give the profile a name');
  const list = myList(settings);
  if (list.length >= MAX_MY_PROFILES) throw new Error('That is a lot of profiles; delete one first');
  const all = listProfiles(settings);
  if (all.some((profile) => profile.label.toLowerCase() === clean.toLowerCase())) throw new Error('A profile with that name already exists');
  const id = newId(clean, new Set(all.map((profile) => profile.id)));
  return { id, patch: { myProfiles: list.concat({ id, label: clean, flag: cleanFlag(flag), values: pick(values) }) } };
}

/** Delete one of the user's own profiles; deleting the active one leaves "No profile" active (values unchanged). */
function remove(id, settings = {}) {
  if (!isMine(id)) throw new Error('Built-in profiles cannot be deleted; reset them instead');
  const list = myList(settings);
  if (!list.some((profile) => profile.id === id)) throw new Error('Unknown profile: ' + id);
  const patch = { myProfiles: list.filter((profile) => profile.id !== id) };
  if (settings.activeProfile === id) patch.activeProfile = '';
  return patch;
}

/** A built-in back to its shipped values. */
function reset(id, settings = {}) {
  if (!BUILTIN.some((profile) => profile.id === id)) throw new Error('Only built-in profiles can be reset');
  const profiles = { ...((settings && settings.profiles) || {}) };
  delete profiles[id];
  return { profiles };
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
  NONE_ID,
  FLAG_CHOICES,
  BUILTIN,
  pick,
  listProfiles,
  getProfile,
  activeId,
  select,
  recordEdit,
  update,
  create,
  remove,
  reset,
  sanitizeFolderPrefix,
  meetingFolderName
};
