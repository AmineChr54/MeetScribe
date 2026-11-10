/**
 * The settings the browser manager may show and change, with their types and
 * limits. Pure: the server validates every change against this list, and the
 * page builds its form from it.
 *
 * Deliberately left out, so they can only be changed in the app itself:
 *   - whisperPython: which executable the app runs;
 *   - transcriptRoot: the folder the library reads and deletes in;
 *   - audio devices: they are enumerated by the app's capture window;
 *   - profiles/activeProfile: they have their own actions.
 * A page in a browser tab should not be able to point either of the first two
 * somewhere else.
 */

const glossaries = require('./glossaries');

const LANGUAGES = [
  ['auto', 'Detect automatically'], ['en', 'English'], ['de', 'German'], ['fr', 'French'], ['es', 'Spanish'],
  ['it', 'Italian'], ['nl', 'Dutch'], ['pt', 'Portuguese'], ['pl', 'Polish'], ['tr', 'Turkish'], ['ru', 'Russian'],
  ['ar', 'Arabic'], ['uk', 'Ukrainian'], ['zh', 'Chinese'], ['ja', 'Japanese'], ['ko', 'Korean'], ['hi', 'Hindi']
];
const options = (pairs) => pairs.map(([value, label]) => ({ value, label }));

const SECTIONS = [
  {
    id: 'recording',
    title: 'Recording',
    fields: [
      { key: 'folderNamePrefix', type: 'text', max: 40, label: 'Meeting folder name', help: 'Put in front of the date of every new meeting folder.' },
      { key: 'showTranscriptOnRecord', type: 'bool', label: 'Show the transcript panel when recording starts' },
      { key: 'autoStartRecording', type: 'bool', label: 'Start recording when the app starts' },
      { key: 'reorderWindowMs', type: 'number', min: 0, max: 5000, step: 100, label: 'Reorder window (ms)', help: 'How long a line waits so the other side can slot in before it.' },
      { key: 'labelSystem', type: 'text', max: 40, label: 'Label for system audio' },
      { key: 'labelMic', type: 'text', max: 40, label: 'Label for the microphone' }
    ]
  },
  {
    id: 'audio',
    title: 'Audio',
    fields: [
      { key: 'systemEnabled', type: 'bool', label: 'Record system audio (the other side)' },
      { key: 'micEnabled', type: 'bool', label: 'Record the microphone (you)' },
      { key: 'echoSuppress', type: 'bool', label: 'Drop microphone lines that are the speakers echoing' },
      { key: 'echoSimilarity', type: 'number', min: 0.5, max: 1, step: 0.05, label: 'Echo similarity' }
    ]
  },
  {
    id: 'live',
    title: 'Live transcript',
    fields: [
      { key: 'liveTranscription', type: 'bool', label: 'Transcribe live while recording' },
      { key: 'whisperModel', type: 'model', role: 'live', label: 'Live model' },
      { key: 'whisperLanguage', type: 'select', options: options(LANGUAGES), label: 'Language' },
      { key: 'whisperDevice', type: 'select', options: options([['auto', 'Auto'], ['cpu', 'CPU'], ['cuda', 'CUDA (NVIDIA)']]), label: 'Device' },
      { key: 'whisperComputeType', type: 'select', options: options([['auto', 'Auto'], ['int8', 'int8'], ['int8_float16', 'int8_float16'], ['float16', 'float16'], ['float32', 'float32']]), label: 'Compute type' },
      { key: 'whisperWorkerCount', type: 'number', min: 1, max: 4, step: 1, label: 'Workers' },
      { key: 'silenceHangoverMs', type: 'number', min: 200, max: 3000, step: 50, label: 'Silence that ends a line (ms)' },
      { key: 'maxUtteranceMs', type: 'number', min: 3000, max: 30000, step: 1000, label: 'Longest line (ms)' },
      { key: 'vadEnergyFloor', type: 'number', min: 0.001, max: 0.1, step: 0.001, label: 'Speech energy floor' },
      { key: 'glossarySet', type: 'glossaries', label: 'Project glossaries', help: 'Copied into each new meeting, before the terms below. Manage them on the Glossaries page.' },
      { key: 'glossary', type: 'textarea', max: 65536, label: 'Other glossary terms', help: 'Names and jargon, one per line or comma separated. "#" lines are notes, ">" lines are context for the model. Copied into each new meeting.' }
    ]
  },
  {
    id: 'final',
    title: 'Final pass',
    fields: [
      { key: 'offlinePassEnabled', type: 'bool', label: 'Run the final pass after every meeting' },
      { key: 'archiveAudio', type: 'bool', label: 'Keep the audio of each meeting' },
      { key: 'archiveFormat', type: 'select', options: options([['flac', 'FLAC: lossless, about half the size'], ['wav', 'WAV: no transcode step'], ['none', 'Delete once the final pass has run']]), label: 'Audio format' },
      { key: 'offlineModel', type: 'model', role: 'final', label: 'Final model' },
      { key: 'offlineDiffModel', type: 'model', role: 'final', optional: true, label: 'Cross-check model', help: 'A second model; where the two disagree the transcript marks it.' },
      { key: 'offlineMode', type: 'select', options: options([['fast', 'Fast: batched decode'], ['quality', 'Quality: sequential, with context']]), label: 'Mode' },
      { key: 'offlineBeamSize', type: 'number', min: 1, max: 10, step: 1, label: 'Beam size' },
      { key: 'offlineCpuThreads', type: 'number', min: 0, max: 64, step: 1, label: 'CPU threads (0 = automatic)' },
      { key: 'offlineWordConfidence', type: 'number', min: 0, max: 0.9, step: 0.05, label: 'Mark words below this confidence' }
    ]
  },
  {
    id: 'appearance',
    title: 'Appearance and app',
    fields: [
      { key: 'transcriptFontSize', type: 'number', min: 10, max: 22, step: 1, label: 'Transcript font size' },
      { key: 'windowGap', type: 'number', min: 0, max: 80, step: 1, label: 'Gap between the overlay windows' },
      { key: 'startClickThrough', type: 'bool', label: 'Start with click-through on' },
      { key: 'autoUpdate', type: 'bool', label: 'Install updates automatically' }
    ]
  }
];

