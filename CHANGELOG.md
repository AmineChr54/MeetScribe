# Changelog

All notable changes to this project are documented here. Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning follows [SemVer](https://semver.org/).

## [Unreleased]

### Added

- Unit tests for the hallucination filter, transcript reordering and echo suppression (`npm test`, run in CI).
- Profiles in Settings (English, German, German · Work, Tunisian): one click preselects live/final models, language, transcript visibility and a meeting folder name prefix. Edits are remembered per profile.
- Setting to turn the live transcript off: the audio is still archived and the final pass writes the transcript.
- Tunisian large-v3 (`medyas/FarukSTT`), converted to CTranslate2 on download; German tiny and small.en live models.
- Downloaded models are grouped by purpose; Settings sections collapse and remember their state.
- Meeting library in the browser (overlay → Library, or Settings → Open Manager): browse meetings by folder and tag, search every transcript, and play the archived audio in sync with the transcript (speed, solo one side, skip silence, loop a line, keyboard shortcuts). Screenshots and markers sit in the timeline. Served only on 127.0.0.1 while a tab is open, behind a one-time token.
- In the library: give meetings a title, notes, participants and tags; rename, move and organise them into folders (real folders on disk, the date stays in the name); fix transcript text and speakers, merge or delete lines, add markers; edit a meeting's glossary and corrections (select a word to add a correction); export as Markdown, text, SRT or text for an LLM, or copy it; delete meetings or only their audio to the Recycle Bin, with a storage view to clean up old audio. Meetings that are recording or being transcribed are left alone.
- Re-run the final pass from the library with another model, language, mode or cross-check model, for one meeting or a selection; the queue shows progress and passes can be cancelled, reordered or removed. Per-run choices survive a restart and never change your settings.
- Import a recording (mp3, m4a, wav, flac, ogg, webm) into the library as a new meeting and transcribe it with the final pass.
- Profiles, models and settings in the library too: switch, edit or reset any profile (not only the active one), download and delete models with live progress and pick the live and final model, and change the same settings as in the app. The Python environment, the transcript folder and audio devices stay app-only.
- A new look for the library: the app's colours and logo, icons on every action (delete is red, with a menu for "audio only" or "whole meeting"), a folder tree with nested folders that collapse.
- The library opens on an **Inbox** of meetings not yet filed; drag meetings (or a whole selection) onto a folder, drag folders into each other, and drop an audio file anywhere to import it. Search still looks in every folder.
- Project glossaries: one named glossary per project (the Glossaries page, stored in `.glossaries` in the transcript folder). A meeting can use several or none (its Glossary tab, or the re-run dialog), and a profile picks the ones new recordings start with.
- Your own profiles: save the current settings as a profile, duplicate any profile, rename it, give it a flag, delete it. "No profile" replaces "My settings" and stands for the multilingual defaults.
- Models come in two lists, live and final pass. German small (`mkenfenheuer/whisper-small-cv11-german-ct2`) for live German. Search Hugging Face from the Models page and add any Whisper model for live or final; Transformers models are converted on download.
- Library-only mode: the library's server without the overlay. Start it from the "Open MeetScribe Library" shortcut MeetScribe puts in the transcript folder, or with **Library only** on the overlay; start MeetScribe again (or **Open MeetScribe** in the library) to bring the overlay back. A green dot in the library shows the server is answering.

### Fixed

- The WAV header repair before a final pass only touches files in the layout the recorder writes; other WAVs were corrupted by it.
- Settings opens under the banner instead of covering it, and the transcript and settings panels no longer show at the same time.
- Picking a profile no longer empties the glossary; a profile only changes it once it has one of its own.
- Starting a meeting with the live transcript off now warns when no final pass can run, instead of silently keeping only the audio.
- Pressing Enter in a library dialog (new folder, rename, tag) cancelled it instead of confirming.
- The collapse arrows in Settings showed as "B8" / "BE".

## [1.4.0] - 2026-10-23

### Added
- Settings → Final pass → **Models on this PC**: every Whisper model with its download status and size, Download and Delete buttons, and which one is in use. Dropdowns mark downloaded models with ✓ (#61).
- German final-pass models: German turbo (`cstr/whisper-large-v3-turbo-german-int8_float32`) and German large-v3 (`tnfru/whisper-large-v3-german-ct2`) (#61).
- Estimated final-pass time per 1-hour meeting for each model. It starts from a benchmark and learns from every pass: model speed per second of speech, plus how much speech your meetings contain (#61).

### Fixed
- The custom-model hint suggested a Transformers repo that faster-whisper cannot load (#61).

## [1.3.0] - 2026-10-23

### Added
- Final pass speed setting: **Fast** (default) decodes VAD-cut speech chunks in batches on one thread per physical core; **Quality** keeps the sequential, conditioned decode (#51).
- Final passes are queued instead of dropped when one is already running, shown as "n queued", run at below-normal priority, and resume after a restart (#48, #49).
- Logging of slow and failed transcriptions with queue wait, decode time and audio length, and of final-pass speed against meeting length (#53).

### Changed
- Final pass beam size defaults to 2 (was 5) and CPU threads to one per physical core (faster-whisper's own default is 4).
- The live pass no longer uses the glossary; the final pass uses only the first ~96 tokens of terms (#47).

### Fixed
- Final pass failing with "The maximum decoding length must be > 0" when a glossary was set (#44).
- Glossary terms written into transcripts where nobody said them (#47).
- Last utterances lost when recording stops while segments are still queued (#50).
- A wedged live Whisper worker is restarted after a timeout instead of stalling every following segment (#52).
- Quitting during a final pass is logged as cancelled, not as an unreadable-audio crash (#49).

## [1.2.0] - 2026-10-21

### Added
- Offline final pass: post-meeting re-transcription with `large-v3-turbo`, confidence marking, chapters and uncertainty index.
- Per-stream raw audio archive with FLAC transcoding.
- Corrections map: `corrections.json` (user data folder, plus a per-meeting copy) replaces known mishearings in the final transcript, marked as `{correct}`.
- Repo foundation: contributor docs, issue/PR templates, CI, shared Claude Code workflow.
- `npm run deploy`: builds the installer and installs it silently over the per-user install, keeping one `MeetScribe.lnk` Start Menu shortcut.
- Auto-update from GitHub Releases for installed builds (Settings toggle, on by default). Release workflow now publishes `latest.yml` and blockmaps.
- New app icon (signal dot) for the executable, installer and windows (#18).

### Changed
- License metadata unified to Apache-2.0; repository links point to this repo.

## [1.1.1]

### Changed
- Local faster-whisper pipeline hardening; version bump.

## [1.0.0]

### Added
- Initial MeetScribe release: live dual-stream transcription overlay, stealth windows, local Whisper setup from Settings.
