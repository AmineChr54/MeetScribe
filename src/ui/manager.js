/* MeetScribe Library: the browser manager page. Served by
 * src/services/manager-server.service.js; talks to it over same-origin fetch
 * and Server-Sent Events. Plain script, no framework, no build step. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const INBOX = '/';
  const state = {
    library: { folders: [], meetings: [] },
    folder: INBOX,         // '/' = the inbox (not in a folder), 'tag:x', or a folder id
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

  // ── Icons ──
  //
  // 24×24 stroke paths drawn for this page. `filled` ones are solid shapes.

  const ICONS = {
    plus: 'M12 5v14M5 12h14',
    x: 'M6 6l12 12M18 6L6 18',
    square: 'M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z',
    'check-square': 'M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM8 12.5l3 3 5.5-6.5',
    check: 'M5 12.5l4.5 4.5L19 7',
    'chevron-down': 'M6 9l6 6 6-6',
    'arrow-up': 'M12 19V5M6 11l6-6 6 6',
    'arrow-down': 'M12 5v14M6 13l6 6 6-6',
    search: 'M17.5 11a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0zM16 16l4.5 4.5',
    inbox: 'M3 13l3-8h12l3 8v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zM3 13h5l1.5 2.5h5L16 13h5',
    folder: 'M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
    'folder-plus': 'M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM12 10.5v6M9 13.5h6',
    'folder-move': 'M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM8.5 13.5h7M12.5 10.5l3 3-3 3',
    tag: 'M3 12V4h8l10 10-8 8zM7.5 7.5v.01',
    book: 'M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5zM5 19.5A1.5 1.5 0 0 0 6.5 21H19v-3M9 7.5h6M9 11h4',
    mic: 'M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zM5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21',
    layers: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5M3 17.5l9 4.5 9-4.5',
    chip: 'M7 7h10v10H7zM10 10h4v4h-4zM9.5 3v4M14.5 3v4M9.5 17v4M14.5 17v4M3 9.5h4M3 14.5h4M17 9.5h4M17 14.5h4',
    sliders: 'M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1M15 4v4M9 10v4M17 16v4',
    upload: 'M12 15V4M7.5 8.5L12 4l4.5 4.5M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3',
    download: 'M12 4v11M7.5 10.5L12 15l4.5-4.5M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3',
    drive: 'M3 13l3-8h12l3 8v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zM3 13h18M7 16h.01M10.5 16h.01',
    spell: 'M3 17l4-11 4 11M4.5 13h5M13.5 14l3 3 5-6',
    pencil: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4',
    trash: 'M4 7h16M10 3.5h4M6 7l1 13h10l1-13M10 11v5.5M14 11v5.5',
    'volume-x': 'M4 9h4l5-4v14l-5-4H4zM17 9.5l5 5M22 9.5l-5 5',
    refresh: 'M20 11a8 8 0 0 0-14.6-4.5L4 8.5M4 4v4.5h4.5M4 13a8 8 0 0 0 14.6 4.5l1.4-2M20 20v-4.5h-4.5',
    copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
    sparkles: 'M11 3l1.9 5.1L18 10l-5.1 1.9L11 17l-1.9-5.1L4 10l5.1-1.9zM18.5 15l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z',
    play: '!M7.5 4.8v14.4a.8.8 0 0 0 1.2.7l11.3-7.2a.8.8 0 0 0 0-1.4L8.7 4.1a.8.8 0 0 0-1.2.7z',
    pause: '!M6.5 4.5h3.8v15H6.5zM13.7 4.5h3.8v15h-3.8z',
    repeat: 'M17 3l3 3-3 3M4 11.5V9a3 3 0 0 1 3-3h13M7 21l-3-3 3-3M20 12.5V15a3 3 0 0 1-3 3H4',
    'fast-forward': 'M3.5 6l8 6-8 6zM12.5 6l8 6-8 6z',
    target: 'M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0z',
    flag: 'M5 21V4M5 4h12l-2.5 4.5L17 13H5',
    eye: 'M2.5 12S6 5 12 5s9.5 7 9.5 7-3.5 7-9.5 7-9.5-7-9.5-7zM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
    text: 'M4 6h16M4 10.5h16M4 15h11M4 19.5h7',
    notes: 'M5 3h10l4 4v14H5zM14.5 3v4.5H19M8.5 12h7M8.5 16h5',
    info: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0zM12 11v6M12 7.5v.01',
    monitor: 'M3 4.5h18v11.5H3zM8 20h8M12 16v4',
    cloud: 'M7 18.5a4.5 4.5 0 0 1-.6-9A6 6 0 0 1 18 9a4.75 4.75 0 0 1 .3 9.5zM12 11v6M9.5 14.5L12 17l2.5-2.5',
    globe: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0zM3 12h18M12 3c2.5 2.6 3.7 5.6 3.7 9s-1.2 6.4-3.7 9M12 3C9.5 5.6 8.3 8.6 8.3 12s1.2 6.4 3.7 9',
    star: 'M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.8z',
    heart: 'M12 20s-7.5-4.6-9-9.2C2 7.5 4.2 5 7 5c2 0 3.6 1.1 5 3 1.4-1.9 3-3 5-3 2.8 0 5 2.5 4 5.8-1.5 4.6-9 9.2-9 9.2z',
    duplicate: 'M8 8h12v12H8zM4 16V4h12M14 11v6M11 14h6',
    external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
    clock: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0zM12 7v5l3.5 2',
    disk: 'M5 3h11l3 3v15H5zM8 3v5h7V3M8 21v-7h8v7',
    'merge-down': 'M12 3v12M7 10l5 5 5-5M5 20h14',
    user: 'M16 8a4 4 0 1 1-8 0 4 4 0 0 1 8 0zM4.5 21a7.5 7.5 0 0 1 15 0',
    power: 'M12 3v8M6.4 6.5a8 8 0 1 0 11.2 0'
  };

  const SVG_NS = 'http://www.w3.org/2000/svg';
  function icon(name, extraClass = '') {
    const raw = ICONS[name] || ICONS.info;
    const filled = raw.startsWith('!');
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'i' + (filled ? ' filled' : '') + (extraClass ? ' ' + extraClass : ''));
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', filled ? raw.slice(1) : raw);
    svg.append(path);
    return svg;
  }

  /** <i data-icon="x"> in the static page becomes the SVG. */
  function hydrateIcons(root = document) {
    root.querySelectorAll('i[data-icon]').forEach((node) => {
      const svg = icon(node.dataset.icon);
      if (node.id) svg.id = node.id;
      node.replaceWith(svg);
    });
  }

  function setIcon(target, name) {
    const old = target.querySelector('svg.i');
    const next = icon(name);
    if (old) old.replaceWith(next);
    else target.prepend(next);
  }

  /** An icon-only button with a tooltip. */
  function iconButton(name, title, onclick, extraClass = '') {
    return el('button', { class: 'icon-btn small ' + extraClass, title, 'aria-label': title, type: 'button', onclick }, icon(name));
  }

  /** A text button with a leading icon. */
  function button(name, label, onclick, extraClass = '', title = null) {
    return el('button', { class: 'btn ' + extraClass, type: 'button', title, onclick }, [icon(name), label]);
  }

  function flagNode(code) {
    const span = el('span', { class: 'flag', title: window.MeetScribeFlags ? window.MeetScribeFlags.label(code) : code });
    // Static SVG markup built from numbers in flags.js, nothing from the server.
    if (window.MeetScribeFlags) span.innerHTML = window.MeetScribeFlags.svg(code);
    return span;
  }

  // ── Menu ──

  /** A small pop-up menu under `anchor`: [{ icon, label, hint, danger, onclick } | 'sep']. */
  function openMenu(anchor, items) {
    const menu = $('menu');
    menu.replaceChildren(...items.map((item) => (item === 'sep' ? el('hr') : el('button', {
      class: item.danger ? 'danger' : '',
      role: 'menuitem',
      type: 'button',
      onclick: () => {
        closeMenu();
        item.onclick();
      }
    }, [icon(item.icon), el('span', {}, [item.label, item.hint ? el('small', { text: item.hint }) : null])]))));
    menu.hidden = false;
    const rect = anchor.getBoundingClientRect();
    const width = menu.offsetWidth;
    menu.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, rect.right - width))}px`;
    menu.style.top = `${Math.min(window.innerHeight - menu.offsetHeight - 8, rect.bottom + 6)}px`;
    const first = menu.querySelector('button');
    if (first) first.focus();
    setTimeout(() => document.addEventListener('mousedown', outsideMenu), 0);
  }

  function outsideMenu(event) {
    if (!$('menu').contains(event.target)) closeMenu();
  }

  function closeMenu() {
    $('menu').hidden = true;
    document.removeEventListener('mousedown', outsideMenu);
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
      if (field.type === 'checks') {
        // Several checkboxes; the value is the list of ticked option values.
        const chosen = new Set(field.value || []);
        const boxes = field.options.map((option) => {
          const box = el('input', { type: 'checkbox', value: option.value });
          box.checked = chosen.has(option.value);
          return el('label', { class: 'chip' }, [box, icon(field.icon || 'check'), option.label]);
        });
        inputs[field.name] = { type: 'checks', get value() { return boxes.map((label) => label.querySelector('input')).filter((box) => box.checked).map((box) => box.value); } };
        box.append(el('div', {}, [
          el('div', { class: 'group-label', text: field.label }),
          boxes.length ? el('div', { class: 'pick-chips' }, boxes) : el('div', { class: 'muted small', text: field.empty || 'Nothing to pick.' })
        ]));
        continue;
      }
      if (field.type === 'flags') {
        let current = field.value || 'custom';
        const choices = (window.MeetScribeFlags ? window.MeetScribeFlags.codes : ['custom']).map((code) => {
          const choice = el('button', {
            type: 'button',
            class: 'flag-choice' + (code === current ? ' selected' : ''),
            title: window.MeetScribeFlags ? window.MeetScribeFlags.label(code) : code,
            onclick: () => {
              current = code;
              choices.forEach((node) => node.classList.toggle('selected', node === choice));
            }
          }, flagNode(code));
          return choice;
        });
        inputs[field.name] = { type: 'flags', get value() { return current; } };
        box.append(el('div', {}, [el('div', { class: 'group-label', text: field.label }), el('div', { class: 'flag-pick' }, choices)]));
        continue;
      }
      if (field.type === 'select') {
        input = el('select', { name: field.name }, field.options.map((option) => el('option', { value: option.value, text: option.label })));
        input.value = field.value || '';
      } else if (field.type === 'textarea') {
        input = el('textarea', { name: field.name, rows: field.rows || 4 });
        input.value = field.value || '';
      } else if (field.type === 'checkbox') {
        input = el('input', { type: 'checkbox', name: field.name });
        input.checked = Boolean(field.value);
        inputs[field.name] = input;
        box.append(el('label', { class: 'check' }, [input, field.label]));
        continue;
      } else {
        input = el('input', { type: field.type || 'text', name: field.name, placeholder: field.placeholder, required: field.required });
        input.value = field.value || '';
      }
      inputs[field.name] = input;
      // Enter in a one-line field means OK. Said explicitly: implicit form
      // submission picks the first submit button, which once was Cancel.
      if (input.tagName === 'INPUT') {
        input.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter' || event.isComposing) return;
          event.preventDefault();
          if ($('dialogForm').reportValidity()) dialog.close('ok');
        });
      }
      box.append(el('label', {}, [field.label, input]));
    }
    if (list) box.append(el('ul', {}, list.map((item) => el('li', { text: item }))));
    const okButton = $('dialogOk');
    okButton.replaceChildren(icon(danger ? 'trash' : 'check'), ok);
    okButton.className = 'btn ' + (danger ? 'danger' : 'primary');
    dialog.returnValue = '';
    dialog.showModal();
    const first = Object.values(inputs).find((input) => input instanceof HTMLElement);
    if (first) {
      first.focus();
      if (first.select) first.select();
    } else {
      okButton.focus();
    }
    return new Promise((resolve) => {
      dialog.addEventListener('close', () => {
        if (dialog.returnValue !== 'ok') return resolve(null);
        const values = {};
        for (const [name, input] of Object.entries(inputs)) values[name] = input.type === 'checkbox' ? input.checked : input.value;
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
    if (state.folder !== INBOX && !state.folder.startsWith('tag:') &&
      !body.folders.some((folder) => folder.id === state.folder)) state.folder = INBOX;
    renderFolders();
    renderList();
    const total = body.meetings.reduce((sum, meeting) => sum + (meeting.bytes || 0), 0);
    $('totals').textContent = `${body.meetings.length} meeting${body.meetings.length === 1 ? '' : 's'} · ${fmtBytes(total)}`;
  }

  function inFolder(meeting, folder) {
    if (folder.startsWith('tag:')) return meeting.tags.includes(folder.slice(4));
    if (folder === INBOX) return meeting.parent === '';
    return meeting.parent === folder || meeting.parent.startsWith(folder + '/');
  }

  function folderOptions() {
    return [{ value: '', label: 'Inbox (not in a folder)' }]
      .concat(state.library.folders.slice().sort((a, b) => a.id.localeCompare(b.id)).map((folder) => ({ value: folder.id, label: folder.id })));
  }

  // Folders the user collapsed in the tree, remembered in this browser only.
  const collapsed = new Set((() => {
    try { return JSON.parse(localStorage.getItem('collapsedFolders') || '[]'); } catch (_) { return []; }
  })());
  function saveCollapsed() {
    try { localStorage.setItem('collapsedFolders', JSON.stringify([...collapsed])); } catch (_) { /* private window */ }
  }

  // ── Drag and drop ──
  //
  // Meetings (one, or every selected one when the dragged one is selected) and
  // folders are dragged onto a folder or the inbox in the sidebar.

  const DRAG_TYPE = 'application/x-meetscribe';
  let dragging = null; // { kind: 'meetings', ids } | { kind: 'folder', id }

  function startDrag(event, payload, node) {
    dragging = payload;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(DRAG_TYPE, JSON.stringify(payload));
    event.dataTransfer.setData('text/plain', payload.kind === 'folder' ? payload.id : payload.ids.join('\n'));
    if (payload.kind === 'meetings' && payload.ids.length > 1) {
      const ghost = el('div', { class: 'pill live', text: `${payload.ids.length} meetings`, style: 'position:fixed;top:-100px;left:0;font-size:13px;padding:4px 12px' });
      document.body.append(ghost);
      event.dataTransfer.setDragImage(ghost, 10, 10);
      setTimeout(() => ghost.remove(), 0);
    }
    if (node) setTimeout(() => node.classList.add('dragging'), 0);
  }

  function endDrag() {
    dragging = null;
    document.querySelectorAll('.dragging, .drop').forEach((node) => node.classList.remove('dragging', 'drop'));
  }

  /** Can `payload` go into `target` ('' = inbox / top level)? */
  function canDrop(payload, target) {
    if (!payload) return false;
    if (payload.kind === 'meetings') return payload.ids.some((id) => (byId(id) || {}).parent !== target);
    if (payload.kind === 'folder') {
      if (target === payload.id || target.startsWith(payload.id + '/')) return false;
      const parent = payload.id.includes('/') ? payload.id.slice(0, payload.id.lastIndexOf('/')) : '';
      return parent !== target;
    }
    return false;
  }

  function dropTarget(row, target) {
    row.addEventListener('dragover', (event) => {
      if (!dragging || !canDrop(dragging, target)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      row.classList.add('drop');
    });
    row.addEventListener('dragleave', (event) => {
      if (!row.contains(event.relatedTarget)) row.classList.remove('drop');
    });
    row.addEventListener('drop', async (event) => {
      event.preventDefault();
      row.classList.remove('drop');
      const payload = dragging;
      endDrag();
      if (!payload || !canDrop(payload, target)) return;
      if (payload.kind === 'meetings') await moveMeetings(payload.ids, target);
      else await moveFolder(payload.id, target);
    });
  }

  async function moveMeetings(ids, folder) {
    const result = await attempt(() => post('/api/meeting/move', { ids, folder }), 'Could not move');
    if (!result) return;
    const where = folder ? folder.split('/').pop() : 'the inbox';
    toast(`Moved ${ids.length === 1 ? '“' + nameOf(ids[0]) + '”' : ids.length + ' meetings'} to ${where}`);
    for (const id of ids) state.selected.delete(id);
    const open = state.meeting && ids.includes(state.meeting.id)
      ? result.ids.find((id) => id.split('/').pop() === state.meeting.id.split('/').pop())
      : null;
    await loadLibrary();
    if (open) openMeeting(open, { keepPosition: true });
  }

  async function moveFolder(id, parent) {
    const result = await attempt(() => post('/api/folder/move', { id, parent }), 'Could not move the folder');
    if (!result) return;
    if (state.folder === id || state.folder.startsWith(id + '/')) state.folder = result.id + state.folder.slice(id.length);
    if (parent) collapsed.delete(parent);
    saveCollapsed();
    await loadLibrary();
    if (state.meeting && (state.meeting.parent === id || state.meeting.parent.startsWith(id + '/'))) {
      openMeeting(result.id + state.meeting.id.slice(id.length), { keepPosition: true });
    }
  }

  function renderFolders() {
    const nav = $('folders');
    nav.replaceChildren();
    const { meetings, folders } = state.library;
    const select = (id) => {
      if (state.page && state.page !== 'library') showPage('library');
      if (state.results) {
        $('search').value = '';
        state.query = '';
        state.results = null;
      }
      if (state.folder !== id) {
        state.selected.clear();
        state.anchor = null;
      }
      state.folder = id;
      state.view = 'list';
      renderFolders();
      renderList();
    };
    const row = ({ id, label, iconName, depth = 0, kind = 'folder', folder = null }) => {
      const count = meetings.filter((m) => inFolder(m, id)).length;
      const children = folder ? folders.filter((entry) => entry.parent === folder.id) : [];
      const twisty = el('button', {
        class: 'twisty' + (children.length ? (collapsed.has(id) ? ' closed' : '') : ' none'),
        type: 'button',
        tabindex: children.length ? '0' : '-1',
        'aria-label': collapsed.has(id) ? 'Expand' : 'Collapse',
        onclick: (event) => {
          event.stopPropagation();
          if (collapsed.has(id)) collapsed.delete(id);
          else collapsed.add(id);
          saveCollapsed();
          renderFolders();
        }
      }, icon('chevron-down'));
      const active = state.view === 'list' && !state.results && state.folder === id;
      const node = el('div', {
        class: 'folder-row' + (active ? ' active' : ''),
        style: `padding-left:${4 + depth * 14}px`,
        draggable: folder ? 'true' : null
      }, [
        kind === 'folder' ? twisty : el('span', { class: 'twisty none' }),
        el('button', { class: 'folder ' + kind, type: 'button', onclick: () => select(id), title: folder ? folder.id : label }, [
          icon(iconName), el('span', { class: 'label', text: label }),
          el('span', { class: 'count' + (kind === 'inbox' && count ? ' lit' : ''), text: count || (kind === 'inbox' ? '0' : '') })
        ]),
        folder ? el('span', { class: 'folder-tools' }, [
          iconButton('folder-plus', 'New folder inside', () => newFolder(folder.id)),
          iconButton('pencil', 'Rename folder', () => renameFolder(folder)),
          iconButton('trash', 'Delete folder (only when empty)', () => deleteFolder(folder), 'danger')
        ]) : null
      ]);
      if (kind !== 'tag') dropTarget(node, kind === 'inbox' ? '' : id);
      if (folder) {
        node.addEventListener('dragstart', (event) => startDrag(event, { kind: 'folder', id: folder.id }, node));
        node.addEventListener('dragend', endDrag);
      }
      return node;
    };

    nav.append(row({ id: INBOX, label: 'Inbox', iconName: 'inbox', kind: 'inbox' }));
    const walk = (parent, depth) => {
      const level = folders.filter((folder) => folder.parent === parent).sort((a, b) => a.name.localeCompare(b.name));
      for (const folder of level) {
        nav.append(row({ id: folder.id, label: folder.name, iconName: 'folder', depth, folder }));
        if (!collapsed.has(folder.id)) walk(folder.id, depth + 1);
      }
    };
    walk('', 0);
    if (!folders.length) {
      nav.append(el('button', { class: 'btn ghost small', type: 'button', style: 'margin:6px 8px', onclick: () => newFolder('') }, [icon('folder-plus'), 'Make your first folder']));
    }
    const tags = [...new Set(meetings.flatMap((meeting) => meeting.tags))].sort();
    if (tags.length) {
      nav.append(el('div', { class: 'folder-group', text: 'Tags' }));
      for (const tag of tags) nav.append(row({ id: 'tag:' + tag, label: tag, iconName: 'tag', kind: 'tag' }));
    }
  }

  async function newFolder(parent) {
    const values = await ask({
      title: parent ? `New folder in “${parent.split('/').pop()}”` : 'New folder',
      text: 'For a project, a client or a series of meetings. Drag meetings onto it to file them.',
      fields: [{ name: 'name', label: 'Name', required: true, placeholder: 'e.g. Acme' }],
      ok: 'Create'
    });
    if (!values) return;
    const result = await attempt(() => post('/api/folder/create', { parent, name: values.name }), 'Could not create the folder');
    if (!result) return;
    if (parent) {
      collapsed.delete(parent);
      saveCollapsed();
    }
    toast(`Folder “${result.id.split('/').pop()}” created`);
    await loadLibrary();
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
    const values = await ask({ title: `Delete “${folder.name}”?`, text: 'Only an empty folder can be deleted. Move its meetings out first.', ok: 'Delete', danger: true });
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

  /** Searching looks in every folder; otherwise the inbox, a folder or a tag. */
  function visibleMeetings() {
    let meetings = state.library.meetings;
    if (state.results) meetings = meetings.filter((meeting) => state.results.has(meeting.id));
    else if (state.view !== 'storage') meetings = meetings.filter((meeting) => inFolder(meeting, state.folder));
    return sortMeetings(meetings);
  }

  function renderList() {
    const list = $('meetings');
    list.replaceChildren();
    const meetings = visibleMeetings();
    const storage = state.view === 'storage';

    const folder = state.library.folders.find((entry) => entry.id === state.folder);
    const inbox = !state.results && !storage && state.folder === INBOX;
    $('listTitle').textContent = state.results
      ? `${meetings.length} result${meetings.length === 1 ? '' : 's'} for “${state.query}”`
      : storage ? 'Storage'
        : state.folder.startsWith('tag:') ? state.folder.slice(4)
          : inbox ? 'Inbox'
            : folder ? folder.name : 'Inbox';
    setIcon($('listTitle').parentElement, state.results ? 'search' : storage ? 'drive' : state.folder.startsWith('tag:') ? 'tag' : inbox ? 'inbox' : 'folder');
    $('listHint').textContent = state.results ? 'Searching every folder.'
      : inbox ? (meetings.length ? 'New meetings land here. When you are done with one, drag it onto its folder.' : '')
        : folder ? `${folder.id.includes('/') ? folder.id.replace(/\//g, ' › ') : ''}` : '';
    $('sort').hidden = storage;
    $('storagePanel').hidden = !storage;
    if (storage) {
      const all = state.library.meetings;
      const total = all.reduce((sum, meeting) => sum + meeting.bytes, 0);
      const audio = all.reduce((sum, meeting) => sum + (meeting.audioBytes || 0), 0);
      $('storageTotals').textContent = `${fmtBytes(total)} in ${all.length} meetings, of which ${fmtBytes(audio)} is audio.`;
    }
    $('emptyList').hidden = meetings.length > 0;
    $('emptyList').replaceChildren(
      icon(state.results ? 'search' : inbox ? 'check' : 'folder'),
      state.results ? 'Nothing matches.' : inbox ? 'Inbox zero. Every meeting is filed.' : 'No meetings here yet. Drag some in from the inbox.'
    );

    const terms = queryTerms(state.query);
    for (const meeting of meetings) {
      const pills = [];
      if (meeting.state) pills.push(el('span', { class: 'pill ' + (meeting.state === 'recording' ? 'rec' : 'state'), text: meeting.state }));
      if (meeting.hasFinal) pills.push(el('span', { class: 'pill final' }, [icon('check'), 'final']));
      else if (meeting.hasLive) pills.push(el('span', { class: 'pill live', text: 'live only' }));
      if (meeting.prefix) pills.push(el('span', { class: 'pill', text: meeting.prefix }));
      for (const tag of meeting.tags) pills.push(el('span', { class: 'pill tag', text: '#' + tag }));

      const pick = el('input', {
        type: 'checkbox',
        class: 'pick',
        title: 'Select for bulk actions',
        'aria-label': 'Select ' + (meeting.title || meeting.name),
        onclick: (event) => {
          event.stopPropagation();
          // Shift on the checkbox picks the whole range, like on the row.
          if (event.shiftKey && state.anchor) {
            event.preventDefault();
            pickRange(meeting.id);
          }
        },
        onchange: (event) => {
          if (event.target.checked) state.selected.add(meeting.id);
          else state.selected.delete(meeting.id);
          state.anchor = meeting.id;
          markPicked();
        }
      });
      pick.checked = state.selected.has(meeting.id);

      const body = el('div', { style: 'min-width:0' }, [
        el('div', { class: 'row1' }, [
          el('span', { class: 'name', text: meeting.title || meeting.name, title: meeting.name }),
          el('span', { class: 'when', text: new Date(meeting.startedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) })
        ]),
        el('div', { class: 'row2' }, [
          el('span', { text: new Date(meeting.startedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) }),
          meeting.durationMs ? el('span', { text: fmtDuration(meeting.durationMs) }) : null,
          el('span', { text: storage ? `${fmtBytes(meeting.bytes)} (audio ${fmtBytes(meeting.audioBytes)})` : fmtBytes(meeting.bytes) }),
          (state.results || storage) && meeting.parent ? el('span', { class: 'where' }, [icon('folder'), meeting.parent.split('/').pop()]) : null,
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
      const item = el('li', {
        class: 'meeting' + (state.meeting && state.meeting.id === meeting.id ? ' active' : '') + (state.selected.has(meeting.id) ? ' picked' : ''),
        dataset: { id: meeting.id },
        tabindex: '0',
        draggable: meeting.state ? null : 'true',
        title: meeting.state ? null : 'Drag onto a folder to move it · Ctrl+click to select, Shift+click for a range',
        // Shift+click would select the text in between.
        onmousedown: (event) => { if (event.shiftKey) event.preventDefault(); },
        onclick: (event) => {
          if (event.ctrlKey || event.metaKey) {
            if (state.selected.has(meeting.id)) state.selected.delete(meeting.id);
            else state.selected.add(meeting.id);
            state.anchor = meeting.id;
            markPicked();
          } else if (event.shiftKey) {
            pickRange(meeting.id);
          } else {
            state.anchor = meeting.id;
            openMeeting(meeting.id);
          }
        },
        onkeydown: (event) => { if (event.key === 'Enter') openMeeting(meeting.id); }
      }, [pick, body]);
      item.addEventListener('dragstart', (event) => {
        // Dragging a selected meeting takes the whole selection along.
        const ids = state.selected.has(meeting.id)
          ? [...state.selected].filter((id) => !(byId(id) || {}).state)
          : [meeting.id];
        startDrag(event, { kind: 'meetings', ids }, item);
        if (ids.length > 1) list.querySelectorAll('.meeting').forEach((node) => { if (ids.includes(node.dataset.id)) node.classList.add('dragging'); });
      });
      item.addEventListener('dragend', endDrag);
      list.append(item);
    }
    renderBulk();
  }

  function renderBulk() {
    const count = state.selected.size;
    $('bulkBar').hidden = count === 0;
    $('bulkCount').textContent = `${count} selected`;
    const visible = visibleMeetings();
    const all = visible.length > 0 && visible.every((meeting) => state.selected.has(meeting.id));
    const button = $('selectAllBtn');
    button.disabled = !visible.length;
    button.classList.toggle('on', all);
    button.title = all ? 'Clear the selection (Ctrl+A)' : 'Select every meeting in this list (Ctrl+A)';
    button.setAttribute('aria-label', button.title);
    setIcon(button, all ? 'check-square' : 'square');
  }

  /** Reflect the selection on the rows without rebuilding the list. */
  function markPicked() {
    document.querySelectorAll('#meetings .meeting').forEach((node) => {
      const picked = state.selected.has(node.dataset.id);
      node.classList.toggle('picked', picked);
      const box = node.querySelector('.pick');
      if (box) box.checked = picked;
    });
    renderBulk();
  }

  /** Shift+click: everything between the last clicked meeting and this one, in list order. */
  function pickRange(id) {
    const order = visibleMeetings().map((meeting) => meeting.id);
    const from = order.indexOf(state.anchor);
    const to = order.indexOf(id);
    if (from < 0 || to < 0) {
      state.selected.add(id);
    } else {
      for (let i = Math.min(from, to); i <= Math.max(from, to); i++) state.selected.add(order[i]);
    }
    state.anchor = state.anchor || id;
    markPicked();
  }

  function toggleSelectAll() {
    const visible = visibleMeetings();
    const all = visible.length > 0 && visible.every((meeting) => state.selected.has(meeting.id));
    for (const meeting of visible) {
      if (all) state.selected.delete(meeting.id);
      else state.selected.add(meeting.id);
    }
    markPicked();
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
    // Glossaries: keep each meeting's own, use none, or pick project glossaries.
    const projects = await projectGlossaries();
    let current = [];
    if (withAudio.length === 1) {
      const own = await attempt(() => api('/api/glossary?id=' + encodeURIComponent(withAudio[0])));
      current = own ? own.glossaries : [];
    }
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
        { name: 'diffModel', label: 'Cross-check with a second model', type: 'select', value: 'settings', options: [{ value: 'settings', label: 'As in Settings' }, { value: 'none', label: 'No cross-check' }].concat(models.map((model) => ({ value: model.id, label: model.label }))) },
        {
          name: 'glossaryMode', label: 'Glossary', type: 'select', value: 'keep',
          options: [
            { value: 'keep', label: withAudio.length === 1 ? 'Keep this meeting’s glossary' + (current.length ? ` (${current.join(', ')})` : '') : 'Keep each meeting’s own glossary' },
            { value: 'pick', label: 'Use the project glossaries ticked below' },
            { value: 'none', label: 'No glossary' }
          ]
        },
        { name: 'glossaries', label: 'Project glossaries', type: 'checks', icon: 'book', value: current, options: projects.map((glossary) => ({ value: glossary.name, label: glossary.name })), empty: 'No project glossaries yet (see the Glossaries page).' }
      ],
      ok: 'Re-run'
    });
    if (!values) return null;
    // Ticking a glossary means "use these", even if the menu was left alone.
    const glossaryMode = values.glossaryMode === 'keep' && values.glossaries.join() !== current.join() ? 'pick' : values.glossaryMode;
    const overrides = {};
    if (values.model) overrides.model = values.model;
    if (values.language) overrides.language = values.language;
    if (values.mode) overrides.mode = values.mode;
    if (values.diffModel === 'none') overrides.diffModel = '';
    else if (values.diffModel !== 'settings') overrides.diffModel = values.diffModel;
    const payload = { ids: withAudio, overrides };
    if (glossaryMode === 'none') payload.glossaries = [];
    if (glossaryMode === 'pick') payload.glossaries = values.glossaries;
    const result = await attempt(() => post('/api/rerun', payload), 'Could not start the re-run');
    if (result && payload.glossaries && state.meeting && withAudio.includes(state.meeting.id)) loadGlossary();
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
      rows.push(el('h4', {}, [icon('upload'), `Uploading ${upload.name}… ${Math.round(upload.pct * 100)}%`]),
        el('div', { class: 'bar' }, el('span', { style: `width:${Math.round(upload.pct * 100)}%` })));
    }
    if (queue.running) {
      const pct = Math.round((queue.running.pct || 0) * 100);
      rows.push(el('div', { class: 'job' }, [
        el('span', { class: 'name', text: queue.running.name, title: 'Open', onclick: open(queue.running.id) }),
        el('span', { class: 'opts', text: overridesText(queue.running.overrides) }),
        queue.running.id ? iconButton('x', 'Cancel this pass', () => queueAction('cancel', queue.running.id), 'danger') : null
      ]));
      rows.push(el('div', { class: 'muted', text: queue.message || `Transcribing… ${pct}%` }),
        el('div', { class: 'bar' }, el('span', { style: `width:${pct}%` })));
    } else if (queue.last) {
      rows.push(el('div', { text: queue.last }));
    }
    const jobs = queue.jobs || [];
    if (jobs.length) rows.push(el('h4', { style: 'margin-top:8px' }, [icon('clock'), `Waiting (${jobs.length})`]));
    jobs.forEach((job, index) => {
      rows.push(el('div', { class: 'job' }, [
        el('span', { class: 'name', text: job.name, title: 'Open', onclick: open(job.id) }),
        el('span', { class: 'opts', text: overridesText(job.overrides) }),
        job.id && index > 0 ? iconButton('arrow-up', 'Earlier', () => queueAction('move', job.id, -1)) : null,
        job.id && index < jobs.length - 1 ? iconButton('arrow-down', 'Later', () => queueAction('move', job.id, 1)) : null,
        job.id ? iconButton('x', 'Remove from the queue', () => queueAction('remove', job.id), 'danger') : null
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
    const realFolder = state.view === 'list' && state.folder !== INBOX && !state.folder.startsWith('tag:') ? state.folder : '';
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
    $('meetingMeta').textContent = [fmtDate(meeting.startedAt), fmtDuration(meeting.durationMs)]
      .filter(Boolean).join(' · ');
    const badges = $('meetingBadges');
    badges.replaceChildren();
    if (meeting.state) badges.append(el('span', { class: 'pill ' + (meeting.state === 'recording' ? 'rec' : 'state'), text: meeting.state }));
    badges.append(meeting.source === 'final' ? el('span', { class: 'pill final' }, [icon('check'), 'final transcript'])
      : el('span', { class: 'pill' + (meeting.source === 'live' ? ' live' : ''), text: meeting.source === 'live' ? 'live transcript' : 'no transcript' }));
    badges.append(el('span', { class: 'pill' }, [icon(meeting.parent ? 'folder' : 'inbox'), meeting.parent ? meeting.parent.split('/').pop() : 'Inbox']));
    for (const tag of meeting.tags) badges.append(el('span', { class: 'pill tag', text: '#' + tag }));
    const busy = Boolean(meeting.state);
    for (const button of ['renameBtn', 'moveBtn', 'deleteBtn', 'editMode', 'addMarkerBtn']) $(button).disabled = busy;
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
        iconButton('trash', 'Delete marker', (event) => { event.stopPropagation(); edit({ op: 'marker-delete', ...at }); }, 'danger')
      ]);
    }
    if (entry.kind !== 'speech') return el('span');
    return el('span', { class: 'line-tools' }, [
      iconButton('pencil', 'Edit text', (event) => { event.stopPropagation(); editText(event.currentTarget.closest('.line'), entry, index); }),
      iconButton('merge-down', 'Merge with the next line', (event) => { event.stopPropagation(); edit({ op: 'merge', ...at }); }),
      iconButton('trash', 'Delete line', async (event) => {
        event.stopPropagation();
        const values = await ask({ title: 'Delete this line?', text: entry.text, ok: 'Delete', danger: true });
        if (values) edit({ op: 'delete', ...at });
      }, 'danger')
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
      button('check', 'Save', (event) => { event.stopPropagation(); save(); }, 'primary small'),
      button('x', 'Cancel', (event) => { event.stopPropagation(); cancel(); }, 'ghost small'),
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
          el('div', {}, [el('span', { class: 'marker' }, [icon('monitor'), 'Screenshot ' + entry.text]), el('img', { src: mediaUrl(meeting.id, entry.text), alt: 'Screenshot ' + entry.text, loading: 'lazy' })]),
          editing ? el('span') : null
        ]));
        return;
      }
      if (entry.kind === 'marker') {
        box.append(el('div', { class: 'event', dataset: { index }, onclick: () => seekTo(entry.startedAt) }, [
          time, el('div', { class: 'marker' }, [icon('flag'), 'Marker' + (entry.text ? ': ' + entry.text : '')]),
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

  /** The project glossaries (the Glossaries page), cached until something changes on disk. */
  async function projectGlossaries(fresh = false) {
    if (!state.glossaries || fresh) {
      const body = await attempt(() => api('/api/glossaries'), 'Could not load the glossaries');
      state.glossaries = body ? body.glossaries : [];
    }
    return state.glossaries;
  }

  async function loadGlossary() {
    const id = state.meeting.id;
    const [glossary, corrections, projects] = await Promise.all([
      attempt(() => api('/api/glossary?id=' + encodeURIComponent(id))),
      attempt(() => api('/api/corrections?id=' + encodeURIComponent(id))),
      projectGlossaries()
    ]);
    if (!state.meeting || state.meeting.id !== id) return;
    $('glossaryText').value = glossary ? glossary.text : '';
    $('glossarySaved').textContent = '';
    $('glossaryApplied').textContent = '';
    const used = new Set((glossary ? glossary.glossaries : []).map((name) => name.toLowerCase()));
    const picks = $('meetingGlossaryPicks');
    picks.replaceChildren(...projects.map((project) => {
      const box = el('input', { type: 'checkbox', value: project.name });
      box.checked = used.has(project.name.toLowerCase());
      return el('label', { class: 'chip', title: `${project.terms} term${project.terms === 1 ? '' : 's'}` }, [box, icon('book'), project.name]);
    }));
    if (!projects.length) {
      picks.append(el('span', { class: 'muted small' }, ['No project glossaries yet. ', el('button', { class: 'btn ghost small', type: 'button', onclick: () => showPage('glossaries') }, [icon('plus'), 'Make one'])]));
    }
    $('glossaryApply').disabled = !projects.length;
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
        iconButton('trash', 'Remove', () => { state.corrections.splice(index, 1); renderCorrections(); }, 'danger'));
    });
  }

  /** Rebuild this meeting's glossary from the ticked project glossaries ([] = none). */
  async function applyMeetingGlossaries(names) {
    const id = state.meeting.id;
    const result = await attempt(() => post('/api/meeting/glossaries', { id, names }), 'Could not change the glossary');
    if (!result || !state.meeting || state.meeting.id !== id) return;
    await loadGlossary();
    $('glossaryApplied').textContent = names.length
      ? `Using ${result.glossaries.join(', ')}. Re-run the final pass to transcribe with it.`
      : 'No glossary for this meeting. Re-run the final pass to transcribe without one.';
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
      setIcon($('playBtn'), 'pause');
      $('playBtn').setAttribute('aria-label', 'Pause');
      syncTracks(true);
      schedule();
    }

    function pause() {
      player.playing = false;
      setIcon($('playBtn'), 'play');
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

  // ── Pages: glossaries, profiles, models, settings ──

  const PAGES = ['glossaries', 'profiles', 'models', 'settings'];

  function showPage(page) {
    closeMenu();
    state.page = page;
    document.querySelectorAll('.page-link').forEach((link) => link.classList.toggle('active', link.dataset.page === page));
    const paged = page !== 'library';
    document.querySelector('.app').classList.toggle('paged', paged);
    $('pagePane').hidden = !paged;
    for (const name of PAGES) $('page-' + name).hidden = name !== page;
    if (paged && state.player) state.player.pause();
    if (page === 'glossaries') loadGlossaries();
    if (page === 'profiles') loadProfiles();
    if (page === 'models') loadModels();
    if (page === 'settings') loadSettings();
  }

  const languageName = (code) => (LANGUAGES.find(([value]) => value === code) || [code, code])[1];

  async function modelCatalog() {
    const body = await attempt(() => api('/api/models'), 'Could not list the models');
    state.models = body ? body.models : [];
    return state.models;
  }

  const modelLabel = (id) => {
    if (!id) return 'none';
    const model = (state.models || []).find((entry) => entry.id === id || entry.repo === id);
    return model ? model.label : id;
  };

  function modelOptions(role, { optional = false, current = '' } = {}) {
    const list = (state.models || []).filter((model) => (model.roles || []).includes(role) || model.custom);
    const options = list.map((model) => ({ value: model.id, label: (model.downloaded ? '✓ ' : '') + model.label + (model.downloaded ? '' : ' (not downloaded)') }));
    if (current && !options.some((option) => option.value === current)) options.unshift({ value: current, label: current });
    return optional ? [{ value: '', label: 'None' }].concat(options) : options;
  }

  // ── Glossaries page ──

  async function loadGlossaries(select) {
    const list = await projectGlossaries(true);
    if (select !== undefined) state.glossaryOpen = select;
    if (state.glossaryOpen && !list.some((glossary) => glossary.name === state.glossaryOpen)) state.glossaryOpen = null;
    if (state.glossaryOpen === undefined || (state.glossaryOpen === null && select === undefined)) state.glossaryOpen = list.length ? list[0].name : null;
    renderGlossaries();
  }

  function renderGlossaries() {
    const list = state.glossaries || [];
    const open = list.find((glossary) => glossary.name === state.glossaryOpen) || null;
    const creating = state.glossaryOpen === '';
    $('glossaryEmpty').hidden = list.length > 0 || creating;
    $('glossaryList').hidden = !list.length && !creating;
    $('glossaryEditor').hidden = !open && !creating;
    $('glossaryList').replaceChildren(...list.map((glossary) => el('button', {
      class: 'glossary-item' + (glossary.name === state.glossaryOpen ? ' active' : ''),
      type: 'button',
      onclick: () => {
        state.glossaryOpen = glossary.name;
        renderGlossaries();
      }
    }, [icon('book'), el('span', { class: 'label', text: glossary.name }), el('span', { class: 'count', text: `${glossary.terms} term${glossary.terms === 1 ? '' : 's'}` })])));
    $('glossaryName').value = open ? open.name : '';
    $('glossaryBody').value = open ? open.text : '';
    $('glossaryDeleteBtn').hidden = !open;
    $('glossaryStatus').textContent = creating ? 'A new glossary: give it a name and its terms.' : '';
    if (creating) $('glossaryName').focus();
  }

  async function saveProjectGlossary() {
    const previous = state.glossaryOpen || null;
    const name = $('glossaryName').value.trim();
    if (!name) {
      $('glossaryName').focus();
      return toast('Give the glossary a name');
    }
    const result = await attempt(() => post('/api/glossaries/save', { name, previous, text: $('glossaryBody').value }), 'Could not save the glossary');
    if (!result) return;
    await loadGlossaries(result.name);
    $('glossaryStatus').textContent = 'Saved.';
  }

  async function deleteProjectGlossary() {
    const name = state.glossaryOpen;
    if (!name) return;
    const values = await ask({ title: `Delete the glossary “${name}”?`, text: 'Meetings that already use it keep their own copy. The file goes to the Recycle Bin.', ok: 'Delete', danger: true });
    if (!values) return;
    const result = await attempt(() => post('/api/glossaries/delete', { name }), 'Could not delete the glossary');
    if (result) await loadGlossaries(null);
  }

  // ── Profiles page ──

  async function loadProfiles() {
    const [body] = await Promise.all([attempt(() => api('/api/profiles'), 'Could not load the profiles'), modelCatalog(), projectGlossaries(true)]);
    if (!body) return;
    state.profiles = body;
    const cards = $('profileCards');
    cards.replaceChildren();
    for (const profile of body.profiles) {
      const values = profile.values || {};
      const active = profile.id === body.active;
      const none = profile.kind === 'none';
      const glossaryTerms = String(values.glossary || '').split(/[\n,]/).filter((line) => line.trim() && !line.trim().startsWith('#')).length;
      const sets = values.glossarySet || [];
      const glossaryText = [sets.length ? sets.join(', ') : '', glossaryTerms ? `${glossaryTerms} other term${glossaryTerms === 1 ? '' : 's'}` : '']
        .filter(Boolean).join(' + ') || (values.glossary === undefined && !none ? 'keeps yours' : 'none');
      const buttons = [];
      if (!active) buttons.push(button('check', 'Use', () => selectProfile(profile), 'primary small'));
      if (!none) buttons.push(iconButton('pencil', 'Edit', () => editProfile(profile, active)));
      buttons.push(iconButton('duplicate', 'Duplicate as a new profile', () => newProfile(profile)));
      if (profile.kind === 'builtin' && profile.edited) buttons.push(iconButton('refresh', 'Reset to the built-in values', () => resetProfile(profile)));
      if (profile.kind === 'mine') buttons.push(el('span', { class: 'spacer' }), iconButton('trash', 'Delete this profile', () => deleteProfile(profile), 'danger'));
      cards.append(el('div', { class: 'card' + (active ? ' active' : '') + (none ? ' none' : '') }, [
        el('div', { class: 'title' }, [
          flagNode(profile.flag),
          el('span', { class: 'name', text: profile.label }),
          active ? el('span', { class: 'pill final' }, [icon('check'), 'active']) : null,
          profile.kind === 'mine' ? el('span', { class: 'pill', text: 'yours' }) : null,
          profile.kind === 'builtin' && profile.edited ? el('span', { class: 'pill', text: 'edited' }) : null
        ]),
        el('div', { class: 'muted small', text: profile.summary }),
        el('dl', {}, [
          el('dt', { text: 'Live' }), el('dd', { text: values.liveTranscription === false ? 'off' : modelLabel(values.whisperModel) }),
          el('dt', { text: 'Final pass' }), el('dd', { text: values.offlinePassEnabled === false ? 'off' : modelLabel(values.offlineModel) }),
          el('dt', { text: 'Language' }), el('dd', { text: languageName(values.whisperLanguage || 'auto') }),
          el('dt', { text: 'Folder name' }), el('dd', { text: values.folderNamePrefix || '(date only)' }),
          el('dt', { text: 'Glossary' }), el('dd', { text: glossaryText, title: glossaryText })
        ]),
        el('div', { class: 'buttons' }, buttons)
      ]));
    }
  }

  async function selectProfile(profile) {
    if (profile.kind === 'none') {
      const values = await ask({
        title: 'Switch to “No profile”?',
        text: 'Models, language and recording options go back to the multilingual defaults, and project glossaries are unticked. Your glossary text stays. Changes you make afterwards are not saved into any profile; use “Save current settings as a profile” for that.',
        ok: 'Switch'
      });
      if (!values) return;
    }
    const result = await attempt(() => post('/api/profiles/select', { id: profile.id }), 'Could not switch the profile');
    if (result) {
      toast(`${profile.label} is active`);
      loadProfiles();
    }
  }

  async function resetProfile(profile) {
    const values = await ask({ title: `Reset “${profile.label}”?`, text: 'Its models, language, folder name and glossary go back to the built-in values.', ok: 'Reset', danger: true });
    if (!values) return;
    const result = await attempt(() => post('/api/profiles/reset', { id: profile.id }), 'Could not reset the profile');
    if (result) loadProfiles();
  }

  async function deleteProfile(profile) {
    const values = await ask({ title: `Delete “${profile.label}”?`, text: 'Your current settings stay as they are.', ok: 'Delete', danger: true });
    if (!values) return;
    const result = await attempt(() => post('/api/profiles/delete', { id: profile.id }), 'Could not delete the profile');
    if (result) loadProfiles();
  }

  /** A new profile: from the current settings, or a copy of `source`. */
  async function newProfile(source = null) {
    const values = await ask({
      title: source ? `Duplicate “${source.label}”` : 'Save current settings as a profile',
      text: source ? 'A profile of your own with the same values, to change as you like.' : 'Takes your current models, language, glossaries and recording options.',
      fields: [
        { name: 'label', label: 'Name', required: true, value: source ? `${source.label} (copy)` : '', placeholder: 'e.g. Acme weekly' },
        { name: 'flag', label: 'Flag', type: 'flags', value: source && source.flag !== 'none' ? source.flag : 'custom' },
        { name: 'activate', label: 'Make it the active profile', type: 'checkbox', value: !source }
      ],
      ok: 'Create'
    });
    if (!values) return;
    const result = await attempt(() => post('/api/profiles/create', { label: values.label, flag: values.flag, from: source ? source.id : null, activate: values.activate }), 'Could not create the profile');
    if (result) {
      toast(`Profile “${values.label.trim()}” created`);
      loadProfiles();
    }
  }

  async function editProfile(profile, active) {
    const values = profile.values;
    const languages = LANGUAGES.map(([value, label]) => ({ value, label }));
    const projects = state.glossaries || [];
    const mine = profile.kind === 'mine';
    const answer = await ask({
      title: `Edit “${profile.label}”`,
      text: active ? 'This is the active profile: saving also changes your current settings.' : '',
      fields: [
        mine ? { name: 'label', label: 'Name', value: profile.label, required: true } : null,
        mine ? { name: 'flag', label: 'Flag', type: 'flags', value: profile.flag } : null,
        { name: 'liveTranscription', label: 'Transcribe live while recording', type: 'checkbox', value: values.liveTranscription !== false },
        { name: 'whisperModel', label: 'Live model', type: 'select', value: values.whisperModel, options: modelOptions('live', { current: values.whisperModel }) },
        { name: 'whisperLanguage', label: 'Language', type: 'select', value: values.whisperLanguage || 'auto', options: languages },
        { name: 'offlinePassEnabled', label: 'Run the final pass after every meeting', type: 'checkbox', value: values.offlinePassEnabled !== false },
        { name: 'offlineModel', label: 'Final-pass model', type: 'select', value: values.offlineModel, options: modelOptions('final', { current: values.offlineModel }) },
        { name: 'archiveAudio', label: 'Keep the audio of each meeting', type: 'checkbox', value: values.archiveAudio !== false },
        { name: 'showTranscriptOnRecord', label: 'Show the transcript panel when recording starts', type: 'checkbox', value: values.showTranscriptOnRecord !== false },
        { name: 'folderNamePrefix', label: 'Meeting folder name', value: values.folderNamePrefix || '' },
        { name: 'glossarySet', label: 'Project glossaries for new meetings', type: 'checks', icon: 'book', value: values.glossarySet || [], options: projects.map((glossary) => ({ value: glossary.name, label: glossary.name })), empty: 'No project glossaries yet (see the Glossaries page).' },
        { name: 'glossary', label: 'Other glossary terms (leave empty to keep whatever is in use)', type: 'textarea', rows: 4, value: values.glossary || '' }
      ].filter(Boolean),
      ok: 'Save'
    });
    if (!answer) return;
    const update = { ...answer };
    const meta = {};
    if (mine) {
      meta.label = update.label;
      meta.flag = update.flag;
    }
    delete update.label;
    delete update.flag;
    // An untouched empty glossary means "keep the current one", not "clear it".
    if (!update.glossary.trim() && values.glossary === undefined) delete update.glossary;
    const result = await attempt(() => post('/api/profiles/update', { id: profile.id, values: update, ...meta }), 'Could not save the profile');
    if (result) {
      toast(`${meta.label || profile.label} saved`);
      loadProfiles();
    }
  }

  // ── Models page ──

  async function loadModels() {
    const models = await modelCatalog();
    const settings = await attempt(() => api('/api/settings'));
    state.settingValues = settings ? settings.values : state.settingValues || {};
    renderModels(models);
  }

  function renderModels(models) {
    const box = $('modelList');
    box.replaceChildren();
    const groups = [
      ['live', 'mic', 'For the live transcript', 'Small and fast, so the transcript keeps up while you talk.'],
      ['final', 'sparkles', 'For the final pass', 'Big and accurate; runs over the recording after the meeting.']
    ];
    for (const [category, iconName, title, hint] of groups) {
      const list = models.filter((model) => (model.category === 'live' ? 'live' : 'final') === category)
        // On this computer first, then the rest in catalog order.
        .sort((a, b) => Number(b.downloaded || b.downloading) - Number(a.downloaded || a.downloading));
      const have = list.filter((model) => model.downloaded).length;
      box.append(el('div', { class: 'model-group-head' }, [el('h2', {}, [icon(iconName), title, el('span', { class: 'count', text: `${have} of ${list.length} on this computer` })])]),
        el('p', { class: 'muted small', text: hint, style: 'margin:-6px 0 10px' }));
      for (const model of list) box.append(modelRow(model));
    }
  }

  function modelRow(model) {
    const roles = model.roles || [];
    const uses = { live: 'live', final: 'final pass', diff: 'cross-check' };
    const inUse = (model.inUse || []).map((role) => uses[role]).filter(Boolean);
    const minutes = model.estimate && model.estimate.minutes ? Math.max(1, Math.round(model.estimate.minutes)) : null;
    const progress = model.downloading ? Math.round((model.progress || 0) * 100) : null;
    const side = [];
    if (inUse.length) side.push(el('span', { class: 'pill final' }, [icon('check'), 'in use: ' + inUse.join(', ')]));
    if (model.downloading) {
      side.push(el('span', { class: 'muted small', text: `Downloading… ${progress}%` }));
    } else if (!model.downloaded) {
      side.push(button('download', `Download${model.sizeMb ? ' · ' + fmtBytes(model.sizeMb * 1e6) : ''}`, () => modelAction('download', model), 'small'));
      // Added from Hugging Face but never (fully) downloaded: let it go again.
      if (model.custom) side.push(iconButton('x', 'Remove from the list', () => modelAction('delete', model), 'danger'));
    } else {
      if (roles.includes('live') && !(model.inUse || []).includes('live')) side.push(button('mic', 'Use live', () => useModel(model, 'live'), 'small'));
      if (roles.includes('final') && !(model.inUse || []).includes('final')) side.push(button('sparkles', 'Use for final', () => useModel(model, 'final'), 'small'));
      side.push(iconButton('trash', 'Delete from this computer', () => modelAction('delete', model), 'danger'));
    }
    return el('div', { class: 'model' + (model.downloaded ? ' have' : ''), dataset: { id: model.id } }, [
      el('div', {}, [
        el('div', { class: 'name' }, [model.label, model.custom ? el('span', { class: 'pill', text: 'from Hugging Face' }) : null]),
        el('div', { class: 'note', text: [model.note, model.downloaded ? fmtBytes(model.bytes) + ' on disk' : '', minutes && roles.includes('final') ? `≈ ${minutes} min per hour of meeting` : ''].filter(Boolean).join(' · ') })
      ]),
      el('div', { class: 'side' }, side),
      model.downloading ? el('div', { class: 'bar' }, el('span', { style: `width:${progress}%` })) : null
    ]);
  }

  async function modelAction(action, model, options = {}) {
    if (action === 'delete') {
      const values = await ask(model.downloaded
        ? { title: `Delete ${model.label}?`, text: `Frees ${fmtBytes(model.bytes)}. You can download it again later.`, ok: 'Delete', danger: true }
        : { title: `Remove ${model.label} from the list?`, text: model.bytes ? `Deletes the ${fmtBytes(model.bytes)} downloaded so far.` : 'You can add it again from the search.', ok: 'Remove', danger: true });
      if (!values) return;
    }
    const result = await attempt(() => post('/api/models/' + action, { id: model.id, ...options }), action === 'delete' ? 'Could not delete the model' : 'Could not start the download');
    if (result) loadModels();
    return result;
  }

  async function useModel(model, role) {
    const result = await attempt(() => post('/api/models/use', { id: model.id, role }), 'Could not change the model');
    if (result) {
      toast(`${model.label} is now the ${role === 'live' ? 'live' : 'final-pass'} model`);
      loadModels();
    }
  }

  async function searchHub(event) {
    if (event) event.preventDefault();
    const query = $('hubQuery').value.trim();
    const box = $('hubResults');
    box.replaceChildren(el('div', { class: 'muted small', text: 'Searching Hugging Face…' }));
    const body = await attempt(() => api('/api/hub?q=' + encodeURIComponent(query)), 'Search failed');
    if (!body) {
      box.replaceChildren();
      return;
    }
    if (!state.models) await modelCatalog();
    const known = new Set((state.models || []).map((model) => model.repo));
    if (!body.results.length) {
      box.replaceChildren(el('div', { class: 'muted small', text: 'No Whisper models that MeetScribe can use matched. Try fewer words.' }));
      return;
    }
    box.replaceChildren(...body.results.map((row) => {
      const have = known.has(row.repo);
      const facts = [
        el('span', {}, [icon('download'), ' ' + row.downloads.toLocaleString()]),
        row.likes ? el('span', {}, [icon('heart'), ' ' + row.likes]) : null,
        row.updated ? el('span', { text: 'updated ' + new Date(row.updated).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }) }) : null,
        row.languages.length ? el('span', {}, [icon('globe'), ' ' + row.languages.join(', ')]) : null,
        row.sizeMb ? el('span', { text: '≈ ' + fmtBytes(row.sizeMb * 1e6) }) : null
      ];
      const add = (category) => async () => {
        const convert = row.format === 'transformers';
        if (convert) {
          const ok = await ask({
            title: `Convert ${row.repo}?`,
            text: 'This model is published as Transformers weights. MeetScribe downloads them (about twice the final size), converts them to CTranslate2 and deletes the originals. That takes a while; the progress shows on this page.',
            ok: 'Download and convert'
          });
          if (!ok) return;
        }
        const result = await modelAction('download', { id: row.repo, label: row.repo }, { convert, category });
        if (result) toast(`Downloading ${row.repo}; it shows under “${category === 'live' ? 'For the live transcript' : 'For the final pass'}”`);
      };
      return el('div', { class: 'hub-row' }, [
        el('div', {}, [
          el('div', { class: 'repo' }, [
            el('span', { text: row.repo }),
            el('span', { class: 'pill ' + (row.format === 'ct2' ? 'final' : 'state'), text: row.format === 'ct2' ? 'ready' : 'needs conversion' })
          ]),
          el('div', { class: 'facts' }, facts)
        ]),
        el('div', { class: 'side' }, have ? [el('span', { class: 'pill final' }, [icon('check'), 'in your list'])] : [
          button('mic', 'Add for live', add('live'), row.category === 'live' ? 'primary small' : 'small'),
          button('sparkles', 'Add for final', add('final'), row.category === 'final' ? 'primary small' : 'small')
        ])
      ]);
    }));
  }

  // ── Settings page ──

  async function loadSettings() {
    const [body] = await Promise.all([attempt(() => api('/api/settings'), 'Could not load the settings'), modelCatalog(), projectGlossaries(true)]);
    if (!body) return;
    state.settingValues = body.values;
    state.settingSchema = body.schema;
    const form = $('settingsForm');
    form.replaceChildren();
    $('settingsSaved').textContent = '';
    for (const section of body.schema) {
      const fieldset = el('fieldset', {}, el('legend', { text: section.title }));
      for (const field of section.fields) {
        const value = body.values[field.key];
        let input;
        if (field.type === 'bool') {
          input = el('input', { type: 'checkbox', name: field.key });
          input.checked = Boolean(value);
        } else if (field.type === 'glossaries') {
          const chosen = new Set((value || []).map((name) => name.toLowerCase()));
          const names = (state.glossaries || []).map((glossary) => glossary.name);
          input = el('div', { class: 'pick-chips', dataset: { key: field.key } }, names.length ? names.map((name) => {
            const box = el('input', { type: 'checkbox', value: name });
            box.checked = chosen.has(name.toLowerCase());
            return el('label', { class: 'chip' }, [box, icon('book'), name]);
          }) : el('span', { class: 'muted small', text: 'No project glossaries yet.' }));
        } else if (field.type === 'select' || field.type === 'model') {
          const options = field.type === 'model' ? modelOptions(field.role, { optional: field.optional, current: value }) : field.options;
          input = el('select', { name: field.key }, options.map((option) => el('option', { value: option.value, text: option.label })));
          input.value = value === undefined || value === null ? '' : value;
        } else if (field.type === 'number') {
          input = el('input', { type: 'number', name: field.key, min: field.min, max: field.max, step: field.step });
          input.value = value === undefined ? '' : value;
        } else if (field.type === 'textarea') {
          input = el('textarea', { name: field.key, rows: 6, spellcheck: 'false' });
          input.value = value || '';
        } else {
          input = el('input', { type: 'text', name: field.key, maxlength: field.max });
          input.value = value || '';
        }
        const row = el('div', { class: 'field' + (field.type === 'textarea' ? ' wide' : '') }, [
          el('label', { for: 'setting-' + field.key, text: field.label }), input,
          field.help ? el('div', { class: 'help', text: field.help }) : null
        ]);
        input.id = 'setting-' + field.key;
        const mark = () => row.classList.toggle('changed', String(readField(field, input)) !== String(value === undefined || value === null ? '' : value));
        input.addEventListener('input', mark);
        input.addEventListener('change', mark);
        fieldset.append(row);
      }
      form.append(fieldset);
    }
  }

  function readField(field, input) {
    if (field.type === 'bool') return input.checked;
    if (field.type === 'number') return input.value === '' ? '' : Number(input.value);
    if (field.type === 'glossaries') return [...input.querySelectorAll('input:checked')].map((box) => box.value);
    return input.value;
  }

  async function saveSettings() {
    const form = $('settingsForm');
    const patch = {};
    for (const section of state.settingSchema || []) {
      for (const field of section.fields) {
        const input = field.type === 'glossaries' ? form.querySelector(`[data-key="${field.key}"]`) : form.elements[field.key];
        if (!input) continue;
        const value = readField(field, input);
        const before = state.settingValues[field.key];
        if (String(value) !== String(before === undefined || before === null ? '' : before)) patch[field.key] = value;
      }
    }
    if (!Object.keys(patch).length) {
      $('settingsSaved').textContent = 'Nothing changed.';
      return;
    }
    const result = await attempt(() => post('/api/settings', { patch }), 'Not saved');
    if (!result) return;
    await loadSettings();
    $('settingsSaved').textContent = `Saved ${Object.keys(patch).length} change${Object.keys(patch).length === 1 ? '' : 's'}.`;
  }

  // ── Live updates ──

  // ── Status: is the local server answering, and what is the app doing? ──

  state.server = { up: false, mode: 'app', recording: false };

  function renderStatus() {
    const { up, mode, recording } = state.server;
    const dot = $('statusDot');
    dot.className = 'dot ' + (!up ? 'down' : recording ? 'rec' : 'up');
    $('statusText').textContent = !up ? 'Server not reachable'
      : recording ? 'Recording now'
        : mode === 'library' ? 'Running · app closed'
          : 'Running · app open';
    $('status').title = !up
      ? 'MeetScribe Library is not answering. It stops when MeetScribe quits; start MeetScribe or the Library shortcut again.'
      : `MeetScribe Library answers at ${location.host}.`;
    // One small button: close the overlay (keep the library), or bring it back.
    const toggle = $('appToggle');
    toggle.hidden = !up;
    const library = mode === 'library';
    setIcon(toggle, library ? 'monitor' : 'power');
    toggle.classList.toggle('open', library);
    toggle.title = library ? 'Open MeetScribe again' : 'Close MeetScribe and keep only the Library';
    toggle.setAttribute('aria-label', toggle.title);
  }

  async function toggleApp() {
    if (state.server.mode === 'library') return openApp();
    const values = await ask({
      title: 'Close MeetScribe and keep the Library?',
      text: 'The MeetScribe overlay closes; this page keeps working. The Library quits by itself a few minutes after you close its last tab. Start MeetScribe again to bring the overlay back.',
      ok: 'Close MeetScribe'
    });
    if (!values) return undefined;
    const result = await attempt(() => post('/api/app/library-only', {}), 'Could not close MeetScribe');
    if (result) {
      toast('MeetScribe is closed; the Library keeps running');
      loadStatus();
    }
    return undefined;
  }

  async function loadStatus() {
    try {
      const response = await fetch('/api/status', { credentials: 'same-origin' });
      if (response.status === 403) return expired();
      const body = await response.json();
      state.server = { up: true, mode: body.mode || 'app', recording: Boolean(body.recording) };
    } catch (error) {
      if (error.message === 'expired') return undefined;
      state.server.up = false;
    }
    renderStatus();
    return undefined;
  }

  async function openApp() {
    const result = await attempt(() => post('/api/app/open', {}), 'Could not open MeetScribe');
    if (result) {
      toast('MeetScribe is back');
      loadStatus();
    }
  }

  function connectEvents() {
    const source = new EventSource('/api/events');
    source.onopen = () => loadStatus();
    source.onerror = () => {
      state.server.up = false;
      renderStatus();
    };
    source.addEventListener('status', () => loadStatus());
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
    source.addEventListener('library', (event) => {
      let reason = '';
      try { reason = JSON.parse(event.data).reason || ''; } catch (_) { /* no detail */ }
      if (/^meeting-(started|stopped)$/.test(reason)) loadStatus();
      // Glossary files live in the transcript folder too.
      if (/^glossaries\//.test(reason)) {
        state.glossaries = null;
        if (state.page === 'glossaries' && document.activeElement !== $('glossaryBody') && document.activeElement !== $('glossaryName')) loadGlossaries();
      }
      refreshSoon();
    });
    // Changed in the app or another tab: show the new values (a settings form
    // with unsaved edits is left alone).
    source.addEventListener('settings', () => {
      if (state.page === 'profiles') loadProfiles();
      if (state.page === 'models') loadModels();
      if (state.page === 'settings' && !document.querySelector('.settings-form .changed')) loadSettings();
    });
    source.addEventListener('model-progress', (event) => {
      const data = JSON.parse(event.data);
      if (state.page !== 'models') return;
      if (data.state === 'downloading') {
        const model = (state.models || []).find((entry) => entry.id === data.id);
        const row = document.querySelector(`.model[data-id="${CSS.escape(data.id)}"]`);
        if (model && row) {
          model.downloading = true;
          model.progress = data.progress;
          row.replaceWith(modelRow(model));
        }
      } else {
        if (data.state === 'failed') toast('Download failed: ' + data.error);
        if (data.state === 'done') toast('Model downloaded');
        loadModels();
      }
    });
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
    $('exportBtn').addEventListener('click', (event) => openMenu(event.currentTarget, [
      { icon: 'notes', label: 'Markdown', hint: '.md, with headings and markup', onclick: () => exportMeeting('md') },
      { icon: 'text', label: 'Plain text', hint: '.txt', onclick: () => exportMeeting('txt') },
      { icon: 'clock', label: 'Subtitles', hint: '.srt, with timings', onclick: () => exportMeeting('srt') },
      { icon: 'sparkles', label: 'Text for an LLM', hint: '.txt with a short header', onclick: () => exportMeeting('llm') }
    ]));
    $('deleteBtn').addEventListener('click', (event) => openMenu(event.currentTarget, [
      { icon: 'volume-x', label: 'Delete the audio only', hint: 'The transcript stays; no more re-runs or playback', danger: true, onclick: () => bulk('audio', [state.meeting.id]) },
      { icon: 'trash', label: 'Delete the whole meeting', hint: 'Transcript, audio, notes: to the Recycle Bin', danger: true, onclick: () => bulk('trash', [state.meeting.id]) }
    ]));
    $('dialogCancel').addEventListener('click', () => $('dialog').close('cancel'));
    $('newFolderBtn').addEventListener('click', () => newFolder(''));
    $('appToggle').addEventListener('click', toggleApp);
    $('selectAllBtn').addEventListener('click', toggleSelectAll);
    $('glossaryApply').addEventListener('click', () => {
      const names = [...$('meetingGlossaryPicks').querySelectorAll('input:checked')].map((box) => box.value);
      if (!names.length) return toast('Tick at least one glossary, or pick “No glossary”');
      return applyMeetingGlossaries(names);
    });
    $('glossaryNone').addEventListener('click', async () => {
      const values = await ask({ title: 'No glossary for this meeting?', text: 'Its glossary is emptied. The next final pass runs without one, and does not fall back to the glossary in Settings.', ok: 'No glossary' });
      if (values) applyMeetingGlossaries([]);
    });
    $('newGlossaryBtn').addEventListener('click', () => {
      state.glossaryOpen = '';
      renderGlossaries();
    });
    $('glossarySaveBtn').addEventListener('click', saveProjectGlossary);
    $('glossaryDeleteBtn').addEventListener('click', deleteProjectGlossary);
    $('newProfileBtn').addEventListener('click', () => newProfile(null));
    $('hubForm').addEventListener('submit', searchHub);
    bindFileDrop();
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
    document.querySelectorAll('.page-link').forEach((link) => link.addEventListener('click', () => showPage(link.dataset.page)));
    $('settingsSave').addEventListener('click', saveSettings);
    $('settingsForm').addEventListener('submit', (event) => {
      event.preventDefault();
      saveSettings();
    });
    $('search').addEventListener('focus', () => {
      if (state.page && state.page !== 'library') showPage('library');
    });
    $('storageBtn').addEventListener('click', () => {
      if (state.page && state.page !== 'library') showPage('library');
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
      if (event.key === 'Escape' && !$('menu').hidden) {
        closeMenu();
        return;
      }
      if (event.key === 'Escape' && !typing && !$('dialog').open && state.selected.size) {
        state.selected.clear();
        markPicked();
        return;
      }
      // Ctrl+A in the library list: select (or clear) every meeting shown.
      if ((event.ctrlKey || event.metaKey) && (event.key === 'a' || event.key === 'A') && !typing && !$('dialog').open &&
        (!state.page || state.page === 'library')) {
        event.preventDefault();
        toggleSelectAll();
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

  /** Drop an audio file anywhere on the page to import it. */
  function bindFileDrop() {
    let depth = 0;
    const hasFiles = (event) => [...(event.dataTransfer ? event.dataTransfer.types : [])].includes('Files');
    window.addEventListener('dragenter', (event) => {
      if (!hasFiles(event) || dragging) return;
      depth++;
      $('dropZone').hidden = false;
    });
    window.addEventListener('dragleave', (event) => {
      if (!hasFiles(event) || dragging) return;
      depth = Math.max(0, depth - 1);
      if (!depth) $('dropZone').hidden = true;
    });
    window.addEventListener('dragover', (event) => {
      if (hasFiles(event) && !dragging) event.preventDefault();
    });
    window.addEventListener('drop', (event) => {
      if (!hasFiles(event) || dragging) return;
      event.preventDefault();
      depth = 0;
      $('dropZone').hidden = true;
      const file = event.dataTransfer.files[0];
      if (file) importRecording(file);
    });
  }

  async function start() {
    hydrateIcons();
    renderStatus();
    bind();
    await loadLibrary();
    connectEvents();
    loadStatus();
    loadQueue();
    const id = decodeURIComponent(location.hash.slice(1));
    if (id && byId(id)) openMeeting(id);
  }

  start();
})();
