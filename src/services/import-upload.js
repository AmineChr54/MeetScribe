const fs = require('fs');
const libraryEdit = require('./library-edit.service');

const MAX_IMPORT_BYTES = 4 * 1024 * 1024 * 1024;

/**
 * Stream an uploaded recording straight to disk as a new meeting. Shared by
 * the manager's Import and the phone recorder; the caller sends the reply.
 *
 * @param {import('http').IncomingMessage} req  body = the audio file
 * @param {{ name, startedAt, durationMs, folder, label, ext }} fields
 * @param {{ onProgress?: (bytes: number, size: number) => void }} [options]
 * @returns {Promise<{ status: number, body: object, dir?: string }>}
 */
async function receiveImport(req, fields, { onProgress } = {}) {
  const size = Number(req.headers['content-length']);
  if (!Number.isFinite(size) || size <= 0) {
    req.resume();
    return { status: 411, body: { ok: false, error: 'Empty upload' } };
  }
  if (size > MAX_IMPORT_BYTES) {
    req.resume();
    return { status: 413, body: { ok: false, error: 'The file is larger than 4 GB' } };
  }

  let target;
  try {
    target = libraryEdit.beginImport({ name: fields.name, startedAt: fields.startedAt, folder: fields.folder, ext: fields.ext });
  } catch (error) {
    req.resume();
    return { status: 400, body: { ok: false, error: error.message } };
  }

  const written = await new Promise((resolve) => {
    // flush: fsync before the file is closed. The answer waits for 'close', so
    // a phone that deletes its copy on "ok" never relies on an unsynced file.
    const out = fs.createWriteStream(target.file, { flush: true });
    let bytes = 0;
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const fail = (error) => {
      settle({ ok: false, error: error.message || String(error) });
      out.destroy();
    };
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > size) req.destroy(new Error('More data than announced'));
      else if (onProgress) onProgress(bytes, size);
    });
    req.on('aborted', () => fail(new Error('The upload was interrupted')));
    req.on('error', fail);
    out.on('error', fail);
    out.on('close', () => settle(bytes === size ? { ok: true } : { ok: false, error: 'The upload was incomplete' }));
    req.pipe(out);
  });
  if (!written.ok) {
    libraryEdit.failImport(target.dir);
    return { status: 400, body: written };
  }

  try {
    const result = libraryEdit.finishImport({
      dir: target.dir,
      file: target.file,
      name: fields.name,
      startedAt: fields.startedAt,
      durationMs: fields.durationMs,
      label: fields.label
    });
    return { status: 200, body: { ok: true, ...result }, dir: target.dir };
  } catch (error) {
    libraryEdit.failImport(target.dir);
    return { status: 400, body: { ok: false, error: error.message } };
  }
}

module.exports = { receiveImport, MAX_IMPORT_BYTES };
