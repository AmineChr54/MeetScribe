const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { spawn } = require('child_process');
const logger = require('../core/logger').createServiceLogger('MODELS');

/**
 * The models Settings offers. `id` is what the settings store and what
 * WhisperModel() receives; `repo` is where it lives on Hugging Face (mirrors
 * faster-whisper's own alias map in faster_whisper/utils.py). Custom ids
 * typed by the user are any CTranslate2 repo and resolve to themselves.
 *
 * `speed` is the fast-mode prior for the time estimate: decode seconds per
 * second of speech, measured on a 12-core laptop CPU (int8, 12 threads, beam 2,
 * batch 8) over 10 minutes of German speech. The two large-v3 entries are not
 * measured yet and are a rough guess (32 decoder layers against turbo's 4);
 * real passes replace every prior (speed-stats.service.js).
 *
 * `convert: true` marks a repo published only as Transformers weights. Download
 * fetches and converts it to CTranslate2 (scripts/convert_ct2.py) into
 * <modelDir>/converted/<repo with -- for />, which the Python workers look at
 * before asking faster-whisper to fetch the name from Hugging Face.
 */
const CATALOG = [
  { id: 'tiny', repo: 'Systran/faster-whisper-tiny', label: 'tiny', sizeMb: 75,
    note: 'Multilingual · live only: too inaccurate for a final pass', speed: 0.08, loadSec: 1, roles: ['live'], category: 'live' },
  { id: 'base', repo: 'Systran/faster-whisper-base', label: 'base', sizeMb: 145,
    note: 'Multilingual', speed: 0.1, loadSec: 1, roles: ['live'], category: 'live' },
  { id: 'small', repo: 'Systran/faster-whisper-small', label: 'small', sizeMb: 465,
    note: 'Multilingual · recommended for live', speed: 0.142, loadSec: 5, roles: ['live', 'final'], category: 'live' },
  { id: 'small.en', repo: 'Systran/faster-whisper-small.en', label: 'small.en', sizeMb: 465,
    note: 'English only · recommended for live English', speed: 0.142, loadSec: 5, roles: ['live'], category: 'live' },
  { id: 'scheidti/whisper-tiny-german-1224-ct2', repo: 'scheidti/whisper-tiny-german-1224-ct2',
    label: 'German tiny', sizeMb: 75, note: 'German fine-tune of tiny (primeline) · fast, made for live',
    speed: 0.08, loadSec: 1, roles: ['live'], category: 'live' },
  { id: 'mkenfenheuer/whisper-small-cv11-german-ct2', repo: 'mkenfenheuer/whisper-small-cv11-german-ct2',
    label: 'German small', sizeMb: 484, note: 'German fine-tune of small (Common Voice 11) · German only, no English words',
    speed: 0.142, loadSec: 5, roles: ['live'], category: 'live' },
  { id: 'medium', repo: 'Systran/faster-whisper-medium', label: 'medium', sizeMb: 1530,
    note: 'Multilingual', speed: 0.313, loadSec: 8, roles: ['live', 'final'], category: 'final' },
  { id: 'large-v3-turbo', repo: 'mobiuslabsgmbh/faster-whisper-large-v3-turbo', label: 'large-v3-turbo', sizeMb: 1620,
    note: 'Multilingual · recommended final pass', speed: 0.248, loadSec: 10, roles: ['live', 'final'], category: 'final' },
  { id: 'cstr/whisper-large-v3-turbo-german-int8_float32', repo: 'cstr/whisper-large-v3-turbo-german-int8_float32',
    label: 'German turbo', sizeMb: 815, note: 'German fine-tune of large-v3-turbo (primeline)',
    speed: 0.241, loadSec: 5, roles: ['final'], category: 'final' },
  { id: 'large-v3', repo: 'Systran/faster-whisper-large-v3', label: 'large-v3', sizeMb: 3090,
    note: 'Multilingual · slowest, most accurate', speed: 0.7, loadSec: 15, roles: ['final'], category: 'final' },
  { id: 'tnfru/whisper-large-v3-german-ct2', repo: 'tnfru/whisper-large-v3-german-ct2', label: 'German large-v3',
    sizeMb: 3090, note: 'German fine-tune of large-v3 (primeline) · slow', speed: 0.7, loadSec: 15, roles: ['final'], category: 'final' },
  { id: 'medyas/FarukSTT', repo: 'medyas/FarukSTT', label: 'Tunisian large-v3',
    sizeMb: 3090, note: 'Tunisian Arabic (Derja) fine-tune of large-v3 (FarukSTT) · converted on download, slow',
    speed: 0.7, loadSec: 15, roles: ['final'], category: 'final', convert: true }
];

