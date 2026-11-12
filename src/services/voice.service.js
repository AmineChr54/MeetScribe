const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const readline = require('readline');
const EventEmitter = require('events');
const { spawn } = require('child_process');
const settingsStore = require('../core/settings.store');
const { SpeakerTracker, average, consistency } = require('../core/speaker-tracker');
const { pcmToWav, rmsOf } = require('../core/wav');
const logger = require('../core/logger').createServiceLogger('VOICE');

// 3D-Speaker ERes2Net trained on VoxCeleb. Chosen over the WeSpeaker CAM++ model
// this feature first shipped with, which could not tell short clips of
// different people apart; this one separated owner and strangers on 99-100%
// of 1.5-6 s utterances in a test on public speech (Mini LibriSpeech).
const MODEL_FILE = '3dspeaker_speech_eres2net_sv_en_voxceleb_16k.onnx';
const MODEL_URL =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/' +
  encodeURIComponent(MODEL_FILE);
const MODEL_MIN_BYTES = 20e6;

const SAMPLE_RATE = 16000;
const CLIP_BYTES = 3 * SAMPLE_RATE * 2; // enrollment is cut into 3 s clips
const MIN_CLIPS = 4;
const SPEECH_RMS = 0.01; // a clip quieter than this is silence, not a voice
// Every clip must resemble the average of the *other* clips at least this much.
// One clean voice scored 0.65 or more in testing, a recording that switched
// voices halfway about 0.45.
const CLIP_CONSISTENCY = 0.5;
const MIN_UTTERANCE_MS = 1500; // shorter clips give unstable embeddings (15% missed at 1 s)
const CARRY_LABEL_MS = 6000; // a too-short utterance keeps the previous label for this long
const REQUEST_TIMEOUT_MS = 15000;

/**
 * Optional "You / Other n" labels from speaker embeddings (sherpa-onnx in a
 * small Python worker). Everything is local, and all of it is opt-in: the
 * dependency and model are only fetched when the user sets it up. Only the
 * averaged voiceprint is stored, never audio.
 */
class VoiceService extends EventEmitter {
  constructor() {
    super();
    this.paths = null;
    this.process = null;
    this.pending = new Map();
    this.sequence = 0;
    this.loaded = false;
    this.tracker = null;
    this.lastLabel = null;
    this.lastAt = 0;
    this.enrollmentChunks = null;
    this.busy = false;
    // Result of the last "is sherpa-onnx installed" probe; null = not asked yet.
    this.packageReady = null;
  }

  configure(paths) {
    this.paths = paths;
  }

  // ── Files ──

  voiceprintFile() {
    return settingsStore.userDataFile('voiceprint.json');
  }

  modelPath() {
    return this.paths ? path.join(this.paths.modelDir, 'voice', MODEL_FILE) : null;
  }

