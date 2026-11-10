/* MeetScribe Library: the browser manager page. Served by
 * src/services/manager-server.service.js; talks to it over same-origin fetch
 * and Server-Sent Events. Plain script, no framework, no build step. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const state = {
    library: { folders: [], meetings: [] },
    folder: '',            // '' = all meetings
    view: 'list',          // 'list' | 'storage'
    query: '',
    results: null,         // Map id -> { hits, snippets } while searching
    selected: new Set(),   // ids picked for bulk actions
    meeting: null,         // the open meeting (full detail)
    player: null,
    corrections: []
  };

  // ── Helpers ──

  const pad = (value) => String(value).padStart(2, '0');

  function fmtClock(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  }

  function fmtDuration(ms) {
    if (!ms) return '';
    const minutes = Math.round(ms / 60000);
    if (minutes < 60) return `${Math.max(1, minutes)} min`;
    return `${Math.floor(minutes / 60)} h ${pad(minutes % 60)} min`;
  }

  function fmtBytes(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit++;
    }
    return `${value.toFixed(value < 10 && unit > 0 ? 1 : 0)} ${units[unit]}`;
  }

  function fmtDate(ms) {
    if (!ms) return '';
    const date = new Date(ms);
    return date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) +
      ' · ' + date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else if (key === 'dataset') Object.assign(node.dataset, value);
      // Through the CSSOM: the page's CSP refuses inline style attributes.
      else if (key === 'style') node.style.cssText = value;
      else if (key === 'value') node.value = value;
      else node.setAttribute(key, value === true ? '' : value);
    }
    for (const child of [].concat(children)) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  let toastTimer = null;
  function toast(message) {
    const node = $('toast');
    node.textContent = message;
    node.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { node.hidden = true; }, 3500);
  }

  function expired() {
    document.body.replaceChildren(el('p', { class: 'placeholder', text: 'This session has expired. Open the manager again from MeetScribe (Settings → Open Manager).' }));
    throw new Error('expired');
  }

  async function api(path) {
    const response = await fetch(path, { credentials: 'same-origin' });
    if (response.status === 403) expired();
    const body = await response.json();
    if (!body.ok) throw new Error(body.error || 'Request failed');
    return body;
  }

  async function post(path, payload) {
    const response = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (response.status === 403) expired();
    const body = await response.json();
    if (!body.ok) throw new Error(body.error || 'Request failed');
    return body;
  }

  /** Run an action and report a failure as a toast instead of an exception. */
  async function attempt(work, failure) {
    try {
      return await work();
    } catch (error) {
      if (error.message !== 'expired') toast((failure ? failure + ': ' : '') + error.message);
      return null;
    }
  }

  const mediaUrl = (id, file) => `/media?id=${encodeURIComponent(id)}&file=${encodeURIComponent(file)}`;

  /** Wrap every occurrence of the search terms in <mark>. */
  function highlightTerms(root, terms) {
    if (!terms.length) return 0;
    let count = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    const pattern = new RegExp(terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi');
    for (const node of nodes) {
      const text = node.nodeValue;
      pattern.lastIndex = 0;
      if (!pattern.test(text)) continue;
      pattern.lastIndex = 0;
      const fragment = document.createDocumentFragment();
      let last = 0;
      let match;
      while ((match = pattern.exec(text))) {
        fragment.append(text.slice(last, match.index), el('mark', { text: match[0] }));
        last = match.index + match[0].length;
        count++;
      }
      fragment.append(text.slice(last));
      node.replaceWith(fragment);
    }
    return count;
  }

  function queryTerms(query) {
    const terms = [];
    const pattern = /"([^"]+)"|(\S+)/g;
    let match;
    while ((match = pattern.exec(query))) terms.push((match[1] || match[2]).trim());
    return terms.filter(Boolean);
  }

  // ── Dialog ──
  //
  // ask({ title, text, fields: [{ name, label, type, value, options }], ok, danger, list })
  // resolves with the field values, or null when cancelled.

  function ask({ title, text = '', fields = [], ok = 'OK', danger = false, list = null }) {
    const dialog = $('dialog');
    $('dialogTitle').textContent = title;
    $('dialogText').textContent = text;
    $('dialogText').hidden = !text;
    const box = $('dialogFields');
    box.replaceChildren();
    const inputs = {};
    for (const field of fields) {
      let input;
      if (field.type === 'select') {
        input = el('select', { name: field.name }, field.options.map((option) => el('option', { value: option.value, text: option.label })));
        input.value = field.value || '';
      } else if (field.type === 'textarea') {
        input = el('textarea', { name: field.name, rows: field.rows || 4 });
        input.value = field.value || '';
      } else {
        input = el('input', { type: field.type || 'text', name: field.name, placeholder: field.placeholder, required: field.required });
        input.value = field.value || '';
      }
      inputs[field.name] = input;
      box.append(el('label', {}, [field.label, input]));
    }
    if (list) box.append(el('ul', {}, list.map((item) => el('li', { text: item }))));
    const okButton = $('dialogOk');
    okButton.textContent = ok;
    okButton.className = 'btn ' + (danger ? 'danger' : 'primary');
    dialog.returnValue = '';
    dialog.showModal();
    const first = Object.values(inputs)[0];
    if (first) {
      first.focus();
      if (first.select) first.select();
    }
    return new Promise((resolve) => {
      dialog.addEventListener('close', () => {
        if (dialog.returnValue !== 'ok') return resolve(null);
        const values = {};
        for (const [name, input] of Object.entries(inputs)) values[name] = input.value;
        resolve(values);
      }, { once: true });
    });
  }

  // ── Library ──

  async function loadLibrary() {
    const body = await attempt(() => api('/api/library'), 'Could not load the library');
    if (!body) return;
    state.library = body;
    const ids = new Set(body.meetings.map((meeting) => meeting.id));
    for (const id of [...state.selected]) if (!ids.has(id)) state.selected.delete(id);
    if (state.folder && !state.folder.startsWith('tag:') && state.folder !== '/' &&
      !body.folders.some((folder) => folder.id === state.folder)) state.folder = '';
    renderFolders();
    renderList();
    const total = body.meetings.reduce((sum, meeting) => sum + (meeting.bytes || 0), 0);
    $('totals').textContent = `${body.meetings.length} meetings · ${fmtBytes(total)}`;
  }

  function inFolder(meeting, folder) {
    if (!folder) return true;
    if (folder.startsWith('tag:')) return meeting.tags.includes(folder.slice(4));
    if (folder === '/') return meeting.parent === '';
    return meeting.parent === folder || meeting.parent.startsWith(folder + '/');
  }

  function folderOptions() {
    return [{ value: '', label: 'Transcript folder (top level)' }]
      .concat(state.library.folders.slice().sort((a, b) => a.id.localeCompare(b.id)).map((folder) => ({ value: folder.id, label: folder.id })));
  }

  function renderFolders() {
    const nav = $('folders');
    nav.replaceChildren();
    const { meetings, folders } = state.library;
    const select = (id) => {
      state.folder = id;
      state.view = 'list';
      renderFolders();
      renderList();
    };
    const button = (id, label, depth = 0) => el('button', {
      class: 'folder' + (state.view === 'list' && state.folder === id ? ' active' : ''),
      style: `padding-left:${10 + depth * 14}px`,
      onclick: () => select(id)
    }, [el('span', { text: label }), el('span', { class: 'count', text: meetings.filter((m) => inFolder(m, id)).length })]);

    nav.append(button('', 'All meetings'));
    nav.append(button('/', 'Not in a folder'));
    nav.append(el('div', { class: 'folder-group' }, [
      el('span', { text: 'Folders' }),
      el('button', { class: 'icon', title: 'New folder', text: '+', onclick: () => newFolder('') })
    ]));
    const sorted = folders.slice().sort((a, b) => a.id.localeCompare(b.id));
    for (const folder of sorted) {
      nav.append(el('div', { class: 'folder-row' }, [
        button(folder.id, folder.name, folder.id.split('/').length - 1),
        el('span', { class: 'folder-tools' }, [
          el('button', { class: 'icon', title: 'New folder inside', text: '+', onclick: () => newFolder(folder.id) }),
          el('button', { class: 'icon', title: 'Rename folder', text: '✎', onclick: () => renameFolder(folder) }),
          el('button', { class: 'icon', title: 'Delete empty folder', text: '✕', onclick: () => deleteFolder(folder) })
        ])
      ]));
    }
    const tags = [...new Set(meetings.flatMap((meeting) => meeting.tags))].sort();
    if (tags.length) {
      nav.append(el('div', { class: 'folder-group', text: 'Tags' }));
      for (const tag of tags) nav.append(button('tag:' + tag, '#' + tag));
    }
  }

  async function newFolder(parent) {
    const values = await ask({ title: parent ? `New folder in ${parent}` : 'New folder', fields: [{ name: 'name', label: 'Name', required: true }], ok: 'Create' });
    if (!values) return;
    const result = await attempt(() => post('/api/folder/create', { parent, name: values.name }), 'Could not create the folder');
    if (result) await loadLibrary();
  }

  async function renameFolder(folder) {
    const values = await ask({ title: 'Rename folder', fields: [{ name: 'name', label: 'Name', value: folder.name, required: true }], ok: 'Rename' });
    if (!values) return;
    const result = await attempt(() => post('/api/folder/rename', { id: folder.id, name: values.name }), 'Could not rename the folder');
    if (!result) return;
    if (state.folder === folder.id) state.folder = result.id;
    await loadLibrary();
    if (state.meeting && (state.meeting.parent === folder.id || state.meeting.parent.startsWith(folder.id + '/'))) {
      openMeeting(result.id + state.meeting.id.slice(folder.id.length));
    }
  }

  async function deleteFolder(folder) {
    const values = await ask({ title: `Delete "${folder.name}"?`, text: 'Only an empty folder can be deleted.', ok: 'Delete', danger: true });
    if (!values) return;
    const result = await attempt(() => post('/api/folder/delete', { id: folder.id }), 'Could not delete the folder');
    if (result) await loadLibrary();
  }

  function sortMeetings(list) {
    const by = state.view === 'storage' ? 'largest' : $('sort').value;
    const sorted = list.slice();
    if (state.results) return sorted.sort((a, b) => state.results.get(b.id).hits - state.results.get(a.id).hits);
    if (by === 'oldest') return sorted.sort((a, b) => a.startedAt - b.startedAt);
    if (by === 'longest') return sorted.sort((a, b) => (b.durationMs || 0) - (a.durationMs || 0));
    if (by === 'largest') return sorted.sort((a, b) => b.bytes - a.bytes);
    return sorted.sort((a, b) => b.startedAt - a.startedAt);
  }

  function visibleMeetings() {
    let meetings = state.library.meetings.filter((meeting) => state.view === 'storage' || inFolder(meeting, state.folder));
    if (state.results) meetings = meetings.filter((meeting) => state.results.has(meeting.id));
    return sortMeetings(meetings);
  }

  function renderList() {
    const list = $('meetings');
    list.replaceChildren();
    const meetings = visibleMeetings();
    const storage = state.view === 'storage';

    const folder = state.library.folders.find((entry) => entry.id === state.folder);
    $('listTitle').textContent = state.results
      ? `${meetings.length} result${meetings.length === 1 ? '' : 's'} for “${state.query}”`
      : storage ? 'Storage'
        : state.folder.startsWith('tag:') ? '#' + state.folder.slice(4)
          : state.folder === '/' ? 'Not in a folder'
            : folder ? folder.name : 'All meetings';
    $('sort').hidden = storage;
    $('storagePanel').hidden = !storage;
    if (storage) {
      const all = state.library.meetings;
      const total = all.reduce((sum, meeting) => sum + meeting.bytes, 0);
      const audio = all.reduce((sum, meeting) => sum + (meeting.audioBytes || 0), 0);
      $('storageTotals').textContent = `${fmtBytes(total)} in ${all.length} meetings, of which ${fmtBytes(audio)} is audio.`;
    }
    $('emptyList').hidden = meetings.length > 0;
    $('emptyList').textContent = state.results ? 'Nothing matches.' : 'No meetings here yet.';

    const terms = queryTerms(state.query);
    for (const meeting of meetings) {
      const pills = [];
      if (meeting.state) pills.push(el('span', { class: 'pill state', text: meeting.state }));
      if (meeting.hasFinal) pills.push(el('span', { class: 'pill final', text: 'final' }));
      else if (meeting.hasLive) pills.push(el('span', { class: 'pill', text: 'live only' }));
      if (meeting.prefix) pills.push(el('span', { class: 'pill', text: meeting.prefix }));
      for (const tag of meeting.tags) pills.push(el('span', { class: 'pill', text: '#' + tag }));

      const pick = el('input', {
        type: 'checkbox',
        class: 'pick',
        title: 'Select for bulk actions',
        'aria-label': 'Select ' + (meeting.title || meeting.name),
        onclick: (event) => event.stopPropagation(),
        onchange: (event) => {
          if (event.target.checked) state.selected.add(meeting.id);
          else state.selected.delete(meeting.id);
          renderBulk();
        }
      });
      pick.checked = state.selected.has(meeting.id);

      const body = el('div', {}, [
        el('div', { class: 'row1' }, [
          el('span', { class: 'name', text: meeting.title || meeting.name, title: meeting.name }),
          el('span', { class: 'when', text: new Date(meeting.startedAt).toLocaleDateString() })
        ]),
        el('div', { class: 'row2' }, [
          el('span', { text: new Date(meeting.startedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) }),
          meeting.durationMs ? el('span', { text: fmtDuration(meeting.durationMs) }) : null,
          el('span', { text: storage ? `${fmtBytes(meeting.bytes)} (audio ${fmtBytes(meeting.audioBytes)})` : fmtBytes(meeting.bytes) }),
          ...pills
        ])
      ]);
      if (state.results) {
        for (const snippet of state.results.get(meeting.id).snippets) {
          const node = el('div', { class: 'snippet', text: snippet });
          highlightTerms(node, terms);
          body.append(node);
        }
      }
      list.append(el('li', {
        class: 'meeting' + (state.meeting && state.meeting.id === meeting.id ? ' active' : ''),
        dataset: { id: meeting.id },
        tabindex: '0',
        onclick: () => openMeeting(meeting.id),
        onkeydown: (event) => { if (event.key === 'Enter') openMeeting(meeting.id); }
      }, [pick, body]));
    }
    renderBulk();
  }

  function renderBulk() {
    const count = state.selected.size;
    $('bulkBar').hidden = count === 0;
    $('bulkCount').textContent = `${count} selected`;
  }

  const byId = (id) => state.library.meetings.find((meeting) => meeting.id === id);
  const nameOf = (id) => {
    const meeting = byId(id);
    return meeting ? meeting.title || meeting.name : id;
  };

  /** Move, tag or delete several meetings (or one, from the meeting view). */
  async function bulk(action, ids) {
    if (!ids.length) return;
    let result = null;
    if (action === 'move') {
      const values = await ask({ title: `Move ${ids.length === 1 ? nameOf(ids[0]) : ids.length + ' meetings'}`, fields: [{ name: 'folder', label: 'To', type: 'select', options: folderOptions() }], ok: 'Move' });
      if (!values) return;
      result = await attempt(() => post('/api/meeting/move', { ids, folder: values.folder }), 'Could not move');
      if (result && state.meeting && ids.includes(state.meeting.id)) {
        const moved = result.ids.find((id) => id.split('/').pop() === state.meeting.id.split('/').pop());
        if (moved) state.reopen = moved;
      }
    } else if (action === 'tag') {
      const values = await ask({
        title: `Tag ${ids.length} meeting${ids.length === 1 ? '' : 's'}`,
        fields: [{ name: 'tag', label: 'Tag', required: true }, { name: 'mode', label: 'Action', type: 'select', value: 'add', options: [{ value: 'add', label: 'Add this tag' }, { value: 'remove', label: 'Remove this tag' }] }],
        ok: 'Apply'
      });
      if (!values) return;
      result = await attempt(() => post('/api/meeting/tag', { ids, tag: values.tag, remove: values.mode === 'remove' }), 'Could not tag');
    } else if (action === 'audio' || action === 'trash') {
      const audioOnly = action === 'audio';
      const size = ids.reduce((sum, id) => sum + ((byId(id) || {})[audioOnly ? 'audioBytes' : 'bytes'] || 0), 0);
      const values = await ask({
        title: audioOnly ? `Delete the audio of ${ids.length} meeting${ids.length === 1 ? '' : 's'}?` : `Delete ${ids.length} meeting${ids.length === 1 ? '' : 's'}?`,
        text: (audioOnly
          ? 'The transcripts stay. Without audio the final pass cannot be re-run and nothing can be played.'
          : 'The whole folder: transcripts, audio, screenshots and notes.') +
          `\nFrees ${fmtBytes(size)}. Everything goes to the Recycle Bin, so it can be restored from there.`,
        list: ids.slice(0, 12).map(nameOf).concat(ids.length > 12 ? [`… and ${ids.length - 12} more`] : []),
        ok: audioOnly ? 'Delete audio' : 'Delete',
        danger: true
      });
      if (!values) return;
      result = await attempt(() => post('/api/meeting/trash', { ids, what: audioOnly ? 'audio' : 'all' }), 'Could not delete');
      if (result) toast(`Moved ${fmtBytes(result.freed)} to the Recycle Bin`);
      if (result && !audioOnly && state.meeting && ids.includes(state.meeting.id)) closeMeeting();
    }
    else if (action === 'rerun') {
      result = await rerun(ids);
    }
    if (!result) return;
    for (const id of ids) state.selected.delete(id);
    await loadLibrary();
    if (state.reopen) {
      const id = state.reopen;
      state.reopen = null;
      openMeeting(id);
    } else if (state.meeting) {
      openMeeting(state.meeting.id, { keepPosition: true });
    }
  }

  // ── Final passes: re-run, queue, import ──

  const LANGUAGES = [
    ['auto', 'Detect automatically'], ['en', 'English'], ['de', 'German'], ['fr', 'French'], ['es', 'Spanish'],
    ['it', 'Italian'], ['nl', 'Dutch'], ['pt', 'Portuguese'], ['pl', 'Polish'], ['tr', 'Turkish'], ['ar', 'Arabic'],
    ['ru', 'Russian'], ['uk', 'Ukrainian'], ['zh', 'Chinese'], ['ja', 'Japanese'], ['ko', 'Korean'], ['hi', 'Hindi']
  ];

  /** Ask which model, language and mode to use, then queue the passes. */
  async function rerun(ids) {
    const withAudio = ids.filter((id) => {
      const meeting = byId(id);
      return meeting && meeting.hasAudio && meeting.state !== 'recording';
    });
    if (!withAudio.length) {
      toast(ids.length === 1 ? 'This meeting has no archived audio to transcribe.' : 'None of these meetings has archived audio.');
      return null;
    }
    const body = await attempt(() => api('/api/models'), 'Could not list the models');
    const models = (body ? body.models : []).filter((model) => model.downloaded && (model.roles || []).includes('final'));
    const settings = { value: '', label: 'As in Settings' };
    const modelOptions = [settings].concat(models.map((model) => ({
      value: model.id,
      label: model.label + (model.estimate && model.estimate.minutes ? ` (≈ ${Math.max(1, Math.round(model.estimate.minutes))} min per hour of meeting)` : '')
    })));
    const skipped = ids.length - withAudio.length;
    const edited = withAudio.some((id) => (byId(id) || {}).hasFinal);
    const values = await ask({
      title: withAudio.length === 1 ? `Re-run “${nameOf(withAudio[0])}”` : `Re-run ${withAudio.length} meetings`,
      text: [
        'Transcribes the archived audio again, in the background, one meeting at a time.',
        edited ? 'The final transcript is rebuilt from the audio: changes you made to it in the library are replaced.' : '',
        skipped ? `${skipped} selected meeting${skipped === 1 ? ' has' : 's have'} no audio and ${skipped === 1 ? 'is' : 'are'} skipped.` : ''
      ].filter(Boolean).join('\n'),
      fields: [
        { name: 'model', label: 'Model', type: 'select', value: '', options: modelOptions },
        { name: 'language', label: 'Language', type: 'select', value: '', options: [settings].concat(LANGUAGES.map(([value, label]) => ({ value, label }))) },
        { name: 'mode', label: 'Mode', type: 'select', value: '', options: [settings, { value: 'fast', label: 'Fast (chunked, in parallel)' }, { value: 'quality', label: 'Quality (one continuous decode)' }] },
        { name: 'diffModel', label: 'Cross-check with a second model', type: 'select', value: 'settings', options: [{ value: 'settings', label: 'As in Settings' }, { value: 'none', label: 'No cross-check' }].concat(models.map((model) => ({ value: model.id, label: model.label }))) }
      ],
      ok: 'Re-run'
    });
    if (!values) return null;
    const overrides = {};
    if (values.model) overrides.model = values.model;
    if (values.language) overrides.language = values.language;
    if (values.mode) overrides.mode = values.mode;
    if (values.diffModel === 'none') overrides.diffModel = '';
    else if (values.diffModel !== 'settings') overrides.diffModel = values.diffModel;
    const result = await attempt(() => post('/api/rerun', { ids: withAudio, overrides }), 'Could not start the re-run');
    if (result) {
      toast(`Queued ${result.queued} final pass${result.queued === 1 ? '' : 'es'}`);
      loadQueue();
    }
    return result;
  }

  async function loadQueue() {
    const body = await attempt(() => api('/api/queue'));
    if (!body) return;
    state.queue = { running: body.running, jobs: body.jobs, message: state.queue && state.queue.message };
    renderQueue();
  }

  function overridesText(overrides) {
    const parts = [overrides.model, overrides.language, overrides.mode].filter(Boolean);
    if (overrides.diffModel) parts.push('cross-check ' + overrides.diffModel);
    return parts.length ? parts.join(' · ') : 'settings';
  }

  function renderQueue() {
    const box = $('queue');
    const queue = state.queue || {};
    const upload = state.upload;
    const nothing = !queue.running && !(queue.jobs || []).length && !upload && !queue.last;
    box.hidden = nothing;
    if (nothing) return;
    const open = (id) => (id ? () => openMeeting(id) : null);
    const rows = [];
    if (upload) {
      rows.push(el('h4', { text: `Uploading ${upload.name}… ${Math.round(upload.pct * 100)}%` }),
        el('div', { class: 'bar' }, el('span', { style: `width:${Math.round(upload.pct * 100)}%` })));
    }
    if (queue.running) {
      const pct = Math.round((queue.running.pct || 0) * 100);
      rows.push(el('div', { class: 'job' }, [
        el('span', { class: 'name', text: queue.running.name, title: 'Open', onclick: open(queue.running.id) }),
        el('span', { class: 'opts', text: overridesText(queue.running.overrides) }),
        queue.running.id ? el('button', { class: 'icon', title: 'Cancel this pass', text: '✕', onclick: () => queueAction('cancel', queue.running.id) }) : null
      ]));
      rows.push(el('div', { class: 'muted', text: queue.message || `Transcribing… ${pct}%` }),
        el('div', { class: 'bar' }, el('span', { style: `width:${pct}%` })));
    } else if (queue.last) {
      rows.push(el('div', { text: queue.last }));
    }
    const jobs = queue.jobs || [];
    if (jobs.length) rows.push(el('h4', { text: `Waiting (${jobs.length})`, style: 'margin-top:8px' }));
    jobs.forEach((job, index) => {
      rows.push(el('div', { class: 'job' }, [
        el('span', { class: 'name', text: job.name, title: 'Open', onclick: open(job.id) }),
        el('span', { class: 'opts', text: overridesText(job.overrides) }),
        job.id ? el('button', { class: 'icon', title: 'Earlier', text: '↑', disabled: index === 0, onclick: () => queueAction('move', job.id, -1) }) : null,
        job.id ? el('button', { class: 'icon', title: 'Later', text: '↓', disabled: index === jobs.length - 1, onclick: () => queueAction('move', job.id, 1) }) : null,
        job.id ? el('button', { class: 'icon', title: 'Remove from the queue', text: '✕', onclick: () => queueAction('remove', job.id) }) : null
      ]));
    });
    box.replaceChildren(...rows);
  }

  async function queueAction(action, id, delta) {
    if (action === 'cancel') {
      const values = await ask({ title: 'Cancel this final pass?', text: 'Its transcript stays as it was. You can re-run it later.', ok: 'Cancel the pass', danger: true });
      if (!values) return;
    }
    const result = await attempt(() => post('/api/queue/' + action, { id, delta }), 'Could not change the queue');
    if (result) loadQueue();
  }

  /** Length of a local audio file, read by the browser before uploading it. */
  function audioDuration(file) {
    return new Promise((resolve) => {
      const audio = new Audio();
      const url = URL.createObjectURL(file);
      const done = (ms) => {
        URL.revokeObjectURL(url);
        resolve(ms);
      };
      audio.preload = 'metadata';
      audio.onloadedmetadata = () => done(Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : 0);
      audio.onerror = () => done(0);
      setTimeout(() => done(0), 8000);
      audio.src = url;
    });
  }

  const localInput = (ms) => {
    const date = new Date(ms);
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  };

  async function importRecording(file) {
    const ext = (file.name.match(/\.([a-z0-9]+)$/i) || [])[1] || '';
    if (!/^(mp3|m4a|wav|flac|ogg|webm)$/i.test(ext)) {
      toast('Pick an mp3, m4a, wav, flac, ogg or webm file');
      return;
    }
    const durationMs = await audioDuration(file);
    const status = await attempt(() => api('/api/status'));
    const realFolder = state.view === 'list' && state.folder && !state.folder.startsWith('tag:') && state.folder !== '/' ? state.folder : '';
    const values = await ask({
      title: 'Import a recording',
      text: `${file.name} · ${fmtBytes(file.size)}${durationMs ? ' · ' + fmtClock(durationMs) : ''}\nA copy is stored as a new meeting; the original file is not touched.`,
      fields: [
        { name: 'name', label: 'Name', value: file.name.replace(/\.[^.]+$/, '') },
        { name: 'when', label: 'Recorded at', type: 'datetime-local', value: localInput(file.lastModified - durationMs || Date.now()) },
        { name: 'folder', label: 'Folder', type: 'select', value: realFolder, options: folderOptions() },
        { name: 'label', label: 'Speaker label', value: 'Speaker' },
        {
          name: 'transcribe', label: 'Transcribe', type: 'select', value: status && status.whisperReady ? '1' : '0',
          options: [{ value: '1', label: 'Now, with the final pass' }, { value: '0', label: 'Later (Re-run from the meeting)' }]
        }
      ],
      ok: 'Import'
    });
    if (!values) return;
    const startedAt = new Date(values.when).getTime() || Date.now();
    const query = new URLSearchParams({
      name: values.name, startedAt: String(startedAt), durationMs: String(durationMs), folder: values.folder,
      label: values.label, ext: ext.toLowerCase(), transcribe: values.transcribe
    });

    state.upload = { name: file.name, pct: 0 };
    renderQueue();
    const result = await new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/import?' + query.toString());
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.upload.onprogress = (event) => {
        if (!event.lengthComputable) return;
        state.upload.pct = event.loaded / event.total;
        renderQueue();
      };
      xhr.onload = () => {
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch (_) {
          resolve({ ok: false, error: 'HTTP ' + xhr.status });
        }
      };
      xhr.onerror = () => resolve({ ok: false, error: 'The upload failed' });
      xhr.send(file);
    });
    state.upload = null;
    renderQueue();
    if (!result.ok) {
      toast('Import failed: ' + result.error);
      return;
    }
    toast(values.transcribe === '1' ? 'Imported; the final pass is queued.' : 'Imported.');
    await loadLibrary();
    loadQueue();
    openMeeting(result.id);
  }

  async function cleanup() {
    const days = Math.max(1, Number($('cleanupDays').value) || 90);
    const cutoff = Date.now() - days * 86400000;
    const ids = state.library.meetings
      .filter((meeting) => meeting.startedAt < cutoff && meeting.hasFinal && meeting.audioBytes > 0 && !meeting.state)
      .map((meeting) => meeting.id);
    if (!ids.length) {
      toast(`No meeting older than ${days} days still has audio next to a final transcript.`);
      return;
    }
    await bulk('audio', ids);
  }

  let searchTimer = null;
  function onSearch() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      const query = $('search').value.trim();
      state.query = query;
      if (!query) {
        state.results = null;
        renderList();
        if (state.meeting) renderTranscript();
        return;
      }
      const body = await attempt(() => api('/api/search?q=' + encodeURIComponent(query)), 'Search failed');
      if (!body || body.query !== $('search').value.trim()) return; // typed on meanwhile
      state.results = new Map(body.results.map((result) => [result.id, result]));
      renderList();
    }, 250);
  }

  // ── Meeting view ──

  function closeMeeting() {
    if (state.player) state.player.destroy();
    state.player = null;
    state.meeting = null;
    history.replaceState(null, '', location.pathname);
    $('meetingView').hidden = true;
    $('placeholder').hidden = false;
  }

  async function openMeeting(id, { keepPosition = false } = {}) {
    const body = await attempt(() => api('/api/meeting?id=' + encodeURIComponent(id)), 'Could not open the meeting');
    if (!body) return;
    const position = keepPosition && state.player ? state.player.position() : null;
    const scroll = keepPosition ? $('detail').scrollTop : 0;
    if (state.player) state.player.destroy();
    const meeting = body.meeting;
    state.meeting = meeting;
    history.replaceState(null, '', '#' + encodeURIComponent(meeting.id));
    document.querySelectorAll('.meeting').forEach((node) => node.classList.toggle('active', node.dataset.id === meeting.id));

    $('placeholder').hidden = true;
    $('meetingView').hidden = false;
    $('meetingTitle').textContent = meeting.title || meeting.name;
    $('meetingMeta').textContent = [fmtDate(meeting.startedAt), fmtDuration(meeting.durationMs), meeting.parent ? 'in ' + meeting.parent : '']
      .filter(Boolean).join(' · ');
    const badges = $('meetingBadges');
    badges.replaceChildren();
    if (meeting.state) badges.append(el('span', { class: 'pill state', text: meeting.state }));
    badges.append(el('span', { class: 'pill' + (meeting.source === 'final' ? ' final' : ''), text: meeting.source === 'final' ? 'final transcript' : meeting.source === 'live' ? 'live transcript' : 'no transcript' }));
    for (const tag of meeting.tags) badges.append(el('span', { class: 'pill', text: '#' + tag }));
    const busy = Boolean(meeting.state);
    for (const button of ['renameBtn', 'moveBtn', 'deleteSelect', 'editMode', 'addMarkerBtn']) $(button).disabled = busy;
    $('rerunBtn').disabled = !meeting.hasAudio || meeting.state === 'recording';
    $('rerunBtn').title = meeting.hasAudio ? 'Transcribe the archived audio again, optionally with another model or language' : 'This meeting has no archived audio';
    if (busy) $('editMode').checked = false;

    renderTranscript();
    renderNotes();
    renderDetails();
    loadGlossary();
    state.player = createPlayer(meeting);
    if (position !== null) state.player.seekTo(position);

    if (keepPosition) {
      $('detail').scrollTop = scroll;
    } else if (queryTerms(state.query).length) {
      const first = $('transcript').querySelector('mark');
      if (first) first.scrollIntoView({ block: 'center' });
    } else {
      $('detail').scrollTop = 0;
    }
  }

  function labelClass(entry, meeting) {
    if (/^Other\b/.test(entry.label || '')) return 'other';
    if (entry.streamId === 'mic') return 'you';
    if (entry.streamId === 'system') return 'them';
    const stream = meeting.streams.find((candidate) => candidate.label === entry.label);
    if (stream) return stream.stream === 'mic' ? 'you' : 'them';
    return entry.label === 'You' ? 'you' : 'them';
  }

  /** Final-pass markup to nodes: ~unsure~, <primary|secondary>, {corrected}. */
  function markupNodes(marked) {
    const nodes = [];
    const pattern = /<([^|<>]*)\|([^<>]*)>|~([^~]+)~|\{([^{}]+)\}/g;
    let last = 0;
    let match;
    while ((match = pattern.exec(marked))) {
      if (match.index > last) nodes.push(marked.slice(last, match.index));
      if (match[1] !== undefined) {
        nodes.push(el('span', { class: 'disagree', title: 'The second model heard: ' + match[2] }, [match[1], el('span', { class: 'alt', text: ' (' + match[2] + ')' })]));
      } else if (match[3] !== undefined) {
        nodes.push(el('span', { class: 'unsure', title: 'The model was unsure of this word', text: match[3] }));
      } else {
        nodes.push(el('span', { class: 'fixed', title: 'Replaced from the corrections list', text: match[4] }));
      }
      last = match.index + match[0].length;
    }
    if (last < marked.length) nodes.push(marked.slice(last));
    return nodes;
  }

  /** Plain words, each a span with its absolute time, for word-by-word follow. */
  function wordNodes(entry) {
    const first = entry.words[0][0];
    return entry.words.map(([start, , word]) => el('span', {
      class: 'word',
      dataset: { t: Math.round(entry.startedAt + (start - first) * 1000) },
      text: word
    }));
  }

  /** One transcript edit; the server rewrites the file and the view reloads. */
  async function edit(op) {
    const meeting = state.meeting;
    const result = await attempt(() => post('/api/meeting/edit', { id: meeting.id, op }), 'Could not save the edit');
    if (result) await openMeeting(meeting.id, { keepPosition: true });
    return Boolean(result);
  }

  function lineTools(entry, index) {
    const at = { index, startedAt: entry.startedAt };
    if (entry.kind === 'marker') {
      return el('span', { class: 'line-tools' }, [
        el('button', { class: 'icon', title: 'Delete marker', text: '✕', onclick: (event) => { event.stopPropagation(); edit({ op: 'marker-delete', ...at }); } })
      ]);
    }
    if (entry.kind !== 'speech') return el('span');
    return el('span', { class: 'line-tools' }, [
      el('button', { class: 'icon', title: 'Edit text', text: '✎', onclick: (event) => { event.stopPropagation(); editText(event.currentTarget.closest('.line'), entry, index); } }),
      el('button', { class: 'icon', title: 'Merge with the next line', text: '⤓', onclick: (event) => { event.stopPropagation(); edit({ op: 'merge', ...at }); } }),
      el('button', {
        class: 'icon',
        title: 'Delete line',
        text: '✕',
        onclick: async (event) => {
          event.stopPropagation();
          const values = await ask({ title: 'Delete this line?', text: entry.text, ok: 'Delete', danger: true });
          if (values) edit({ op: 'delete', ...at });
        }
      })
    ]);
  }

  function editText(row, entry, index) {
    const textarea = el('textarea');
    textarea.value = entry.text;
    const save = () => edit({ op: 'text', index, startedAt: entry.startedAt, text: textarea.value });
    const cancel = () => renderTranscript();
    textarea.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        save();
      } else if (event.key === 'Escape') {
        cancel();
      }
      event.stopPropagation();
    });
    row.querySelector('.text').replaceWith(textarea);
    const tools = row.querySelector('.line-tools');
    if (tools) tools.remove();
    row.append(el('div', { class: 'edit-buttons' }, [
      el('button', { class: 'btn primary small', text: 'Save', onclick: (event) => { event.stopPropagation(); save(); } }),
      el('button', { class: 'btn ghost small', text: 'Cancel', onclick: (event) => { event.stopPropagation(); cancel(); } }),
      el('span', { class: 'muted', text: 'Enter saves · Esc cancels. Word timings for this line are dropped.' })
    ]));
    row.onclick = null;
    textarea.addEventListener('click', (event) => event.stopPropagation());
    textarea.focus();
  }

  async function editLabel(entry, index) {
    const labels = [...new Set(state.meeting.entries.filter((item) => item.kind === 'speech').map((item) => item.label))];
    const values = await ask({
      title: 'Who said this?',
      text: entry.text,
      fields: [{ name: 'label', label: `Speaker (in use: ${labels.join(', ')})`, value: entry.label, required: true }],
      ok: 'Save'
    });
    if (values && values.label !== entry.label) edit({ op: 'label', index, startedAt: entry.startedAt, label: values.label });
  }

  function renderTranscript() {
    const meeting = state.meeting;
    if (!meeting) return;
    const box = $('transcript');
    box.replaceChildren();
    const showMarkup = $('showMarkup').checked;
    const editing = $('editMode').checked && !meeting.state;
    box.classList.toggle('plain', !showMarkup);
    box.classList.toggle('editing', editing);
    $('sourceNote').textContent = meeting.source === 'final'
      ? 'Final pass' + (meeting.asr && meeting.asr.model ? ' · ' + meeting.asr.model : '')
      : meeting.source === 'live' ? 'Live transcript (no final pass yet)' : 'This meeting has no transcript.';

    meeting.entries.forEach((entry, index) => {
      const time = el('span', { class: 't', text: entry.clock || new Date(entry.startedAt).toLocaleTimeString() });
      if (entry.kind === 'screenshot') {
        box.append(el('div', { class: 'event', dataset: { index }, onclick: () => seekTo(entry.startedAt) }, [
          time,
          el('div', {}, ['Screenshot ' + entry.text, el('img', { src: mediaUrl(meeting.id, entry.text), alt: 'Screenshot ' + entry.text, loading: 'lazy' })]),
          editing ? el('span') : null
        ]));
        return;
      }
      if (entry.kind === 'marker') {
        box.append(el('div', { class: 'event', dataset: { index }, onclick: () => seekTo(entry.startedAt) }, [
          time, el('div', { text: '⚑ Marker' + (entry.text ? ': ' + entry.text : '') }),
          editing ? lineTools(entry, index) : null
        ]));
        return;
      }
      const text = el('span', { class: 'text' });
      if (showMarkup && entry.marked) text.append(...markupNodes(entry.marked));
      else if (!showMarkup && entry.words && entry.words.length) text.append(...wordNodes(entry));
      else text.textContent = entry.text;
      const who = el('span', { class: 'who ' + labelClass(entry, meeting), text: entry.label });
      if (editing) {
        who.title = 'Change the speaker';
        who.addEventListener('click', (event) => {
          event.stopPropagation();
          editLabel(entry, index);
        });
      }
      box.append(el('div', {
        class: 'line',
        dataset: { index, start: entry.startedAt, end: entry.endedAt || entry.startedAt },
        onclick: () => { if (!window.getSelection().toString()) seekTo(entry.startedAt, true); },
        ondblclick: editing ? (event) => editText(event.currentTarget, entry, index) : null
      }, [time, who, text, editing ? lineTools(entry, index) : null]));
    });

    highlightTerms(box, queryTerms(state.query));
    if (state.player) state.player.refresh();
  }

  function renderNotes() {
    const meeting = state.meeting;
    const form = $('infoForm');
    form.elements.title.value = meeting.title || '';
    form.elements.participants.value = meeting.participants || '';
    form.elements.tags.value = meeting.tags.join(', ');
    form.elements.notes.value = meeting.notes || '';
    $('infoSaved').textContent = '';
  }

  async function saveNotes(event) {
    event.preventDefault();
    const form = $('infoForm');
    const info = {
      title: form.elements.title.value,
      participants: form.elements.participants.value,
      tags: form.elements.tags.value,
      notes: form.elements.notes.value
    };
    const id = state.meeting.id;
    const result = await attempt(() => post('/api/meeting/info', { id, info }), 'Could not save');
    if (!result) return;
    $('infoSaved').textContent = 'Saved.';
    await loadLibrary();
    const fresh = byId(id);
    if (fresh) {
      state.meeting.title = fresh.title;
      state.meeting.tags = fresh.tags;
      $('meetingTitle').textContent = fresh.title || fresh.name;
    }
  }

  function renderDetails() {
    const meeting = state.meeting;
    const list = $('detailsList');
    list.replaceChildren();
    const rows = [
      ['Folder', meeting.id],
      ['Started', fmtDate(meeting.startedAt)],
      ['Ended', meeting.stoppedAt ? fmtDate(meeting.stoppedAt) : ''],
      ['Length', fmtDuration(meeting.durationMs)],
      ['Size on disk', `${fmtBytes(meeting.bytes)} (audio ${fmtBytes(meeting.audioBytes)})`],
      ['Audio', meeting.streams.map((stream) => `${stream.label} (${stream.file})`).join(', ') || 'none'],
      ['Screenshots', String(meeting.screenshots)],
      ['Transcript', meeting.source],
      ['Model', meeting.asr ? [meeting.asr.model, meeting.asr.language, meeting.asr.device].filter(Boolean).join(' · ') : ''],
      ['Glossary used', meeting.asr && meeting.asr.glossary ? meeting.asr.glossary.join(', ') : '']
    ];
    for (const [key, value] of rows) {
      if (!value) continue;
      list.append(el('dt', { text: key }), el('dd', { text: value }));
    }
  }

  // ── Glossary and corrections ──

  async function loadGlossary() {
    const id = state.meeting.id;
    const [glossary, corrections] = await Promise.all([
      attempt(() => api('/api/glossary?id=' + encodeURIComponent(id))),
      attempt(() => api('/api/corrections?id=' + encodeURIComponent(id)))
    ]);
    if (!state.meeting || state.meeting.id !== id) return;
    $('glossaryText').value = glossary ? glossary.text : '';
    $('glossarySaved').textContent = '';
    state.corrections = corrections ? corrections.rules.map((rule) => ({ ...rule })) : [];
    $('correctionsSaved').textContent = '';
    renderCorrections();
  }

  function renderCorrections() {
    const table = $('correctionsTable');
    table.replaceChildren(
      el('span', { class: 'muted', text: 'Heard' }), el('span'), el('span', { class: 'muted', text: 'Correct' }), el('span')
    );
    state.corrections.forEach((rule, index) => {
      const from = el('input', { type: 'text', value: rule.from, 'aria-label': 'Heard', oninput: (event) => { rule.from = event.target.value; } });
      const to = el('input', { type: 'text', value: rule.to, 'aria-label': 'Correct', oninput: (event) => { rule.to = event.target.value; } });
      table.append(from, el('span', { class: 'arrow', text: '→' }), to,
        el('button', { class: 'icon', title: 'Remove', text: '✕', onclick: () => { state.corrections.splice(index, 1); renderCorrections(); } }));
    });
  }

  async function saveCorrections(id, rules) {
    return attempt(() => post('/api/corrections', { id, rules }), 'Could not save the corrections');
  }

  async function globalCorrections() {
    const body = await attempt(() => api('/api/corrections?id='), 'Could not load the corrections');
    if (!body) return;
    const text = body.rules.map((rule) => `${rule.from} => ${rule.to}`).join('\n');
    const values = await ask({
      title: 'Corrections for all meetings',
      text: 'Every new meeting starts with a copy of this list. One per line: heard => correct',
      fields: [{ name: 'rules', label: 'Corrections', type: 'textarea', rows: 12, value: text }],
      ok: 'Save'
    });
    if (!values) return;
    const rules = values.rules.split('\n').map((line) => line.split('=>')).filter((parts) => parts.length === 2)
      .map(([from, to]) => ({ from: from.trim(), to: to.trim() }));
    const result = await saveCorrections('', rules);
    if (result) toast(`Saved ${result.rules.length} corrections`);
  }

  /** Select a word in the transcript, then click the button that appears. */
  function bindSelectionCorrection() {
    const pop = $('correctionPop');
    document.addEventListener('mouseup', () => {
      setTimeout(() => {
        const selection = window.getSelection();
        const text = selection.toString().trim();
        const inside = selection.rangeCount && $('transcript').contains(selection.anchorNode);
        if (!text || !inside || text.length > 60 || !state.meeting) {
          pop.hidden = true;
          return;
        }
        const rect = selection.getRangeAt(0).getBoundingClientRect();
        pop.style.left = `${rect.left + window.scrollX}px`;
        pop.style.top = `${rect.bottom + window.scrollY + 6}px`;
        pop.dataset.text = text;
        pop.hidden = false;
      }, 0);
    });
    pop.addEventListener('mousedown', (event) => event.preventDefault());
    pop.addEventListener('click', async () => {
      pop.hidden = true;
      const heard = pop.dataset.text;
      const values = await ask({
        title: 'Add a correction',
        text: 'Applied every time a final pass runs for this meeting.',
        fields: [
          { name: 'from', label: 'Heard', value: heard, required: true },
          { name: 'to', label: 'Should be', value: heard, required: true },
          { name: 'scope', label: 'For', type: 'select', value: 'meeting', options: [{ value: 'meeting', label: 'This meeting' }, { value: 'all', label: 'This meeting and all new meetings' }] }
        ],
        ok: 'Add'
      });
      if (!values) return;
      const rule = { from: values.from.trim(), to: values.to.trim() };
      state.corrections = state.corrections.filter((existing) => existing.from.toLowerCase() !== rule.from.toLowerCase()).concat(rule);
      const saved = await saveCorrections(state.meeting.id, state.corrections);
      if (!saved) return;
      if (values.scope === 'all') {
        const global = await attempt(() => api('/api/corrections?id='));
        if (global) await saveCorrections('', global.rules.filter((existing) => existing.from.toLowerCase() !== rule.from.toLowerCase()).concat(rule));
      }
      renderCorrections();
      toast('Correction saved. It applies the next time the final pass runs.');
    });
  }

  // ── Header actions ──

  async function renameMeeting() {
    const meeting = state.meeting;
    const values = await ask({
      title: 'Rename meeting',
      text: 'The folder becomes "<name>_' + (meeting.name.match(/\d{4}-\d{2}-\d{2}_\d{2}-\d{2}/) || [''])[0] + '" so it still sorts by date. Leave empty for the date alone.',
      fields: [{ name: 'name', label: 'Name', value: meeting.title || meeting.prefix || '' }],
      ok: 'Rename'
    });
    if (!values) return;
    const result = await attempt(() => post('/api/meeting/rename', { id: meeting.id, name: values.name }), 'Could not rename');
    if (!result) return;
    await loadLibrary();
    openMeeting(result.id, { keepPosition: true });
  }

  async function copyForLlm() {
    const meeting = state.meeting;
    const markup = $('showMarkup').checked && meeting.source === 'final' ? '1' : '0';
    const response = await fetch(`/api/export?id=${encodeURIComponent(meeting.id)}&format=llm&markup=${markup}&inline=1`, { credentials: 'same-origin' });
    if (!response.ok) return toast('Could not build the text');
    const text = await response.text();
    try {
      await navigator.clipboard.writeText(text);
      toast(`Copied ${text.length.toLocaleString()} characters`);
    } catch (_) {
      toast('The browser refused clipboard access');
    }
  }

  function exportMeeting(format) {
    if (!format) return;
    const markup = $('showMarkup').checked ? '1' : '0';
    const link = el('a', { href: `/api/export?id=${encodeURIComponent(state.meeting.id)}&format=${format}&markup=${markup}` });
    document.body.append(link);
    link.click();
    link.remove();
  }

  async function addMarker() {
    if (!state.meeting || state.meeting.state) return;
    const at = state.player ? state.player.absolute() : state.meeting.startedAt;
    const values = await ask({ title: 'Add a marker at ' + new Date(at).toLocaleTimeString(), fields: [{ name: 'text', label: 'Label (optional)' }], ok: 'Add' });
    if (values) edit({ op: 'marker-add', startedAt: at, text: values.text });
  }

  // ── Player ──
  //
  // One <audio> per archived stream. Each stream started at its own wall-clock
  // time, so the timeline position t (ms since the earliest stream started)
  // maps to stream time t - offset. The stream that covers t drives the clock;
  // the others are nudged back whenever they drift more than 300 ms.

  function createPlayer(meeting) {
    const holder = $('streams');
    holder.replaceChildren();
    const hasAudio = meeting.streams.length > 0;
    $('noAudio').hidden = hasAudio;
    for (const id of ['playBtn', 'seek', 'speed', 'skipSilence', 'loopLine']) $(id).disabled = !hasAudio;

    const base = hasAudio
      ? Math.min(...meeting.streams.map((stream) => stream.startedAt))
      : (meeting.entries[0] && meeting.entries[0].startedAt) || meeting.startedAt;
    const tracks = meeting.streams.map((stream) => {
      const audio = new Audio(mediaUrl(meeting.id, stream.file));
      audio.preload = 'metadata';
      holder.append(audio);
      return { ...stream, audio, offset: stream.startedAt - base, length: stream.durationMs };
    });
    const total = Math.max(1, ...tracks.map((track) => track.offset + track.length),
      ...meeting.entries.map((entry) => (entry.endedAt || entry.startedAt) - base));
    tracks.forEach((track) => track.audio.addEventListener('loadedmetadata', () => {
      if (!track.length && Number.isFinite(track.audio.duration)) track.length = track.audio.duration * 1000;
    }));

    const speech = meeting.entries
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.kind === 'speech')
      .map(({ entry, index }) => ({ index, start: entry.startedAt - base, end: (entry.endedAt || entry.startedAt) - base }));

    const player = {
      t: 0,
      playing: false,
      solo: null,
      wallAt: 0,
      raf: null,
      current: -1,
      loopIndex: -1
    };

    const inRange = (track, t) => t >= track.offset && t < track.offset + (track.length || Infinity);

    function setClock(t) {
      player.t = Math.max(0, Math.min(total, t));
      $('clock').textContent = fmtClock(player.t);
      if (document.activeElement !== $('seek')) $('seek').value = String(Math.round((player.t / total) * 1000));
    }

    function syncTracks(force) {
      for (const track of tracks) {
        track.audio.muted = player.solo !== null && player.solo !== track.stream;
        track.audio.playbackRate = Number($('speed').value);
        if (!inRange(track, player.t)) {
          if (!track.audio.paused) track.audio.pause();
          continue;
        }
        const target = (player.t - track.offset) / 1000;
        if (force || Math.abs(track.audio.currentTime - target) > 0.3) {
          try { track.audio.currentTime = target; } catch (_) { /* not seekable yet */ }
        }
        if (player.playing && track.audio.paused) track.audio.play().catch(() => {});
        if (!player.playing && !track.audio.paused) track.audio.pause();
      }
    }

    function currentLine(t) {
      let found = -1;
      for (let i = 0; i < speech.length; i++) {
        if (speech[i].start > t) break;
        if (t < speech[i].end + 250) found = i;
      }
      return found;
    }

    function markCurrent(t, forceScroll) {
      const line = currentLine(t);
      const box = $('transcript');
      if (line !== player.current || forceScroll) {
        box.querySelectorAll('.line.current').forEach((node) => node.classList.remove('current'));
        player.current = line;
        if (line >= 0) {
          const node = box.querySelector(`.line[data-index="${speech[line].index}"]`);
          if (node) {
            node.classList.add('current');
            if (player.playing && $('follow').checked) node.scrollIntoView({ block: 'center', behavior: 'smooth' });
          }
        }
      }
      // Word follow, in the plain view only (words carry times there).
      const abs = base + t;
      box.querySelectorAll('.word.now').forEach((node) => node.classList.remove('now'));
      if (line >= 0) {
        const words = box.querySelectorAll(`.line[data-index="${speech[line].index}"] .word`);
        let now = null;
        for (const word of words) {
          if (Number(word.dataset.t) <= abs) now = word;
          else break;
        }
        if (now) now.classList.add('now');
      }
    }

    function tick() {
      player.raf = null;
      if (!player.playing) return;
      const driver = tracks.find((track) => inRange(track, player.t) && !track.audio.paused && track.audio.readyState >= 2);
      const now = performance.now();
      let t;
      if (driver) t = driver.offset + driver.audio.currentTime * 1000;
      else t = player.t + (now - player.wallAt) * Number($('speed').value);
      player.wallAt = now;

      if ($('loopLine').checked && player.loopIndex >= 0) {
        const line = speech[player.loopIndex];
        if (t > line.end + 150) {
          seek(line.start, false);
          return schedule();
        }
      } else if ($('skipSilence').checked) {
        const inside = speech.some((line) => t >= line.start - 300 && t < line.end + 300);
        const next = speech.find((line) => line.start > t);
        if (!inside && next && next.start - t > 2000) {
          seek(next.start - 300, false);
          return schedule();
        }
      }
      if (t >= total) {
        setClock(total);
        pause();
        return;
      }
      setClock(t);
      syncTracks(false);
      markCurrent(t);
      schedule();
    }

    function schedule() {
      if (!player.raf && player.playing) player.raf = requestAnimationFrame(tick);
    }

    function play() {
      if (!hasAudio) return;
      if (player.t >= total) setClock(0);
      player.playing = true;
      player.wallAt = performance.now();
      $('playBtn').textContent = '❚❚';
      $('playBtn').setAttribute('aria-label', 'Pause');
      syncTracks(true);
      schedule();
    }

    function pause() {
      player.playing = false;
      $('playBtn').textContent = '▶';
      $('playBtn').setAttribute('aria-label', 'Play');
      for (const track of tracks) track.audio.pause();
    }

    function seek(t, keepLoop = true) {
      setClock(t);
      player.wallAt = performance.now();
      syncTracks(true);
      markCurrent(player.t);
      if (!keepLoop) return;
      player.loopIndex = $('loopLine').checked ? currentLine(player.t) : -1;
    }

    // Solo buttons: both, or one stream.
    const solo = $('solo');
    solo.replaceChildren();
    if (tracks.length > 1) {
      const options = [{ id: null, label: 'Both' }, ...tracks.map((track) => ({ id: track.stream, label: track.label }))];
      for (const option of options) {
        solo.append(el('button', {
          class: option.id === null ? 'active' : '',
          title: option.id ? 'Play only ' + option.label : 'Play both streams',
          onclick: (event) => {
            player.solo = option.id;
            solo.querySelectorAll('button').forEach((node) => node.classList.remove('active'));
            event.currentTarget.classList.add('active');
            syncTracks(false);
          }
        }, option.label));
      }
    }

    $('duration').textContent = fmtClock(total);
    setClock(0);
    markCurrent(0);

    return {
      toggle: () => (player.playing ? pause() : play()),
      pause,
      position: () => player.t,
      absolute: () => base + player.t,
      seekTo: (t) => seek(t),
      seekAbs: (abs, start) => {
        seek(abs - base);
        if (start && !player.playing) play();
      },
      seekBy: (ms) => seek(player.t + ms),
      seekFraction: (fraction) => seek(fraction * total),
      line: (step) => {
        const index = player.current >= 0 ? player.current : currentLine(player.t);
        const next = speech[Math.max(0, Math.min(speech.length - 1, (index < 0 ? -1 : index) + step))];
        if (next) seek(next.start);
      },
      setLoop: (on) => { player.loopIndex = on ? currentLine(player.t) : -1; },
      refresh: () => { syncTracks(false); markCurrent(player.t, true); },
      destroy: () => {
        pause();
        if (player.raf) cancelAnimationFrame(player.raf);
        for (const track of tracks) {
          track.audio.removeAttribute('src');
          track.audio.load();
        }
        holder.replaceChildren();
      }
    };
  }

  function seekTo(abs, start) {
    if (state.player && !$('editMode').checked) state.player.seekAbs(abs, start);
    else if (state.player) state.player.seekAbs(abs, false);
  }

  // ── Live updates ──

  function connectEvents() {
    const source = new EventSource('/api/events');
    source.onopen = () => { $('connection').textContent = 'Connected to MeetScribe'; };
    source.onerror = () => { $('connection').textContent = 'Reconnecting to MeetScribe…'; };
    let refreshTimer = null;
    const refreshSoon = () => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(async () => {
        await loadLibrary();
        if (state.meeting) {
          const fresh = byId(state.meeting.id);
          if (fresh && fresh.state !== state.meeting.state) openMeeting(state.meeting.id, { keepPosition: true });
        }
      }, 400);
    };
    source.addEventListener('library', refreshSoon);
    let lastTimer = null;
    source.addEventListener('final-pass', (event) => {
      const data = JSON.parse(event.data);
      const queue = state.queue || (state.queue = { jobs: [] });
      if (data.state === 'done' || data.state === 'failed' || data.state === 'cancelled') {
        queue.message = null;
        queue.last = data.message || null;
        clearTimeout(lastTimer);
        lastTimer = setTimeout(() => {
          queue.last = null;
          renderQueue();
        }, 8000);
        loadQueue();
        refreshSoon();
        return;
      }
      queue.message = data.message || null;
      if (queue.running && typeof data.pct === 'number') {
        queue.running.pct = data.pct;
        renderQueue();
      } else {
        loadQueue();
      }
      if (data.state === 'starting' || data.state === 'queued') refreshSoon();
    });
  }

  // ── Wiring ──

  function bind() {
    $('search').addEventListener('input', onSearch);
    $('sort').addEventListener('change', renderList);
    $('showMarkup').addEventListener('change', renderTranscript);
    $('editMode').addEventListener('change', renderTranscript);
    $('playBtn').addEventListener('click', () => state.player && state.player.toggle());
    $('seek').addEventListener('input', () => state.player && state.player.seekFraction(Number($('seek').value) / 1000));
    $('speed').addEventListener('change', () => state.player && state.player.refresh());
    $('loopLine').addEventListener('change', () => state.player && state.player.setLoop($('loopLine').checked));
    $('addMarkerBtn').addEventListener('click', addMarker);
    $('renameBtn').addEventListener('click', renameMeeting);
    $('moveBtn').addEventListener('click', () => bulk('move', [state.meeting.id]));
    $('copyLlmBtn').addEventListener('click', copyForLlm);
    $('rerunBtn').addEventListener('click', () => bulk('rerun', [state.meeting.id]));
    $('importBtn').addEventListener('click', () => $('importFile').click());
    $('importFile').addEventListener('change', (event) => {
      const file = event.target.files[0];
      event.target.value = '';
      if (file) importRecording(file);
    });
    $('exportSelect').addEventListener('change', (event) => {
      exportMeeting(event.target.value);
      event.target.value = '';
    });
    $('deleteSelect').addEventListener('change', (event) => {
      const what = event.target.value;
      event.target.value = '';
      if (what) bulk(what === 'audio' ? 'audio' : 'trash', [state.meeting.id]);
    });
    $('infoForm').addEventListener('submit', saveNotes);
    $('glossarySave').addEventListener('click', async () => {
      const result = await attempt(() => post('/api/meeting/glossary', { id: state.meeting.id, text: $('glossaryText').value }), 'Could not save the glossary');
      if (result) $('glossarySaved').textContent = 'Saved. It applies the next time the final pass runs.';
    });
    $('correctionAdd').addEventListener('click', () => {
      state.corrections.push({ from: '', to: '' });
      renderCorrections();
      const inputs = $('correctionsTable').querySelectorAll('input');
      if (inputs.length) inputs[inputs.length - 2].focus();
    });
    $('correctionsSave').addEventListener('click', async () => {
      const result = await saveCorrections(state.meeting.id, state.corrections);
      if (!result) return;
      state.corrections = result.rules.map((rule) => ({ ...rule }));
      renderCorrections();
      $('correctionsSaved').textContent = 'Saved.';
    });
    $('globalCorrectionsBtn').addEventListener('click', globalCorrections);
    $('storageBtn').addEventListener('click', () => {
      state.view = 'storage';
      renderFolders();
      renderList();
    });
    $('cleanupBtn').addEventListener('click', cleanup);
    document.querySelectorAll('[data-bulk]').forEach((button) => button.addEventListener('click', () => {
      const action = button.dataset.bulk;
      if (action === 'clear') {
        state.selected.clear();
        renderList();
        return;
      }
      bulk(action, [...state.selected]);
    }));

    document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((node) => node.classList.toggle('active', node === tab));
      document.querySelectorAll('.tab-page').forEach((page) => { page.hidden = page.id !== 'tab-' + tab.dataset.tab; });
    }));

    bindSelectionCorrection();

    document.addEventListener('keydown', (event) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName) && event.target.type !== 'checkbox' && event.target.type !== 'range';
      if (event.key === 'Escape' && event.target === $('search')) {
        $('search').value = '';
        onSearch();
        $('search').blur();
        return;
      }
      if (typing || $('dialog').open || event.ctrlKey || event.metaKey || event.altKey) return;
      const player = state.player;
      switch (event.key) {
        case '/':
          event.preventDefault();
          $('search').focus();
          break;
        case ' ':
          if (!player) return;
          event.preventDefault();
          player.toggle();
          break;
        case 'ArrowLeft':
          if (player) { event.preventDefault(); player.seekBy(-5000); }
          break;
        case 'ArrowRight':
          if (player) { event.preventDefault(); player.seekBy(5000); }
          break;
        case 'j':
        case 'J':
          if (player) player.line(-1);
          break;
        case 'k':
        case 'K':
          if (player) player.line(1);
          break;
        case 'l':
        case 'L':
          $('loopLine').checked = !$('loopLine').checked;
          if (player) player.setLoop($('loopLine').checked);
          break;
        case 'm':
        case 'M':
          addMarker();
          break;
        case '[':
        case ']': {
          const select = $('speed');
          const index = select.selectedIndex + (event.key === ']' ? 1 : -1);
          if (index >= 0 && index < select.options.length) {
            select.selectedIndex = index;
            if (player) player.refresh();
            toast('Speed ' + select.value + '×');
          }
          break;
        }
        default:
      }
    });
  }

  async function start() {
    bind();
    await loadLibrary();
    connectEvents();
    loadQueue();
    const id = decodeURIComponent(location.hash.slice(1));
    if (id && byId(id)) openMeeting(id);
  }

  start();
})();
