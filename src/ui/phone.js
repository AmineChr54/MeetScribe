/*
 * MeetScribe phone recorder: records with the phone's microphone and sends the
 * file to MeetScribe on the PC once the recording stops (see
 * src/services/phone-server.service.js). Every 10 s of audio is also kept in
 * IndexedDB, so a reload or a crash does not lose the meeting; it is deleted
 * from the phone only after the PC confirms it has the file.
 */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const PING_MS = 20 * 1000;
  const CHUNK_MS = 10 * 1000;
  const FORMATS = [
    { mime: 'audio/webm;codecs=opus', ext: 'webm' },
    { mime: 'audio/webm', ext: 'webm' },
    { mime: 'audio/mp4', ext: 'm4a' },
    { mime: 'audio/ogg;codecs=opus', ext: 'ogg' }
  ];

  const state = {
    mode: 'ready', // ready | recording | paused | stopping | uploading | unsent | sent
    rec: null, // { id, startedAt, activeMs, mime, ext }
    chunks: [],
    stream: null,
    recorder: null,
    muted: false,
    segmentStart: 0,
    audio: null, // { context, analyser, data }
    wakeLock: null,
    whisperReady: null,
    pending: [] // unsent recordings found in IndexedDB
  };

  // ── Small helpers ──

  const pad = (n) => String(n).padStart(2, '0');
  function clock(ms) {
    const total = Math.floor(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }

  function elapsed() {
    if (!state.rec) return 0;
    return state.rec.activeMs + (state.mode === 'recording' ? Date.now() - state.segmentStart : 0);
  }

  function hint(text, error = false) {
    $('hint').textContent = text;
    $('hint').classList.toggle('error', error);
  }

  function linkState(kind, text) {
    $('linkState').dataset.state = kind;
    $('linkState').textContent = text;
  }

  function extFor(mime) {
    if (/webm/i.test(mime)) return 'webm';
    if (/mp4|aac|m4a/i.test(mime)) return 'm4a';
    if (/ogg/i.test(mime)) return 'ogg';
    return 'webm';
  }

  // ── IndexedDB: the recording survives a reload ──

  const db = { handle: null };

  function request(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function openDb() {
    if (db.handle !== null) return db.handle;
    try {
      const open = indexedDB.open('meetscribe-phone', 1);
      open.onupgradeneeded = () => {
        const handle = open.result;
        handle.createObjectStore('recs', { keyPath: 'id' });
        handle.createObjectStore('chunks', { autoIncrement: true }).createIndex('rec', 'rec');
      };
      db.handle = await request(open);
    } catch (_) {
      db.handle = false; // private mode or blocked: memory only
    }
    return db.handle;
  }

  const store = (name, mode = 'readonly') => db.handle.transaction(name, mode).objectStore(name);

  async function saveRec(rec) {
    if (!(await openDb())) return;
    try { await request(store('recs', 'readwrite').put(rec)); } catch (_) { /* memory copy remains */ }
  }

  async function saveChunk(id, blob) {
    if (!(await openDb())) return;
    try {
      // Bytes rather than a Blob: older Safari loses Blobs kept in IndexedDB.
      const bytes = await blob.arrayBuffer();
      await request(store('chunks', 'readwrite').add({ rec: id, bytes }));
    } catch (_) { /* memory copy remains */ }
  }

  async function loadChunks(id) {
    if (!(await openDb())) return [];
    const rows = await request(store('chunks').index('rec').getAll(IDBKeyRange.only(id)));
    return rows.map((row) => row.bytes);
  }

  /** Chunks and entry in one transaction: never an entry-less pile of chunks. */
  async function deleteRec(id) {
    if (!(await openDb())) return;
    try {
      await new Promise((resolve, reject) => {
        const tx = db.handle.transaction(['recs', 'chunks'], 'readwrite');
        const chunks = tx.objectStore('chunks');
        chunks.index('rec').getAllKeys(IDBKeyRange.only(id)).onsuccess = (event) => {
          for (const key of event.target.result) chunks.delete(key);
          tx.objectStore('recs').delete(id);
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } catch (_) { /* best effort */ }
  }

  async function unsentRecs() {
    if (!(await openDb())) return [];
    try {
      const recs = await request(store('recs').getAll());
      return recs.sort((a, b) => a.startedAt - b.startedAt);
    } catch (_) {
      return [];
    }
  }

  // ── Talking to the PC ──

  async function ping() {
    try {
      const response = await fetch('/api/ping', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: state.mode === 'stopping' ? 'recording' : state.mode, elapsedMs: elapsed() })
      });
      if (response.status === 403) {
        linkState('lost', 'Link expired');
        return false;
      }
      const body = await response.json();
      state.whisperReady = Boolean(body.whisperReady);
      linkState('ok', 'Connected to PC');
      return true;
    } catch (_) {
      linkState('lost', 'PC not reachable');
      return false;
    }
  }

  function upload(blob, rec, name) {
    const query = new URLSearchParams({
      name,
      // Lets the PC recognise a resend whose first answer was lost.
      clientId: rec.id,
      startedAt: String(rec.startedAt),
      durationMs: String(Math.round(rec.activeMs)),
      ext: rec.ext
    });
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/upload?' + query.toString());
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) $('progressFill').style.width = `${(event.loaded / event.total) * 100}%`;
      };
      xhr.onload = () => {
        if (xhr.status === 403) return resolve({ ok: false, expired: true, error: 'The link has expired' });
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch (_) {
          resolve({ ok: false, error: 'HTTP ' + xhr.status });
        }
      };
      xhr.onerror = () => resolve({ ok: false, error: 'The PC could not be reached' });
      xhr.send(blob);
    });
  }

  // ── Screen ──

  async function keepAwake(on) {
    try {
      if (on && !state.wakeLock && navigator.wakeLock) {
        state.wakeLock = await navigator.wakeLock.request('screen');
        state.wakeLock.addEventListener('release', () => { state.wakeLock = null; });
      } else if (!on && state.wakeLock) {
        await state.wakeLock.release();
        state.wakeLock = null;
      }
    } catch (_) { /* not supported or refused; the note in the footer stands */ }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (state.mode === 'recording' || state.mode === 'paused') keepAwake(true);
    ping();
  });

  // ── Level meter ──

  function startMeter(stream) {
    try {
      const Context = window.AudioContext || window.webkitAudioContext;
      const context = new Context();
      // Created after an await, so iOS may start it suspended.
      if (context.state === 'suspended') context.resume().catch(() => {});
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      context.createMediaStreamSource(stream).connect(analyser);
      state.audio = { context, analyser, data: new Float32Array(analyser.fftSize) };
      const draw = () => {
        if (!state.audio) return;
        state.audio.analyser.getFloatTimeDomainData(state.audio.data);
        let sum = 0;
        for (const value of state.audio.data) sum += value * value;
        const rms = Math.sqrt(sum / state.audio.data.length);
        const level = state.mode === 'recording' ? Math.min(1, rms * 6) : 0;
        $('meter').style.transform = `scaleX(${level.toFixed(3)})`;
        $('timer').textContent = clock(elapsed());
        requestAnimationFrame(draw);
      };
      requestAnimationFrame(draw);
    } catch (_) { /* the timer still runs from render() */ }
  }

  function stopMeter() {
    if (state.audio) {
      try { state.audio.context.close(); } catch (_) { /* already closed */ }
    }
    state.audio = null;
    $('meter').style.transform = 'scaleX(0)';
  }

  // ── Recording ──

  function pickFormat() {
    if (typeof MediaRecorder.isTypeSupported !== 'function') return null;
    return FORMATS.find((format) => MediaRecorder.isTypeSupported(format.mime)) || null;
  }

  async function start() {
    // Set before the first await: a second tap while the microphone opens
    // must not start a second recorder writing into the same recording.
    if (state.mode !== 'ready') return;
    state.mode = 'starting';
    render();
    const fail = (text) => {
      state.mode = 'ready';
      render();
      hint(text, true);
    };
    if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      fail('This page needs its secure link to use the microphone. Scan the QR code in MeetScribe again.');
      return;
    }
    if (typeof MediaRecorder === 'undefined') {
      fail('This browser cannot record audio. Update it, or try Chrome (Android) or Safari (iPhone).');
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        // Whisper copes better with the raw room than with a phone's call processing.
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true, channelCount: 1 }
      });
    } catch (error) {
      fail(error && error.name === 'NotAllowedError'
        ? 'Microphone access was refused. Allow it for this page in the browser settings, then try again.'
        : 'The microphone could not be opened: ' + ((error && error.message) || error));
      return;
    }

    const format = pickFormat();
    let recorder;
    try {
      try {
        recorder = new MediaRecorder(stream, format ? { mimeType: format.mime, audioBitsPerSecond: 48000 } : { audioBitsPerSecond: 48000 });
      } catch (_) {
        recorder = new MediaRecorder(stream);
      }
    } catch (error) {
      for (const track of stream.getTracks()) track.stop();
      fail('This browser cannot record audio: ' + ((error && error.message) || error));
      return;
    }
    const mime = recorder.mimeType || (format && format.mime) || 'audio/webm';
    // Each handler keeps its own recording, so nothing can land in another one.
    const rec = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, startedAt: Date.now(), activeMs: 0, mime, ext: extFor(mime) };
    const chunks = [];
    state.stream = stream;
    state.recorder = recorder;
    state.chunks = chunks;
    state.rec = rec;
    state.muted = false;
    state.segmentStart = Date.now();
    await saveRec(rec);

    recorder.ondataavailable = (event) => {
      if (!event.data || !event.data.size) return;
      chunks.push(event.data);
      saveChunk(rec.id, event.data);
      saveRec({ ...rec, activeMs: state.rec === rec ? elapsed() : rec.activeMs });
    };
    recorder.onstop = () => finish();
    recorder.onerror = (event) => {
      hint('Recording error: ' + ((event.error && event.error.message) || 'unknown') + '. What was recorded so far is kept.', true);
    };
    for (const track of stream.getAudioTracks()) {
      // A phone call or another app can take the microphone away for good...
      track.addEventListener('ended', () => {
        if (state.mode === 'recording' || state.mode === 'paused') stop();
      });
      // ...or for a while (iOS mutes it on lock, app switch or a call).
      track.addEventListener('mute', () => {
        state.muted = true;
        render();
      });
      track.addEventListener('unmute', () => {
        state.muted = false;
        render();
      });
    }

    recorder.start(CHUNK_MS);
    state.mode = 'recording';
    startMeter(stream);
    keepAwake(true);
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    render();
    ping();
  }

  function togglePause() {
    const { recorder } = state;
    if (!recorder) return;
    if (state.mode === 'recording' && recorder.state === 'recording') {
      recorder.pause();
      state.rec.activeMs += Date.now() - state.segmentStart;
      state.mode = 'paused';
    } else if (state.mode === 'paused' && recorder.state === 'paused') {
      recorder.resume();
      state.segmentStart = Date.now();
      state.mode = 'recording';
    }
    saveRec(state.rec);
    render();
    ping();
  }

  function stop() {
    const { recorder } = state;
    if (!recorder || recorder.state === 'inactive') return;
    if (state.mode === 'recording') state.rec.activeMs += Date.now() - state.segmentStart;
    state.mode = 'stopping';
    render();
    recorder.stop(); // the last chunk arrives, then onstop → finish()
  }

  async function finish() {
    // The browser stopped it by itself (error, microphone gone): count the last stretch.
    if (state.mode === 'recording') state.rec.activeMs += Date.now() - state.segmentStart;
    state.mode = 'stopping';
    state.muted = false;
    for (const track of state.stream ? state.stream.getTracks() : []) track.stop();
    stopMeter();
    keepAwake(false);
    state.stream = null;
    state.recorder = null;
    await saveRec(state.rec);
    const blob = new Blob(state.chunks, { type: state.rec.mime });
    await send(state.rec, blob);
  }

  async function send(rec, blob) {
    const name = $('name').value.trim() || 'Phone recording';
    state.mode = 'uploading';
    $('progressFill').style.width = '0%';
    render();
    const result = blob.size ? await upload(blob, rec, name) : { ok: false, empty: true, error: 'Nothing was recorded' };
    if (result.ok) {
      await deleteRec(rec.id);
      state.mode = 'sent';
      state.rec = null;
      state.chunks = [];
      $('doneText').textContent = result.duplicate
        ? 'Your PC already had this recording; it is in the Library.'
        : result.transcribing
        ? `${clock(rec.activeMs)} sent. MeetScribe is transcribing it on your PC; it is in the Library's Inbox.`
        : `${clock(rec.activeMs)} sent to the Library's Inbox. Start the transcription there once MeetScribe is set up.`;
      $('name').value = '';
      render();
      ping();
      return;
    }
    if (result.empty) {
      await deleteRec(rec.id);
      state.mode = 'ready';
      state.rec = null;
      render();
      hint('Nothing was recorded. Try again.', true);
      return;
    }
    state.mode = 'unsent';
    state.pending.unshift({ ...rec, blob });
    render();
    hint(result.expired
      ? 'The link has expired. The recording is safe on this phone: open Phone in MeetScribe again, scan the new code, then send it.'
      : `Sending failed (${result.error}). The recording is safe on this phone; try again.`, true);
  }

  // ── Recordings left over from an earlier visit ──

  async function checkUnsent() {
    const recs = await unsentRecs();
    // Never interrupt a recording started while this was loading.
    if (!recs.length || state.mode !== 'ready') return;
    state.pending = recs;
    state.mode = 'unsent';
    render();
  }

  async function sendPending() {
    // Taken off the list and the screen switched before the first await, so a
    // second tap cannot send the same recording twice.
    if (state.mode !== 'unsent') return;
    const rec = state.pending.shift();
    if (!rec) return;
    state.mode = 'uploading';
    render();
    let blob = rec.blob;
    if (!blob) {
      const parts = await loadChunks(rec.id);
      blob = new Blob(parts, { type: rec.mime });
    }
    await send(rec, blob);
  }

  async function discardPending() {
    const rec = state.pending[0];
    if (!rec) return;
    if (!window.confirm('Delete this recording from the phone? It has not reached your PC.')) return;
    await deleteRec(rec.id);
    state.pending.shift();
    state.mode = state.pending.length ? 'unsent' : 'ready';
    render();
  }

  // ── Screen state ──

  function render() {
    const { mode } = state;
    const live = mode === 'recording' || mode === 'paused';
    document.body.classList.toggle('recording', mode === 'recording');
    $('recBtn').dataset.mode = live ? 'stop' : 'record';
    $('recBtn').setAttribute('aria-label', live ? 'Stop and send' : 'Start recording');
    $('recBtn').disabled = !['ready', 'recording', 'paused'].includes(mode);
    $('sendBtn').disabled = mode !== 'unsent';
    $('recLabel').textContent = live ? 'Stop & send'
      : mode === 'starting' ? 'Opening the microphone…'
        : mode === 'uploading' || mode === 'stopping' ? 'Sending…' : 'Record';
    $('pauseBtn').hidden = !live;
    $('pauseBtn').textContent = mode === 'paused' ? 'Resume' : 'Pause';
    $('progress').hidden = mode !== 'uploading';
    $('recorder').hidden = mode === 'unsent' || mode === 'sent';
    $('unsent').hidden = mode !== 'unsent';
    $('done').hidden = mode !== 'sent';
    if (!state.audio) $('timer').textContent = clock(elapsed());

    if (mode === 'unsent' && state.pending[0]) {
      const rec = state.pending[0];
      const when = new Date(rec.startedAt);
      $('unsentText').textContent = `Recorded ${when.toLocaleDateString()} at ${when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` +
        (rec.activeMs ? `, ${clock(rec.activeMs)}` : '') +
        (state.pending.length > 1 ? ` (${state.pending.length - 1} more after this one)` : '') + '.';
    }
    if (mode === 'ready') hint('Tap the button to start recording with this phone\'s microphone.');
    else if (live && state.muted) hint('The microphone was taken away (screen locked, another app or a call). Recording goes on when it is back; keep this page in front.', true);
    else if (mode === 'starting') hint('Allow the microphone if the phone asks.');
    else if (mode === 'recording') hint('Recording. It is sent to your PC when you stop.');
    else if (mode === 'paused') hint('Paused. Paused time is left out of the recording.');
    else if (mode === 'stopping') hint('Finishing the recording…');
    else if (mode === 'uploading') hint('Sending to your PC…');
  }

  $('recBtn').addEventListener('click', () => {
    if (state.mode === 'ready') {
      start();
    } else if (state.mode === 'recording' || state.mode === 'paused') {
      stop();
    }
  });
  $('pauseBtn').addEventListener('click', togglePause);
  $('sendBtn').addEventListener('click', sendPending);
  $('discardBtn').addEventListener('click', discardPending);
  // Done, or not sending now: back to the recorder (left-over recordings first).
  $('againBtn').addEventListener('click', () => {
    state.mode = state.pending.length ? 'unsent' : 'ready';
    render();
  });
  $('laterBtn').addEventListener('click', () => {
    state.mode = 'ready';
    render();
  });

  window.addEventListener('beforeunload', (event) => {
    if (['recording', 'paused', 'stopping', 'uploading'].includes(state.mode)) {
      event.preventDefault();
      event.returnValue = '';
    }
  });

  render();
  ping();
  setInterval(ping, PING_MS);
  // The meter's animation frame updates the timer; this covers browsers
  // where the level meter could not start.
  setInterval(() => {
    if (!state.audio && (state.mode === 'recording' || state.mode === 'paused')) $('timer').textContent = clock(elapsed());
  }, 1000);
  checkUnsent();
})();
