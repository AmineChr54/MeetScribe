/* MeetScribe Library: the browser manager page. Served by
 * src/services/manager-server.service.js; talks to it over same-origin fetch
 * and Server-Sent Events. Plain script, no framework, no build step. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const state = {
    library: { folders: [], meetings: [] },
    folder: '',            // '' = all meetings
    query: '',
    results: null,         // Map id -> { hits, snippets } while searching
    meeting: null,         // the open meeting (full detail)
    player: null
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

  async function api(path) {
    const response = await fetch(path, { credentials: 'same-origin' });
    if (response.status === 403) {
      document.body.innerHTML = '';
      document.body.append(el('p', { class: 'placeholder', text: 'This session has expired. Open the manager again from MeetScribe (Settings → Open Manager).' }));
      throw new Error('expired');
    }
    const body = await response.json();
    if (!body.ok) throw new Error(body.error || 'Request failed');
    return body;
  }

  const mediaUrl = (id, file) => `/media?id=${encodeURIComponent(id)}&file=${encodeURIComponent(file)}`;

  /** Wrap every occurrence of the search terms in <mark>, inside one text node's parent. */
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

  // ── Library ──

  async function loadLibrary() {
    try {
      const body = await api('/api/library');
      state.library = body;
      renderFolders();
      renderList();
      const total = body.meetings.reduce((sum, meeting) => sum + (meeting.bytes || 0), 0);
      $('totals').textContent = `${body.meetings.length} meetings · ${fmtBytes(total)}`;
    } catch (error) {
      if (error.message !== 'expired') toast('Could not load the library: ' + error.message);
    }
  }

  function inFolder(meeting, folder) {
    if (!folder) return true;
    if (folder.startsWith('tag:')) return meeting.tags.includes(folder.slice(4));
    if (folder === '/') return meeting.parent === '';
    return meeting.parent === folder || meeting.parent.startsWith(folder + '/');
  }

  function renderFolders() {
    const nav = $('folders');
    nav.replaceChildren();
    const { meetings, folders } = state.library;
    const button = (id, label, depth = 0) => el('button', {
      class: 'folder' + (state.folder === id ? ' active' : ''),
      style: `padding-left:${10 + depth * 14}px`,
      onclick: () => { state.folder = id; renderFolders(); renderList(); }
    }, [el('span', { text: label }), el('span', { class: 'count', text: meetings.filter((m) => inFolder(m, id)).length })]);

    nav.append(button('', 'All meetings'));
    if (folders.length) {
      nav.append(button('/', 'Not in a folder'));
      nav.append(el('div', { class: 'folder-group', text: 'Folders' }));
      const sorted = folders.slice().sort((a, b) => a.id.localeCompare(b.id));
      for (const folder of sorted) nav.append(button(folder.id, folder.name, folder.id.split('/').length - 1));
    }
    const tags = [...new Set(meetings.flatMap((meeting) => meeting.tags))].sort();
    if (tags.length) {
      nav.append(el('div', { class: 'folder-group', text: 'Tags' }));
      for (const tag of tags) nav.append(button('tag:' + tag, '#' + tag));
    }
  }

  function sortMeetings(list) {
    const by = $('sort').value;
    const sorted = list.slice();
    if (state.results) return sorted.sort((a, b) => state.results.get(b.id).hits - state.results.get(a.id).hits);
    if (by === 'oldest') return sorted.sort((a, b) => a.startedAt - b.startedAt);
    if (by === 'longest') return sorted.sort((a, b) => (b.durationMs || 0) - (a.durationMs || 0));
    if (by === 'largest') return sorted.sort((a, b) => b.bytes - a.bytes);
    return sorted.sort((a, b) => b.startedAt - a.startedAt);
  }

  function renderList() {
    const list = $('meetings');
    list.replaceChildren();
    let meetings = state.library.meetings.filter((meeting) => inFolder(meeting, state.folder));
    if (state.results) meetings = meetings.filter((meeting) => state.results.has(meeting.id));
    meetings = sortMeetings(meetings);

    const folder = state.library.folders.find((entry) => entry.id === state.folder);
    $('listTitle').textContent = state.results
      ? `${meetings.length} result${meetings.length === 1 ? '' : 's'} for “${state.query}”`
      : state.folder.startsWith('tag:') ? '#' + state.folder.slice(4)
        : state.folder === '/' ? 'Not in a folder'
          : folder ? folder.name : 'All meetings';
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

      const item = el('li', {
        class: 'meeting' + (state.meeting && state.meeting.id === meeting.id ? ' active' : ''),
        dataset: { id: meeting.id },
        tabindex: '0',
        onclick: () => openMeeting(meeting.id),
        onkeydown: (event) => { if (event.key === 'Enter') openMeeting(meeting.id); }
      }, [
        el('div', { class: 'row1' }, [
          el('span', { class: 'name', text: meeting.title || meeting.name, title: meeting.name }),
          el('span', { class: 'when', text: new Date(meeting.startedAt).toLocaleDateString() })
        ]),
        el('div', { class: 'row2' }, [
          el('span', { text: new Date(meeting.startedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) }),
          meeting.durationMs ? el('span', { text: fmtDuration(meeting.durationMs) }) : null,
          el('span', { text: fmtBytes(meeting.bytes) }),
          ...pills
        ])
      ]);
      if (state.results) {
        for (const snippet of state.results.get(meeting.id).snippets) {
          const node = el('div', { class: 'snippet', text: snippet });
          highlightTerms(node, terms);
          item.append(node);
        }
      }
      list.append(item);
    }
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
        return;
      }
      try {
        const body = await api('/api/search?q=' + encodeURIComponent(query));
        if (body.query !== $('search').value.trim()) return; // typed on meanwhile
        state.results = new Map(body.results.map((result) => [result.id, result]));
        renderList();
      } catch (error) {
        if (error.message !== 'expired') toast('Search failed: ' + error.message);
      }
    }, 250);
  }

  // ── Meeting view ──

  async function openMeeting(id) {
    let body;
    try {
      body = await api('/api/meeting?id=' + encodeURIComponent(id));
    } catch (error) {
      if (error.message !== 'expired') toast('Could not open the meeting: ' + error.message);
      return;
    }
    if (state.player) state.player.destroy();
    const meeting = body.meeting;
    state.meeting = meeting;
    history.replaceState(null, '', '#' + encodeURIComponent(id));
    document.querySelectorAll('.meeting').forEach((node) => node.classList.toggle('active', node.dataset.id === id));

    $('placeholder').hidden = true;
    $('meetingView').hidden = false;
    $('meetingTitle').textContent = meeting.title || meeting.name;
    $('meetingMeta').textContent = [fmtDate(meeting.startedAt), fmtDuration(meeting.durationMs), meeting.parent ? 'in ' + meeting.parent : '']
      .filter(Boolean).join(' · ');
    const badges = $('meetingBadges');
    badges.replaceChildren();
    if (meeting.state) badges.append(el('span', { class: 'pill state', text: meeting.state }));
    badges.append(el('span', { class: 'pill' + (meeting.source === 'final' ? ' final' : ''), text: meeting.source === 'final' ? 'final transcript' : meeting.source === 'live' ? 'live transcript' : 'no transcript' }));

    renderTranscript();
    renderDetails();
    state.player = createPlayer(meeting);

    const terms = queryTerms(state.query);
    if (terms.length) {
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

  function renderTranscript() {
    const meeting = state.meeting;
    const box = $('transcript');
    box.replaceChildren();
    const showMarkup = $('showMarkup').checked;
    box.classList.toggle('plain', !showMarkup);
    $('sourceNote').textContent = meeting.source === 'final'
      ? 'Final pass' + (meeting.asr && meeting.asr.model ? ' · ' + meeting.asr.model : '')
      : meeting.source === 'live' ? 'Live transcript (no final pass yet)' : 'This meeting has no transcript.';

    meeting.entries.forEach((entry, index) => {
      const time = el('span', { class: 't', text: entry.clock || new Date(entry.startedAt).toLocaleTimeString() });
      if (entry.kind === 'screenshot') {
        box.append(el('div', { class: 'event', dataset: { index }, onclick: () => seekTo(entry.startedAt) }, [
          time,
          el('div', {}, ['Screenshot ' + entry.text, el('img', { src: mediaUrl(meeting.id, entry.text), alt: 'Screenshot ' + entry.text, loading: 'lazy' })])
        ]));
        return;
      }
      if (entry.kind === 'marker') {
        box.append(el('div', { class: 'event', dataset: { index }, onclick: () => seekTo(entry.startedAt) }, [
          time, el('div', { text: '⚑ Marker' + (entry.text ? ': ' + entry.text : '') })
        ]));
        return;
      }
      const text = el('span', { class: 'text' });
      if (showMarkup && entry.marked) text.append(...markupNodes(entry.marked));
      else if (!showMarkup && entry.words && entry.words.length) text.append(...wordNodes(entry));
      else text.textContent = entry.text;
      box.append(el('div', {
        class: 'line',
        dataset: { index, start: entry.startedAt, end: entry.endedAt || entry.startedAt },
        onclick: () => seekTo(entry.startedAt, true)
      }, [time, el('span', { class: 'who ' + labelClass(entry, meeting), text: entry.label }), text]));
    });

    highlightTerms(box, queryTerms(state.query));
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
      ['Size on disk', fmtBytes(meeting.bytes)],
      ['Audio', meeting.streams.map((stream) => `${stream.label} (${stream.file})`).join(', ') || 'none'],
      ['Screenshots', String(meeting.screenshots)],
      ['Transcript', meeting.source],
      ['Model', meeting.asr ? [meeting.asr.model, meeting.asr.language, meeting.asr.device].filter(Boolean).join(' · ') : ''],
      ['Glossary', meeting.asr && meeting.asr.glossary ? meeting.asr.glossary.join(', ') : ''],
      ['Notes', meeting.notes],
      ['Participants', meeting.participants]
    ];
    for (const [key, value] of rows) {
      if (!value) continue;
      list.append(el('dt', { text: key }), el('dd', { text: value }));
    }
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

    function markCurrent(t) {
      const line = currentLine(t);
      if (line !== player.current) {
        const box = $('transcript');
        const old = player.current >= 0 ? box.querySelector(`.line[data-index="${speech[player.current].index}"]`) : null;
        if (old) old.classList.remove('current');
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
      document.querySelectorAll('.word.now').forEach((node) => node.classList.remove('now'));
      if (line >= 0) {
        const words = $('transcript').querySelectorAll(`.line[data-index="${speech[line].index}"] .word`);
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
        if (t > line.end + 150) return seek(line.start, false), schedule();
      } else if ($('skipSilence').checked) {
        const inside = speech.some((line) => t >= line.start - 300 && t < line.end + 300);
        const next = speech.find((line) => line.start > t);
        if (!inside && next && next.start - t > 2000) return seek(next.start - 300, false), schedule();
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
      base,
      total,
      toggle: () => (player.playing ? pause() : play()),
      play,
      pause,
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
      refresh: () => { syncTracks(false); markCurrent(player.t); },
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
    if (state.player) state.player.seekAbs(abs, start);
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
          const fresh = state.library.meetings.find((meeting) => meeting.id === state.meeting.id);
          if (fresh && fresh.state !== state.meeting.state) openMeeting(state.meeting.id);
        }
      }, 400);
    };
    source.addEventListener('library', refreshSoon);
    source.addEventListener('final-pass', (event) => {
      const data = JSON.parse(event.data);
      const box = $('queue');
      box.hidden = false;
      box.replaceChildren(
        el('div', { text: data.message || 'Final pass' }),
        el('div', { class: 'bar' }, el('span', { style: `width:${Math.round((data.pct || 0) * 100)}%` }))
      );
      if (data.state === 'done' || data.state === 'failed' || data.state === 'cancelled') {
        setTimeout(() => { box.hidden = true; }, 6000);
        refreshSoon();
      } else if (data.state === 'starting' || data.state === 'queued') {
        refreshSoon();
      }
    });
  }

  // ── Wiring ──

  function bind() {
    $('search').addEventListener('input', onSearch);
    $('sort').addEventListener('change', renderList);
    $('showMarkup').addEventListener('change', () => {
      if (!state.meeting) return;
      renderTranscript();
      if (state.player) state.player.refresh();
    });
    $('playBtn').addEventListener('click', () => state.player && state.player.toggle());
    $('seek').addEventListener('input', () => state.player && state.player.seekFraction(Number($('seek').value) / 1000));
    $('speed').addEventListener('change', () => state.player && state.player.refresh());
    $('loopLine').addEventListener('change', () => state.player && state.player.setLoop($('loopLine').checked));

    document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((node) => node.classList.toggle('active', node === tab));
      document.querySelectorAll('.tab-page').forEach((page) => { page.hidden = page.id !== 'tab-' + tab.dataset.tab; });
    }));

    document.addEventListener('keydown', (event) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName) && event.target.type !== 'checkbox' && event.target.type !== 'range';
      if (event.key === 'Escape' && event.target === $('search')) {
        $('search').value = '';
        onSearch();
        $('search').blur();
        return;
      }
      if (typing || event.ctrlKey || event.metaKey || event.altKey) return;
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
    const id = decodeURIComponent(location.hash.slice(1));
    if (id && state.library.meetings.some((meeting) => meeting.id === id)) openMeeting(id);
  }

  start();
})();