const ALIASES = { turbo: 'large-v3-turbo', large: 'large-v3' };

function catalogEntry(id) {
  const key = ALIASES[id] || id;
  return CATALOG.find((entry) => entry.id === key || entry.repo === key) || null;
}

function repoFor(id) {
  if (!id) return null;
  const entry = catalogEntry(id);
  if (entry) return entry.repo;
  return id.includes('/') ? id : null;
}

// Models the user added from Hugging Face themselves: which list they belong
// in and whether they were converted. Kept next to the models.
const CUSTOM_FILE = 'meetscribe-models.json';
// owner/name; neither part may start with a dot (no ".." in a path).
const REPO_ID = /^\w[\w.-]{0,95}\/\w[\w.-]{0,95}$/;

function readCustom(modelDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(modelDir, CUSTOM_FILE), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function writeCustom(modelDir, custom) {
  fs.mkdirSync(modelDir, { recursive: true });
  const file = path.join(modelDir, CUSTOM_FILE);
  fs.writeFileSync(file + '.tmp', JSON.stringify(custom, null, 2));
  fs.renameSync(file + '.tmp', file);
}

/** Small models are fast enough for the live transcript; everything else is for the final pass. */
function guessCategory(repo) {
  const name = String(repo || '').split('/').pop();
  return /(^|[^a-z])(tiny|base|small)([^a-z]|$)/i.test(name) ? 'live' : 'final';
}

/** Rough download size from the model's name, for the progress bar. */
function guessSizeMb(repo) {
  const name = String(repo || '').toLowerCase();
  if (/tiny/.test(name)) return 75;
  if (/base/.test(name)) return 145;
  if (/small/.test(name)) return 485;
  if (/medium/.test(name)) return 1530;
  if (/turbo/.test(name)) return 1620;
  if (/large|distil/.test(name)) return 3090;
  return 0;
}

/**
 * Hugging Face search results (api/models?full=true) as rows for the model
 * browser: only Whisper models that faster-whisper can load (CTranslate2, a
 * model.bin) or that the converter can turn into one (Transformers weights).
 */
function hubResults(json) {
  const rows = [];
  for (const model of Array.isArray(json) ? json : []) {
    const id = String(model.id || model.modelId || '');
    if (!REPO_ID.test(id)) continue;
    const files = (model.siblings || []).map((file) => file.rfilename);
    const tags = (model.tags || []).map(String);
    if (!/whisper/i.test(id) && !tags.includes('whisper') && !tags.includes('faster-whisper')) continue;
    let format = null;
    if (files.includes('model.bin') && !files.includes('pytorch_model.bin')) format = 'ct2';
    else if (files.includes('model.safetensors') || files.includes('pytorch_model.bin')) format = 'transformers';
    if (!format) continue;
    rows.push({
      repo: id,
      format,
      downloads: Number(model.downloads) || 0,
      likes: Number(model.likes) || 0,
      updated: model.lastModified || model.createdAt || null,
      languages: tags.filter((tag) => /^[a-z]{2,3}$/.test(tag)).slice(0, 6),
      category: guessCategory(id),
      sizeMb: guessSizeMb(id)
    });
  }
  return rows;
}

function dirFor(modelDir, repo, convert = false) {
  const slug = repo.replace(/\//g, '--');
  return convert ? path.join(modelDir, 'converted', slug) : path.join(modelDir, 'models--' + slug);
}

function sizeOf(dir) {
  let total = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += sizeOf(full);
    else {
      try { total += fs.statSync(full).size; } catch (_) { /* vanished mid-walk */ }
    }
  }
  return total;
}

/**
 * Complete means faster-whisper can load it offline: a snapshot holding the
 * weights and config, and no half-written blob from an interrupted download.
 */
function isComplete(dir, convert = false) {
  try {
    // A converted model is a plain folder; the converter renames it into place
    // only once model.bin is written.
    if (convert) return fs.existsSync(path.join(dir, 'model.bin')) && fs.existsSync(path.join(dir, 'config.json'));
    const blobs = path.join(dir, 'blobs');
    if (fs.existsSync(blobs) && fs.readdirSync(blobs).some((name) => name.endsWith('.incomplete'))) return false;
    const snapshots = path.join(dir, 'snapshots');
    return fs.readdirSync(snapshots).some((rev) =>
      fs.existsSync(path.join(snapshots, rev, 'model.bin')) && fs.existsSync(path.join(snapshots, rev, 'config.json'))
    );
  } catch (_) {
    return false;
  }
}

/**
 * What to spawn to fetch one model. A normal model goes through
 * faster-whisper's own downloader so the layout is exactly what WhisperModel()
 * looks for. A `convert` model runs scripts/convert_ct2.py instead, with the
 * Hugging Face cache pointed at `scratch` so the full-precision source weights
 * land there (and are deleted afterwards) rather than in the user's own cache.
 */
function downloadCommand({ repo, dir, convert, scratch, paths }) {
  if (!convert) {
    return {
      args: ['-c',
        'import sys\nfrom faster_whisper import download_model\ndownload_model(sys.argv[1], cache_dir=sys.argv[2])',
        repo, paths.modelDir],
      env: paths.env
    };
  }
  return {
    args: ['-u', paths.convertScript, repo, dir],
    env: { ...paths.env, HF_HUB_CACHE: scratch, TRANSFORMERS_CACHE: scratch }
  };
}

class ModelStore extends EventEmitter {
  constructor() {
    super();
    this.downloading = null;
  }

  /**
   * Every catalog model plus anything else found in the cache.
   * @param {string} modelDir
   * @param {object} inUse  { live, final, diff } model ids from settings
   */
  list(modelDir, inUse = {}) {
    const rows = CATALOG.map((entry) => ({ ...entry, custom: false }));
    const custom = readCustom(modelDir);
    const addCustom = (repo, convert) => {
      if (!REPO_ID.test(repo) || rows.some((row) => row.repo === repo)) return;
      const meta = custom[repo] || {};
      const category = meta.category === 'live' || meta.category === 'final' ? meta.category : guessCategory(repo);
      rows.push({ id: repo, repo, label: repo, sizeMb: meta.sizeMb || 0,
        note: convert ? 'Added from Hugging Face · converted to CTranslate2' : 'Added from Hugging Face',
        speed: 0.2, loadSec: 8, roles: ['live', 'final'], category, custom: true, convert: Boolean(convert) });
    };
    for (const [repo, meta] of Object.entries(custom)) addCustom(repo, meta && meta.convert);
    try {
      for (const name of fs.readdirSync(modelDir)) {
        if (name.startsWith('models--')) addCustom(name.slice('models--'.length).replace('--', '/'), false);
      }
    } catch (_) {
      // No cache yet: nothing downloaded.
    }
    try {
      for (const name of fs.readdirSync(path.join(modelDir, 'converted'))) {
        if (!name.endsWith('.partial')) addCustom(name.replace('--', '/'), true);
      }
    } catch (_) { /* nothing converted yet */ }

    return rows.map((row) => {
      const dir = dirFor(modelDir, row.repo, row.convert);
      const exists = fs.existsSync(dir);
      const downloading = this.downloading && this.downloading.repo === row.repo;
      return {
        ...row,
        downloaded: exists && !downloading && isComplete(dir, row.convert),
        downloading: Boolean(downloading),
        progress: downloading ? this.downloading.progress : 0,
        bytes: exists ? sizeOf(dir) : 0,
        inUse: ['live', 'final', 'diff'].filter((role) => inUse[role] && repoFor(inUse[role]) === row.repo)
      };
    });
  }

  /**
   * Fetch a model into the cache without loading it (see downloadCommand).
   * @param {string} id
   * @param {object} paths  { python, modelDir, convertScript, env } from transcriptionService.getPaths()
   */
  download(id, paths, options = {}) {
    const repo = repoFor(id);
    // Preconditions throw synchronously, so the caller can answer the click at
    // once; the download itself reports through 'progress' events.
    if (!repo) throw new Error('Unknown model: ' + id);
    if (this.downloading) throw new Error('Another model is downloading');
    if (!paths.python || !fs.existsSync(paths.python)) {
      throw new Error('The Whisper Python environment was not found');
    }

    const entry = catalogEntry(id);
    if (!entry && !REPO_ID.test(repo)) throw new Error('Not a Hugging Face model name: ' + id);
    let custom = null;
    if (!entry) {
      // Remembered before the download starts, so the model shows up in the
      // right list (as downloading) straight away.
      const all = readCustom(paths.modelDir);
      const known = all[repo] || {};
      custom = {
        convert: options.convert !== undefined ? Boolean(options.convert) : Boolean(known.convert),
        category: ['live', 'final'].includes(options.category) ? options.category : known.category || guessCategory(repo),
        sizeMb: known.sizeMb || guessSizeMb(repo)
      };
      all[repo] = custom;
      writeCustom(paths.modelDir, all);
    }
    const expected = ((entry ? entry.sizeMb : custom.sizeMb) || 0) * 1e6;
    const convert = entry ? Boolean(entry.convert) : custom.convert;
    const dir = dirFor(paths.modelDir, repo, convert);
    if (convert && (!paths.convertScript || !fs.existsSync(paths.convertScript))) {
      throw new Error('convert_ct2.py was not found');
    }
    // The converter downloads the original weights here and they are removed
    // afterwards, so the user's own Hugging Face cache does not gain ~6 GB.
    const scratch = path.join(paths.modelDir, '.convert-' + repo.replace(/\//g, '--'));
    fs.mkdirSync(paths.modelDir, { recursive: true });
    this.downloading = { repo, progress: 0 };
    this.emit('progress', { id, repo, state: 'downloading', progress: 0 });
    logger.info('Downloading model', { repo });
    const started = Date.now();

    return new Promise((resolve, reject) => {
      const command = downloadCommand({ repo, dir, convert, scratch, paths });
      const child = spawn(paths.python, command.args, {
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: command.env
      });

      // The converter reports on stdout and fails on stderr; the tail of both
      // is what explains a failure.
      const stderrTail = [];
      const keepTail = (chunk) => {
        const text = chunk.toString().trim();
        if (!text) return;
        stderrTail.push(text);
        while (stderrTail.length > 6) stderrTail.shift();
      };
      child.stdout.on('data', keepTail);
      child.stderr.on('data', keepTail);

      // The downloader prints a progress bar for a terminal; the size on disk
      // against the catalog size is simpler and good enough for a bar.
      const poll = setInterval(() => {
        if (!expected) return;
        // Conversion pulls the full-precision weights (about twice the final size).
        const onDisk = convert ? sizeOf(scratch) + sizeOf(dir + '.partial') : sizeOf(dir);
        const progress = Math.min(0.99, onDisk / (convert ? expected * 2 : expected));
        this.downloading.progress = progress;
        this.emit('progress', { id, repo, state: 'downloading', progress });
      }, 2000);

      const finish = (error) => {
        clearInterval(poll);
        this.downloading = null;
        if (convert) {
          fs.rmSync(scratch, { recursive: true, force: true });
          fs.rmSync(dir + '.partial', { recursive: true, force: true });
          // Left behind by builds that sent this repo through the plain
          // downloader: config files only, never loadable.
          fs.rmSync(dirFor(paths.modelDir, repo, false), { recursive: true, force: true });
        }
        if (error) {
          logger.error('Model download failed', { repo, error: error.message });
          this.emit('progress', { id, repo, state: 'failed', error: error.message });
          return reject(error);
        }
        logger.info('Model downloaded', { repo, seconds: Math.round((Date.now() - started) / 1000), bytes: sizeOf(dir) });
        this.emit('progress', { id, repo, state: 'done', progress: 1 });
        resolve({ ok: true, repo });
      };

      child.on('error', finish);
      child.on('close', (code) => {
        if (code === 0 && isComplete(dir, convert)) return finish(null);
        const detail = stderrTail.join(' | ').slice(-400);
        finish(new Error('Download failed' + (code ? ' (exit ' + code + ')' : '') + (detail ? ': ' + detail : '')));
      });
    });
  }

  /**
   * Search Hugging Face for Whisper models (the manager's model browser). Only
   * the typed query is sent; results are kept for five minutes.
   */
  async searchHub(query, fetchImpl = globalThis.fetch) {
    const q = String(query || '').trim().slice(0, 80);
    this.hubCache = this.hubCache || new Map();
    const cached = this.hubCache.get(q.toLowerCase());
    if (cached && Date.now() - cached.at < 5 * 60 * 1000) return cached.rows;
    const params = new URLSearchParams({
      search: !q ? 'whisper' : /whisper/i.test(q) ? q : 'whisper ' + q,
      pipeline_tag: 'automatic-speech-recognition',
      sort: 'downloads',
      direction: '-1',
      limit: '60',
      full: 'true'
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    let response;
    try {
      response = await fetchImpl('https://huggingface.co/api/models?' + params.toString(), {
        signal: controller.signal,
        headers: { Accept: 'application/json' }
      });
    } catch (error) {
      throw new Error(error.name === 'AbortError' ? 'Hugging Face did not answer in time' : 'Could not reach Hugging Face');
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) throw new Error('Hugging Face answered ' + response.status);
    const rows = hubResults(await response.json());
    this.hubCache.set(q.toLowerCase(), { at: Date.now(), rows });
    return rows;
  }

  /**
   * @param {string} id
   * @param {string} modelDir
   * @param {object} busy  { recording, liveModel, finalRunning, finalModel, diffModel }
   */
  remove(id, modelDir, busy = {}) {
    const repo = repoFor(id);
    if (!repo) throw new Error('Unknown model: ' + id);
    if (this.downloading && this.downloading.repo === repo) throw new Error('This model is downloading');
    if (busy.recording && repoFor(busy.liveModel) === repo) {
      throw new Error('The live transcript is using this model; stop recording first');
    }
    if (busy.finalRunning && [busy.finalModel, busy.diffModel].some((m) => repoFor(m) === repo)) {
      throw new Error('A final pass is using this model; wait for it to finish');
    }

    const entry = catalogEntry(id);
    const custom = readCustom(modelDir);
    const convert = entry ? Boolean(entry.convert) : Boolean(custom[repo] && custom[repo].convert);
    const dir = dirFor(modelDir, repo, convert);
    if (!entry && custom[repo]) {
      delete custom[repo];
      writeCustom(modelDir, custom);
    }
    if (!fs.existsSync(dir)) return { ok: true, freed: 0 };
    const freed = sizeOf(dir);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      const busyFile = error.code === 'EBUSY' || error.code === 'EPERM';
      logger.warn('Could not delete model', { repo, code: error.code });
      throw new Error(busyFile ? 'The model is still loaded; try again once the app is idle' : error.message);
    }
    logger.info('Deleted model', { repo, bytes: freed });
    return { ok: true, freed };
  }
}

module.exports = new ModelStore();
module.exports.CATALOG = CATALOG;
module.exports.catalogEntry = catalogEntry;
module.exports.repoFor = repoFor;
module.exports.downloadCommand = downloadCommand;
module.exports.hubResults = hubResults;
module.exports.guessCategory = guessCategory;
module.exports.ModelStore = ModelStore;