  loadVoiceprint() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.voiceprintFile(), 'utf8'));
      // A voiceprint is only comparable with embeddings from the model that made it.
      if (parsed.model !== MODEL_FILE) return null;
      return Array.isArray(parsed.embedding) && parsed.embedding.length ? parsed : null;
    } catch (_) {
      return null;
    }
  }

  deleteVoiceprint() {
    fs.rmSync(this.voiceprintFile(), { force: true });
    this.tracker = null;
    return { ok: true };
  }

  // ── Status / setup ──

  /**
   * Is sherpa-onnx importable? Asked every time Settings opens, so it must not
   * block the main process: the probe runs async and a positive answer is kept
   * (the package does not uninstall itself; setup() re-asks after installing).
   */
  hasPackage() {
    if (!this.paths || !this.paths.python || !fs.existsSync(this.paths.python)) return Promise.resolve(false);
    if (this.packageReady) return Promise.resolve(true);
    return new Promise((resolve) => {
      const child = spawn(this.paths.python, ['-I', '-c', 'import sherpa_onnx'], {
        windowsHide: true,
        env: this.paths.env,
        stdio: 'ignore'
      });
      const timer = setTimeout(() => { try { child.kill(); } catch (_) { /* gone */ } }, 20000);
      const done = (ready) => {
        clearTimeout(timer);
        this.packageReady = ready;
        resolve(ready);
      };
      child.on('error', () => done(false));
      child.on('close', (code) => done(code === 0));
    });
  }

  /** Cheap, for callers that only need to know whether the mic is taken. */
  isEnrolling() {
    return Boolean(this.enrollmentChunks);
  }

  async status() {
    const voiceprint = this.loadVoiceprint();
    const model = this.modelPath();
    return {
      packageReady: await this.hasPackage(),
      modelReady: Boolean(model && fs.existsSync(model)),
      enrolled: Boolean(voiceprint),
      enrolledAt: voiceprint ? voiceprint.createdAt : null,
      enrolling: Boolean(this.enrollmentChunks),
      busy: this.busy
    };
  }

  /** Install sherpa-onnx into the Whisper venv and fetch the ~30 MB model. */
  async setup() {
    if (this.busy) throw new Error('Already working on it');
    if (!this.paths || !fs.existsSync(this.paths.python)) {
      throw new Error('Set up Whisper first (Transcription → Install / Repair Whisper)');
    }
    this.busy = true;
    try {
      if (!(await this.hasPackage())) {
        this.emit('progress', 'Installing sherpa-onnx…');
        await this._run(this.paths.python, ['-m', 'pip', 'install', '--upgrade', 'sherpa-onnx', '--disable-pip-version-check']);
        this.packageReady = null;
      }
      const model = this.modelPath();
      if (!fs.existsSync(model)) {
        this.emit('progress', 'Downloading the speaker model (~30 MB)…');
        fs.mkdirSync(path.dirname(model), { recursive: true });
        await this._download(MODEL_URL, model);
      }
      this.emit('progress', 'Ready.');
      return await this.status();
    } finally {
      this.busy = false;
    }
  }

  _run(command, args) {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { windowsHide: true, env: this.paths.env, stdio: ['ignore', 'pipe', 'pipe'] });
      const tail = [];
      const forward = (chunk) => {
        for (const line of chunk.toString().split(/\r?\n/)) {
          if (!line.trim()) continue;
          tail.push(line);
          if (tail.length > 6) tail.shift();
          this.emit('progress', line.slice(0, 200));
        }
      };
      child.stdout.on('data', forward);
      child.stderr.on('data', forward);
      child.on('error', reject);
      child.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error(`pip exited with code ${code}: ${tail.join(' | ').slice(-300)}`))
      );
    });
  }

  _download(url, destination, redirects = 5) {
    return new Promise((resolve, reject) => {
      const partial = destination + '.partial';
      https
        .get(url, { headers: { 'User-Agent': 'MeetScribe' } }, (response) => {
          if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
            response.resume();
            if (redirects <= 0) return reject(new Error('Too many redirects'));
            return resolve(this._download(response.headers.location, destination, redirects - 1));
          }
          if (response.statusCode !== 200) {
            response.resume();
            return reject(new Error(`Download failed (HTTP ${response.statusCode})`));
          }
          const file = fs.createWriteStream(partial);
          response.pipe(file);
          file.on('finish', () =>
            file.close(() => {
              try {
                if (fs.statSync(partial).size < MODEL_MIN_BYTES) throw new Error('Downloaded model is too small');
                fs.renameSync(partial, destination);
                resolve();
              } catch (error) {
                fs.rmSync(partial, { force: true });
                reject(error);
              }
            })
          );
          file.on('error', reject);
          response.on('error', reject);
        })
        .on('error', reject);
    });
  }

  // ── Worker ──

  _ensureWorker() {
    if (this.process && !this.process.killed) return;
    const script = this.paths && this.paths.voiceScript;
    if (!script || !fs.existsSync(script)) throw new Error('voice_worker.py not found');

    this.loaded = false;
    const child = spawn(this.paths.python, ['-u', script], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: this.paths.env
    });
    this.process = child;
    readline.createInterface({ input: child.stdout }).on('line', (line) => this._onLine(line));
    child.stderr.on('data', (chunk) => logger.debug('Worker stderr', { message: chunk.toString().trim().slice(0, 500) }));
    const fail = (error) => {
      if (this.process !== child) return;
      this.process = null;
      this.loaded = false;
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(error);
      }
      this.pending.clear();
    };
    child.on('error', fail);
    // A worker that died closes its stdin; without a listener the next write
    // would be an unhandled 'error' event in the main process.
    child.stdin.on('error', (error) => logger.debug('Worker stdin error', { error: error.message }));
    child.on('close', (code) => fail(new Error(`Voice worker exited with code ${code}`)));
  }

  _onLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (_) {
      return; // not protocol
    }
    if (message.event || message.id === undefined) return;
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.ok) entry.resolve(message);
    else entry.reject(new Error(message.error || 'voice worker error'));
  }

  _request(payload, timeoutMs = REQUEST_TIMEOUT_MS) {
    this._ensureWorker();
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Voice worker timed out'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.process.stdin.write(JSON.stringify({ id, ...payload }) + '\n', (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  async _ensureLoaded() {
    if (this.loaded && this.process) return;
    await this._request({ action: 'load', model_path: this.modelPath(), threads: 1 }, 60000);
    this.loaded = true;
  }

  async embed(wavPath) {
    await this._ensureLoaded();
    const result = await this._request({ action: 'embed', audio_path: wavPath });
    return result.embedding;
  }

  shutdown() {
    if (this.process) {
      try { this.process.stdin.write(JSON.stringify({ id: 0, action: 'shutdown' }) + '\n'); } catch (_) { /* gone */ }
      const child = this.process;
      setTimeout(() => { try { child.kill(); } catch (_) { /* gone */ } }, 500);
      this.process = null;
      this.loaded = false;
    }
  }

  // ── Enrollment ──

  beginEnrollment() {
    if (this.enrollmentChunks) throw new Error('Already recording');
    this.enrollmentChunks = [];
  }

  collect(buffer) {
    if (this.enrollmentChunks) this.enrollmentChunks.push(buffer);
  }

  cancelEnrollment() {
    this.enrollmentChunks = null;
  }

  /** Cut the recording into 3 s clips, embed the ones with speech, store the average. */
  async finishEnrollment() {
    const chunks = this.enrollmentChunks;
    this.enrollmentChunks = null;
    if (!chunks || !chunks.length) throw new Error('Nothing was recorded');

    const audio = Buffer.concat(chunks);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meetscribe-voice-'));
    const embeddings = [];
    try {
      for (let offset = 0; offset + CLIP_BYTES <= audio.length; offset += CLIP_BYTES) {
        const clip = audio.subarray(offset, offset + CLIP_BYTES);
        if (rmsOf(clip) < SPEECH_RMS) continue;
        const file = path.join(dir, `clip-${offset}.wav`);
        fs.writeFileSync(file, pcmToWav(clip));
        embeddings.push(await this.embed(file));
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }

    if (embeddings.length < MIN_CLIPS) {
      throw new Error('Not enough speech. Speak steadily for the whole recording, closer to the microphone.');
    }
    const voiceprint = average(embeddings);
    const weakest = consistency(embeddings);
    if (weakest < CLIP_CONSISTENCY) {
      throw new Error('The recording sounds like more than one voice, or has too much noise. Try again alone in a quiet room.');
    }

    fs.writeFileSync(
      this.voiceprintFile(),
      JSON.stringify({ embedding: voiceprint, clips: embeddings.length, model: MODEL_FILE, createdAt: new Date().toISOString() }),
      'utf8'
    );
    this.tracker = null;
    return { ok: true, clips: embeddings.length, consistency: Number(weakest.toFixed(2)) };
  }

  // ── Live labels ──

  /** True when the feature is switched on and everything it needs is present. */
  isActive() {
    if (!settingsStore.get('voiceLabels')) return false;
    const model = this.modelPath();
    return Boolean(model && fs.existsSync(model) && this.loadVoiceprint());
  }

  /** Forget the voices heard so far; call at the start of every recording. */
  resetMeeting() {
    this.tracker = null;
    this.lastLabel = null;
    this.lastAt = 0;
  }

  _getTracker() {
    if (!this.tracker) {
      const voiceprint = this.loadVoiceprint();
      this.tracker = new SpeakerTracker({
        voiceprint: voiceprint ? voiceprint.embedding : null,
        threshold: Number(settingsStore.get('voiceMatchThreshold')) || 0.45,
        ownerLabel: settingsStore.get('labelMic') || 'You'
      });
    }
    return this.tracker;
  }

  /**
   * Who spoke this utterance? Returns a label, or null to keep the stream's own
   * label (feature off, utterance too short to tell, or any failure: a label is
   * a nicety, the transcript must never wait on or break because of it).
   */
  async identify(wavPath, durationMs) {
    if (!this.isActive()) return null;
    try {
      const now = Date.now();
      if (durationMs < MIN_UTTERANCE_MS) {
        return this.lastLabel && now - this.lastAt < CARRY_LABEL_MS ? this.lastLabel : null;
      }
      const embedding = await this.embed(wavPath);
      const result = this._getTracker().assign(embedding);
      this.lastLabel = result.label;
      this.lastAt = now;
      logger.debug('Speaker', { label: result.label, score: Number(result.score.toFixed(2)) });
      return result.label;
    } catch (error) {
      logger.warn('Speaker labelling failed', { error: error.message });
      return null;
    }
  }
}

module.exports = new VoiceService();
