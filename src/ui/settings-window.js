/**
 * Settings panel.
 *
 * Every control maps 1:1 onto a key in settings.json. Changes save on change
 * (no explicit Save button) and the main process reconfigures the transcription
 * pipeline immediately.
 */

// id -> how to read/write the DOM element
const FIELDS = {
  transcriptRoot: 'text',
  folderNamePrefix: 'text',
  showTranscriptOnRecord: 'check',
  reorderWindowMs: 'number',
  autoStartRecording: 'check',
  autoUpdate: 'check',

  systemEnabled: 'check',
  micEnabled: 'check',
  systemSource: 'text',
  systemDeviceLabel: 'text',
  micDeviceLabel: 'text',
  labelSystem: 'text',
  labelMic: 'text',
  echoSuppress: 'check',
  echoSimilarity: 'number',

  whisperModel: 'text',
  whisperLanguage: 'text',
  whisperDevice: 'text',
  whisperComputeType: 'text',
  whisperPython: 'text',
  whisperWorkerCount: 'number',
  silenceHangoverMs: 'number',
  maxUtteranceMs: 'number',
  vadEnergyFloor: 'number',

  glossary: 'text',
  archiveAudio: 'check',
  liveTranscription: 'check',
  archiveFormat: 'text',
  offlinePassEnabled: 'check',
  offlineModel: 'text',
  offlineMode: 'text',
  offlineBeamSize: 'number',
  offlineCpuThreads: 'number',
  offlineWordConfidence: 'number',
  offlineDiffModel: 'text',

  transcriptFontSize: 'number',
  windowGap: 'number',
  startClickThrough: 'check'
};

// Settings that change what the model list shows.
const MODEL_SETTINGS = ['whisperModel', 'offlineModel', 'offlineDiffModel', 'offlineMode', 'offlineCpuThreads'];

const MODEL_GROUPS = [
  ['live', 'Live models'],
  ['final', 'Final-pass models'],
  ['finetune', 'Language fine-tunes'],
  ['custom', 'Custom']
];

// localStorage can be blocked or empty; the window must work without it.
function recall(key, fallback = null) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

function remember(key, value) {
  try { window.localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* not persisted */ }
}

function formatSize(bytes) {
  if (!bytes) return '';
  return bytes >= 1e9 ? (bytes / 1e9).toFixed(1) + ' GB' : Math.round(bytes / 1e6) + ' MB';
}

// Inline SVG: Windows has no flag emoji, it would draw the letters "US" / "DE".
function starPoints(cx, cy, outer, inner) {
  const points = [];
  for (let i = 0; i < 10; i++) {
    const radius = i % 2 === 0 ? outer : inner;
    const angle = (Math.PI / 5) * i - Math.PI / 2;
    points.push((cx + radius * Math.cos(angle)).toFixed(2) + ',' + (cy + radius * Math.sin(angle)).toFixed(2));
  }
  return points.join(' ');
}

const FLAGS = {
  us: '<svg viewBox="0 0 30 20"><rect width="30" height="20" fill="#fff"/>' +
    [0, 1, 2, 3, 4, 5, 6].map((i) => '<rect y="' + (i * 2 * 20 / 13).toFixed(2) + '" width="30" height="' + (20 / 13).toFixed(2) + '" fill="#b22234"/>').join('') +
    '<rect width="12" height="10.77" fill="#3c3b6e"/></svg>',
  de: '<svg viewBox="0 0 30 20"><rect width="30" height="6.67" fill="#000"/><rect y="6.67" width="30" height="6.67" fill="#dd0000"/><rect y="13.33" width="30" height="6.67" fill="#ffce00"/></svg>',
  tn: '<svg viewBox="0 0 30 20"><rect width="30" height="20" fill="#e70013"/><circle cx="15" cy="10" r="5.6" fill="#fff"/>' +
    '<circle cx="14.1" cy="10" r="4.2" fill="#e70013"/><circle cx="15.5" cy="10" r="3.4" fill="#fff"/>' +
    '<circle cx="16.2" cy="10" r="2.7" fill="#e70013"/><polygon points="' + starPoints(16.1, 10, 2.1, 0.9) + '" fill="#fff"/>' +
    '<polygon points="' + starPoints(16.1, 10, 1.6, 0.7) + '" fill="#e70013"/></svg>',
  custom: '<svg viewBox="0 0 30 20"><rect width="30" height="20" fill="#3a3a44"/><rect x="5" y="5" width="20" height="2" rx="1" fill="#9aa"/>' +
    '<rect x="5" y="9" width="20" height="2" rx="1" fill="#9aa"/><rect x="5" y="13" width="20" height="2" rx="1" fill="#9aa"/>' +
    '<circle cx="20" cy="6" r="2.4" fill="#6fb4ff"/><circle cx="10" cy="10" r="2.4" fill="#6fb4ff"/><circle cx="17" cy="14" r="2.4" fill="#6fb4ff"/></svg>'
};

