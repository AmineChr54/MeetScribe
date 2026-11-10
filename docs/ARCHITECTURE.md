# Architecture

MeetScribe is an Electron app (main process + several renderer windows) that shells out to long-lived Python workers for speech recognition.

## Process model

| Piece | File(s) | Role |
|---|---|---|
| Main process | `main.js` | App lifecycle, all IPC handlers (`meeting:*`, `settings:*`, `whisper:*`, window controls), wires services together |
| Preload | `preload.js` | Context-isolated bridge exposing a narrow API to renderers (`nodeIntegration` is off) |
| Windows | `src/managers/window.manager.js` | Overlay, transcript and settings windows, click-through, show/hide, display watching, a hidden audio-engine window |
| Audio engine | `audio-engine.html`, `src/ui/audio-engine.js` | Hidden renderer that captures system loopback + mic and streams PCM to main |
| UI | `index.html`, `transcript.html`, `settings.html`, `src/ui/*.js` | Overlay, live transcript, settings |

## Live pipeline

1. **Capture** (`audio-engine.js`): two streams, `system` (labeled *Them*) and `mic` (*You*), 16 kHz mono PCM16.
2. **Per-stream VAD** (`transcription-stream.js`): splits speech into utterances (700 ms silence hangover, 350 ms minimum, 12 s cap, 300 ms pre-roll) and drops known Whisper hallucinations (EN/DE closing phrases).
3. **Whisper pool** (`whisper-pool.service.js`): serialises requests onto N persistent workers (default 1, queue cap 6).
4. **Worker** (`whisper-worker.service.js` + `scripts/whisper_worker.py`): a spawned Python process speaking a JSON-lines protocol on stdin/stdout, unloads the model when idle.
5. **Echo suppression** (`transcription.service.js`): drops *You* lines that match recent *Them* lines.
6. **Meeting file** (`meeting.service.js`): one folder per meeting, fsync'd append-only transcript. Lines are reordered by speech *start* time inside a 1200 ms window (15 s max hold).

## Archive and offline pass

- `audio-archive.service.js` records raw PCM per stream **before** VAD so timestamps stay wall-clock, writes a `timeline.jsonl` checkpoint every 5 s, pads long stalls with silence, and transcodes to FLAC via `scripts/transcode_flac.py` (PyAV).
- `model-store.service.js` is the model catalog (aliases → Hugging Face repos), the cache status of `userData/.whisper-models`, and download/delete through faster-whisper's own `download_model`. Repos published only as Transformers weights are instead fetched and converted to CTranslate2 by `scripts/convert_ct2.py` into `.whisper-models/converted/`, with the source weights kept in a scratch folder that is deleted afterwards. `speed-stats.service.js` learns final-pass speed (decode seconds per speech-second, per model and mode) and speech per meeting-hour from every pass, into `userData/model-speed.json` (numbers only), and turns them into the per-model time estimate.
- `offline-pass.service.js` runs `scripts/whisper_offline.py` after the meeting: `large-v3-turbo` at beam 2, in one of two modes: `fast` (default) runs `BatchedInferencePipeline` over Silero-VAD speech chunks, `quality` is one continuous decode with `condition_on_previous_text`. Passes are queued one at a time at below-normal priority, persisted across restarts. The glossary is trimmed to a token budget so it can't overflow the 448-token context. Temperature ladder with a compression-ratio guard against repetition loops, low-confidence words marked `~like this~`, optional `diffModel` cross-check, paragraph blocks, `## HH:MM` chapters, and an index of up to 40 uncertain spans.

## Browser manager

- `manager-server.service.js` is a small `http` server inside the main process, started on demand by `manager:open` (overlay **Library**, Settings **Open Manager**) and closed once no tab has been connected for 5 minutes. It binds to `127.0.0.1` on a random port. Every request needs a per-start secret (handed over once in the URL, then an HttpOnly SameSite=Strict cookie) and a loopback `Host` header; changing requests also need our own `Origin` (`src/core/manager-http.js`, pure and unit-tested).
- It serves `manager.html` + `src/ui/manager.{js,css}`, a JSON API, media with byte ranges (seeking in long FLACs), and Server-Sent Events that relay final-pass and model progress.
- `library.service.js` reads the transcript folder: a meeting is any folder with `transcript.txt`, `transcript.final.md` or `audio/meta.json` (up to 3 levels deep); other folders are grouping folders. Timelines come from `transcript.final.json`, else from parsing `transcript.txt` (`src/core/library.js`). Every path from the page is confined to the transcript folder.
- `library-edit.service.js` makes every change on disk: `meeting.json` (title, notes, participants, tags), renaming and moving meeting folders (the `YYYY-MM-DD_HH-MM` stamp stays in the name), grouping folders, the Recycle Bin (`shell.trashItem`), glossary and corrections, and transcript edits. Edits go through `src/core/transcript-edit.js` (pure; each names its line by index and start time, so a stale page cannot edit the wrong line) and `transcript.final.md` is rebuilt from `transcript.final.json` by `src/core/transcript-render.js`, the same renderer the final pass uses. Markers also go to `events.json` so a re-run keeps them. A meeting that is recording, queued or being transcribed is refused.
- Re-runs from the manager carry per-run `overrides` (model, diff model, language, mode, beam; `src/core/pass-options.js`) through `offlinePass.enqueue` into `run()`, merged over the settings for that pass only, and persisted with the pending queue (`{ folder, overrides }`; bare folders from older builds still load). The queue can be cancelled, reordered and trimmed (`dequeue`, `reorder`).
- Imports stream the uploaded file to `<meeting>/audio/import.<ext>` with a one-stream `audio/meta.json` (`imported: true`, stream `import`); faster-whisper decodes it through PyAV, and the archive steps (WAV repair, FLAC transcode) leave it alone.
- Settings from the browser go through `src/core/settings-schema.js`: a whitelist with types and limits that both validates every change server-side and describes the form. `whisperPython` and `transcriptRoot` are deliberately not in it (a tab must not choose what executable runs or where the library reads and deletes), nor are audio devices or the profile store. Profile edits use `profiles.update`, and changes then go through `main.js` `saveSettings`/`selectProfile`, exactly like the Settings window.
- The player keeps one `<audio>` per stream aligned through each stream's `startedAt` in `audio/meta.json`.

## Configuration and data

- `src/core/config.js`: shipped defaults (not user-facing).
- `src/core/settings.store.js`: user settings as JSON in `userData`, atomic writes, seeded from config defaults.
- `src/core/profiles.js`: built-in profiles (named sets of settings) and the pure logic for picking one, remembering edits per profile and naming meeting folders. A profile changes the glossary only if one was stored for it.
- Whisper venv and models: `%APPDATA%\MeetScribe\.venv-whisper` and `.whisper-models` (created by `scripts/setup-whisper.js`).
- Transcripts: `~/Documents/MeetingTranscripts/<meeting>/`.
- Logs: winston via `src/core/logger.js`.

## Conventions

- Services are classes exporting a singleton; log with `createServiceLogger('<name>')`, never `console.log` in `src/`.
- New user-facing setting = default in `config.js` + key in `settings.store.js` + UI in `settings.html`/`settings-window.js` + IPC if needed.
- The version lives in `package.json` **and** `src/core/config.js`; bump both.
- `assests/` is a historical typo kept for now ([rename is a tracked issue](https://github.com/AmineChr54/MeetScribe/issues)).