const FIELDS = new Map(SECTIONS.flatMap((section) => section.fields.map((field) => [field.key, field])));
const MODEL_ID = /^[\w.\-/]{1,120}$/;

/** Only the schema's keys, from the full settings object. */
function visibleValues(settings) {
  const out = {};
  for (const key of FIELDS.keys()) if (settings && settings[key] !== undefined) out[key] = settings[key];
  return out;
}

/**
 * Check a change from the page.
 * @returns {{ patch: object, errors: string[] }} patch holds only valid, known keys
 */
function validatePatch(raw) {
  const patch = {};
  const errors = [];
  for (const [key, value] of Object.entries(raw || {})) {
    const field = FIELDS.get(key);
    if (!field) {
      errors.push(`${key} cannot be changed here`);
      continue;
    }
    switch (field.type) {
      case 'bool':
        if (typeof value !== 'boolean') errors.push(`${field.label}: expected on or off`);
        else patch[key] = value;
        break;
      case 'number': {
        const number = Number(value);
        if (value === '' || value === null || !Number.isFinite(number) || number < field.min || number > field.max) {
          errors.push(`${field.label}: between ${field.min} and ${field.max}`);
        } else {
          patch[key] = number;
        }
        break;
      }
      case 'select':
        if (!field.options.some((option) => option.value === value)) errors.push(`${field.label}: not one of the choices`);
        else patch[key] = value;
        break;
      case 'model':
        if ((field.optional && value === '') || (typeof value === 'string' && MODEL_ID.test(value))) patch[key] = value;
        else errors.push(`${field.label}: not a model name`);
        break;
      case 'glossaries':
        if (!Array.isArray(value) || value.length > 50) errors.push(`${field.label}: expected a list of glossary names`);
        else patch[key] = glossaries.cleanSet(value);
        break;
      case 'text':
      case 'textarea': {
        const text = String(value === null || value === undefined ? '' : value);
        if (text.length > field.max) errors.push(`${field.label}: too long`);
        else patch[key] = field.type === 'text' ? text.replace(/[\r\n]+/g, ' ').trim() : text;
        break;
      }
      default:
        errors.push(`${key} cannot be changed here`);
    }
  }
  return { patch, errors };
}

/** The schema as the page needs it (no functions, plain JSON). */
function describe() {
  return SECTIONS;
}

module.exports = { SECTIONS, LANGUAGES, visibleValues, validatePatch, describe };