class SettingsWindow {
  constructor() {
    this.settings = null;
    this.applying = false;

    this.bindTabs();
    this.bindFields();
    this.bindActions();
    this.bindEvents();
    this.load();
    this.loadModels();
    this.loadProfiles();
  }

  bindTabs() {
    const show = (tab) => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
      document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(`page-${tab.dataset.page}`).classList.add('active');
    };
    document.querySelectorAll('.tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        show(tab);
        remember('settings.tab', tab.dataset.page);
      });
    });
    const last = document.querySelector('.tab[data-page="' + (recall('settings.tab') || '') + '"]');
    if (last) show(last);

    // Collapsible sections remember whether the user left them open.
    const open = recall('settings.sections', {});
    document.querySelectorAll('details.section').forEach((section) => {
      const key = section.dataset.key;
      if (key in open) section.open = Boolean(open[key]);
      section.addEventListener('toggle', () => {
        remember('settings.sections', { ...recall('settings.sections', {}), [key]: section.open });
      });
    });
  }

  bindFields() {
    for (const id of Object.keys(FIELDS)) {
      const element = document.getElementById(id);
      if (!element) continue;
      const eventName = element.tagName === 'SELECT' || element.type === 'checkbox' ? 'change' : 'input';
      element.addEventListener(eventName, () => {
        if (this.applying) return;
        this.save({ [id]: this.readField(id) });
        if (id === 'systemSource') this.updateSystemSourceVisibility();
        if (id === 'echoSimilarity') this.updateEchoLabel();
        if (id === 'offlineWordConfidence') this.updateConfidenceLabel();
      });
    }
  }

  bindActions() {
    document.getElementById('browseFolder').addEventListener('click', async () => {
      const result = await window.electronAPI.pickFolder();
      if (result.ok) {
        document.getElementById('transcriptRoot').value = result.path;
        this.save({ transcriptRoot: result.path });
      }
    });

    document.getElementById('openFolder').addEventListener('click', () => {
      window.electronAPI.openMeetingFolder();
    });

    document.getElementById('openManager').addEventListener('click', () => {
      window.electronAPI.openManager();
    });

    document.getElementById('browsePython').addEventListener('click', async () => {
      const result = await window.electronAPI.pickPython();
      if (result.ok) {
        document.getElementById('whisperPython').value = result.path;
        this.save({ whisperPython: result.path });
        this.refreshWhisperStatus();
      }
    });

    document.getElementById('resetProfile').addEventListener('click', async () => {
      const result = await window.electronAPI.resetProfile(this.activeProfile);
      if (result.settings) this.apply(result.settings);
      if (result.profiles) this.renderProfiles(result);
    });

    document.getElementById('installWhisper').addEventListener('click', () => this.installWhisper());

    const customModel = document.getElementById('offlineModelCustom');
    customModel.addEventListener('input', () => {
      if (this.applying) return;
      const typed = customModel.value.trim();
      this.save({ offlineModel: typed || document.getElementById('offlineModel').value });
    });

    document.getElementById('rerunFinal').addEventListener('click', async () => {
      const status = document.getElementById('finalPassStatus');
      const result = await window.electronAPI.pickAndRerunFinalPass();
      if (result.canceled) return;
      status.textContent = result.ok
        ? 'Re-transcribing ' + result.folder + '…'
        : 'Could not start: ' + result.error;
    });

    window.electronAPI.onModelProgress((payload) => {
      if (payload.state === 'downloading') {
        const state = document.querySelector('.model[data-repo="' + CSS.escape(payload.repo) + '"] .model-state');
        if (state) state.textContent = 'Downloading ' + Math.round((payload.progress || 0) * 100) + '%';
      } else {
        this.loadModels();
      }
    });

    window.electronAPI.onFinalPass((payload) => {
      const status = document.getElementById('finalPassStatus');
      if (!status || !payload) return;
      status.textContent = payload.message || payload.state || '';
    });

    document.getElementById('restartApp').addEventListener('click', () => {
      window.electronAPI.restartAppForStealth();
    });

    document.getElementById('quitApp').addEventListener('click', () => window.electronAPI.quitApp());
    document.getElementById('closeBtn').addEventListener('click', () => window.electronAPI.closeSettings());

    document.querySelectorAll('.icon-choice').forEach((choice) => {
      choice.addEventListener('click', () => {
        const icon = choice.dataset.icon;
        document.querySelectorAll('.icon-choice').forEach((c) => c.classList.remove('selected'));
        choice.classList.add('selected');
        window.electronAPI.updateAppIcon(icon);
      });
    });
  }

  bindEvents() {
    window.electronAPI.onLoadSettings((settings) => this.apply(settings));
    window.electronAPI.onSettingsWindowShown(() => {
      this.load();
      this.refreshDevices();
    });

    window.electronAPI.onAudioLevel(({ streamId, rms }) => {
      const meter = document.getElementById(streamId === 'system' ? 'meterSystem' : 'meterMic');
      if (meter) meter.style.width = `${Math.min(100, Math.round(Math.sqrt(rms) * 180))}%`;
    });

    window.electronAPI.onInstallProgress((line) => this.appendLog(line));
  }

  async loadProfiles() {
    try {
      this.renderProfiles(await window.electronAPI.listProfiles());
    } catch (_) { /* main process not ready; the next open retries */ }
  }

  renderProfiles({ active, profiles }) {
    this.activeProfile = active;
    const holder = document.getElementById('profileCards');
    holder.textContent = '';
    for (const profile of profiles) {
      const card = document.createElement('button');
      card.className = 'profile' + (profile.id === active ? ' active' : '');
      card.title = profile.summary;
      const flag = document.createElement('span');
      flag.className = 'flag';
      flag.innerHTML = FLAGS[profile.flag] || FLAGS.custom;
      const name = document.createElement('span');
      name.className = 'p-name';
      name.textContent = profile.label;
      const summary = document.createElement('span');
      summary.className = 'p-sum';
      summary.textContent = profile.summary;
      card.append(flag, name, summary);
      card.addEventListener('click', () => this.selectProfile(profile.id));
      holder.appendChild(card);
    }
    const reset = document.getElementById('resetProfile');
    const current = profiles.find((profile) => profile.id === active);
    reset.hidden = !(current && current.edited && active !== 'custom');
    document.getElementById('profileHint').textContent = current
      ? 'Changes you make are remembered by this profile.'
      : 'Pick a profile to preselect everything below.';
  }

  async selectProfile(id) {
    const result = await window.electronAPI.selectProfile(id);
    if (!result.ok) return;
    this.apply(result.settings);
    this.renderProfiles(result);
    this.loadModels();
  }

  async load() {
    const settings = await window.electronAPI.getSettings();
    this.apply(settings);
    this.refreshDevices();
  }

  readField(id) {
    const element = document.getElementById(id);
    const kind = FIELDS[id];
    if (kind === 'check') return element.checked;
    if (kind === 'number') return Number(element.value);
    return element.value;
  }

  apply(settings) {
    if (!settings) return;
    this.settings = settings;
    // Guard so programmatic writes don't re-trigger a save per field.
    this.applying = true;

    for (const [id, kind] of Object.entries(FIELDS)) {
      const element = document.getElementById(id);
      if (!element || settings[id] === undefined) continue;
      if (kind === 'check') element.checked = !!settings[id];
      else element.value = settings[id];
    }

    document.querySelectorAll('.icon-choice').forEach((choice) => {
      choice.classList.toggle('selected', choice.dataset.icon === settings.appIcon);
    });

    document.getElementById('meterLabelThem').textContent = settings.labelSystem || 'Them';
    document.getElementById('meterLabelYou').textContent = settings.labelMic || 'You';

    this.updateSystemSourceVisibility();
    this.updateEchoLabel();
    this.updateConfidenceLabel();
    this.applyCustomModel(settings);
    this.renderWhisperStatus(settings.whisper);
    this.populateDevices(settings.audioInputs || []);

    this.applying = false;
  }

  updateConfidenceLabel() {
    const element = document.getElementById('confValue');
    if (element) {
      element.textContent = Number(document.getElementById('offlineWordConfidence').value).toFixed(2);
    }
  }

  /**
   * The dropdown holds the stock models; anything else (a German fine-tune, a
   * local conversion) is typed into the text box. One setting backs both, so
   * the box wins whenever it holds a value the dropdown does not offer.
   */
  applyCustomModel(settings) {
    const select = document.getElementById('offlineModel');
    const custom = document.getElementById('offlineModelCustom');
    if (!select || !custom) return;
    const value = settings.offlineModel || '';
    const known = Array.from(select.options).some((option) => option.value === value);
    custom.value = known ? '' : value;
    if (!known && value) select.value = 'large-v3-turbo';
  }

  updateSystemSourceVisibility() {
    const isDevice = document.getElementById('systemSource').value === 'device';
    document.getElementById('systemDeviceLabel').style.display = isDevice ? '' : 'none';
  }

  updateEchoLabel() {
    document.getElementById('echoValue').textContent =
      Number(document.getElementById('echoSimilarity').value).toFixed(2);
  }

  async refreshDevices() {
    try {
      const devices = await window.electronAPI.listAudioDevices();
      this.populateDevices(devices.inputs || []);
    } catch (_) {
      /* enumeration needs the audio window; ignore while starting up */
    }
  }

  populateDevices(inputs) {
    for (const id of ['micDeviceLabel', 'systemDeviceLabel']) {
      const select = document.getElementById(id);
      if (!select) continue;
      const current = (this.settings && this.settings[id]) || '';
      select.innerHTML = '';

      const auto = document.createElement('option');
      auto.value = '';
      auto.textContent = id === 'micDeviceLabel' ? 'System default' : 'Choose a device…';
      select.appendChild(auto);

      for (const input of inputs) {
        if (!input.label) continue;
        const option = document.createElement('option');
        option.value = input.label;
        option.textContent = input.label;
        select.appendChild(option);
      }
      select.value = current;
    }
  }

  renderWhisperStatus(status) {
    const element = document.getElementById('whisperStatus');
    if (!status) {
      element.textContent = 'Status unknown';
      return;
    }
    if (!status.configured) {
      element.textContent = 'Not set up — click "Install / Repair Whisper".';
      const install = document.querySelector('details.section[data-key="install"]');
      if (install) install.open = true; // the one thing to do next must not be hidden
      return;
    }
    const parts = ['Ready'];
    if (status.model) parts.push(status.model);
    if (status.device) parts.push(status.device);
    parts.push(`queue ${status.queueDepth ?? 0}`);
    if (status.lastLatencyMs) parts.push(`last ${status.lastLatencyMs} ms`);
    element.textContent = parts.join(' · ');
    if (status.lastError) element.textContent += ` · ${status.lastError}`;
  }

  async refreshWhisperStatus() {
    try {
      this.renderWhisperStatus(await window.electronAPI.getWhisperStatus());
    } catch (_) { /* ignore */ }
  }

  async installWhisper() {
    const button = document.getElementById('installWhisper');
    const log = document.getElementById('installLog');
    log.textContent = '';
    log.classList.add('show');
    button.disabled = true;
    button.textContent = 'Installing…';

    try {
      const result = await window.electronAPI.installWhisper({
        gpu: document.getElementById('installGpu').checked,
        model: document.getElementById('whisperModel').value
      });
      if (result.ok) {
        document.getElementById('whisperPython').value = result.python;
      }
      this.refreshWhisperStatus();
    } finally {
      button.disabled = false;
      button.textContent = 'Install / Repair Whisper';
    }
  }

  appendLog(line) {
    const log = document.getElementById('installLog');
    log.classList.add('show');
    log.textContent += `${line}\n`;
    log.scrollTop = log.scrollHeight;
  }

  async loadModels() {
    try {
      this.renderModels(await window.electronAPI.listModels());
    } catch (error) {
      document.getElementById('modelList').textContent = 'Could not list models: ' + error.message;
    }
  }

  renderModels(rows) {
    const list = document.getElementById('modelList');
    list.textContent = '';

    // What is on disk comes first, by purpose; everything else hides under one fold.
    const have = rows.filter((row) => row.downloaded);
    const rest = rows.filter((row) => !row.downloaded);
    for (const [category, title] of MODEL_GROUPS) {
      const group = have.filter((row) => (row.custom ? 'custom' : row.category || 'final') === category);
      if (!group.length) continue;
      const heading = document.createElement('div');
      heading.className = 'model-group';
      heading.textContent = title;
      list.appendChild(heading);
      for (const row of group) list.appendChild(this.renderModel(row));
    }
    if (!have.length) {
      const none = document.createElement('div');
      none.className = 'hint';
      none.textContent = 'No models downloaded yet.';
      list.appendChild(none);
    }

    if (rest.length) {
      const more = document.createElement('details');
      more.className = 'model-more';
      more.open = Boolean(this.availableOpen) || rest.some((row) => row.downloading);
      more.addEventListener('toggle', () => { this.availableOpen = more.open; });
      const summary = document.createElement('summary');
      summary.textContent = 'Available to download (' + rest.length + ')';
      more.appendChild(summary);
      const body = document.createElement('div');
      body.className = 'models';
      for (const row of rest) body.appendChild(this.renderModel(row));
      more.appendChild(body);
      list.appendChild(more);
    }
    this.markDownloaded(rows);
  }

  renderModel(row) {
    const item = document.createElement('div');
    item.className = 'model';
    item.dataset.repo = row.repo;

    const main = document.createElement('div');
    main.className = 'model-main';
    const name = document.createElement('div');
    name.className = 'model-name';
    name.textContent = row.label;
    for (const role of row.inUse) {
      const tag = document.createElement('span');
      tag.className = 'model-tag';
      tag.textContent = role === 'live' ? 'live' : role === 'final' ? 'final pass' : 'cross-check';
      name.appendChild(tag);
    }
    const meta = document.createElement('div');
    meta.className = 'model-meta';
    const parts = [row.note];
    if (row.roles.includes('final') && row.estimate) {
      const minutes = Math.max(1, Math.round(row.estimate.minutes));
      const basis = row.estimate.meetings > 0
        ? 'from ' + row.estimate.meetings + ' meeting' + (row.estimate.meetings === 1 ? '' : 's')
        : 'estimate';
      parts.push('≈ ' + minutes + ' min per 1 h meeting (' + basis + ')');
    }
    meta.textContent = parts.filter(Boolean).join(' · ');
    main.append(name, meta);

    const state = document.createElement('span');
    state.className = 'model-state' + (row.downloaded ? ' ok' : '');
    if (row.downloading) state.textContent = 'Downloading ' + Math.round(row.progress * 100) + '%';
    else if (row.downloaded) state.textContent = '✓ ' + formatSize(row.bytes);
    // A partial download resumes where it stopped.
    else if (row.bytes > 0) state.textContent = 'Incomplete · ' + formatSize(row.bytes);
    else state.textContent = row.sizeMb ? 'Not downloaded · ' + formatSize(row.sizeMb * 1e6) : 'Not downloaded';

    const button = document.createElement('button');
    button.className = 'action' + (row.downloaded ? ' danger' : '');
    if (row.downloading) {
      button.textContent = 'Downloading…';
      button.disabled = true;
    } else if (row.downloaded) {
      // Two clicks, not a dialog: a stray click must not cost a 3 GB re-download.
      button.textContent = 'Delete';
      button.addEventListener('click', async () => {
        if (button.dataset.armed !== '1') {
          button.dataset.armed = '1';
          button.textContent = 'Confirm?';
          setTimeout(() => { button.dataset.armed = ''; button.textContent = 'Delete'; }, 4000);
          return;
        }
        const result = await window.electronAPI.deleteModel(row.id);
        if (!result.ok) state.textContent = result.error;
        else this.loadModels();
      });
    } else {
      button.textContent = 'Download';
      button.addEventListener('click', async () => {
        const result = await window.electronAPI.downloadModel(row.id);
        if (!result.ok) state.textContent = result.error;
        else { button.disabled = true; state.textContent = 'Downloading 0%'; }
      });
    }

    item.append(main, state, button);
    return item;
  }

  /** "✓" on the dropdown entries that are already on disk. */
  markDownloaded(rows) {
    for (const id of ['whisperModel', 'offlineModel']) {
      const select = document.getElementById(id);
      if (!select) continue;
      for (const option of select.options) {
        if (!option.dataset.label) option.dataset.label = option.textContent;
        const row = rows.find((candidate) => candidate.id === option.value || candidate.repo === option.value);
        option.textContent = (row && row.downloaded ? '✓ ' : '') + option.dataset.label;
      }
    }
  }

  async save(patch) {
    await window.electronAPI.saveSettings(patch);
    // "In use" tags and the time estimates depend on these.
    if (MODEL_SETTINGS.some((key) => key in patch)) this.loadModels();
    // The active profile just absorbed this edit (shows its "Reset" link).
    if (this.activeProfile) this.loadProfiles();
    const saved = document.getElementById('saved');
    saved.classList.add('show');
    clearTimeout(this.savedTimer);
    this.savedTimer = setTimeout(() => saved.classList.remove('show'), 1200);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  window.settingsWindow = new SettingsWindow();
});
