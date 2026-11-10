const test = require('node:test');
const assert = require('node:assert/strict');

const { downloadCommand } = require('../src/services/model-store.service');

test('convert models run the converter with a private Hugging Face cache', () => {
  const paths = { modelDir: 'models', convertScript: 'convert_ct2.py', env: { PATH: 'x' } };

  const plain = downloadCommand({ repo: 'Acme/whisper-small', dir: 'd', convert: false, scratch: 's', paths });
  assert.equal(plain.args[0], '-c');
  assert.deepEqual(plain.args.slice(-2), ['Acme/whisper-small', 'models']);
  assert.equal(plain.env, paths.env);

  const converted = downloadCommand({ repo: 'Acme/whisper-large', dir: 'out', convert: true, scratch: 's', paths });
  assert.deepEqual(converted.args, ['-u', 'convert_ct2.py', 'Acme/whisper-large', 'out']);
  assert.equal(converted.env.HF_HUB_CACHE, 's');
  assert.equal(converted.env.PATH, 'x');
});

test('Hugging Face results keep only Whisper models faster-whisper can load or convert', () => {
  const { hubResults } = require('../src/services/model-store.service');
  const rows = hubResults([
    { id: 'Acme/whisper-small-acme-ct2', downloads: 5, tags: ['whisper', 'de'], siblings: [{ rfilename: 'model.bin' }, { rfilename: 'config.json' }] },
    { id: 'Acme/whisper-large-v3-acme', downloads: 9, tags: ['whisper', 'transformers'], siblings: [{ rfilename: 'model.safetensors' }] },
    { id: 'Acme/whisper-small-acme-onnx', tags: ['whisper', 'onnx'], siblings: [{ rfilename: 'onnx/encoder.onnx' }] },
    { id: 'Acme/wav2vec-acme', tags: ['wav2vec2'], siblings: [{ rfilename: 'model.safetensors' }] },
    { id: '../escape', tags: ['whisper'], siblings: [{ rfilename: 'model.bin' }] }
  ]);
  assert.deepEqual(rows.map((row) => [row.repo, row.format, row.category]), [
    ['Acme/whisper-small-acme-ct2', 'ct2', 'live'],
    ['Acme/whisper-large-v3-acme', 'transformers', 'final']
  ]);
  assert.deepEqual(rows[0].languages, ['de']);
});

test('the catalog has only the two lists: live and final pass', () => {
  const { CATALOG } = require('../src/services/model-store.service');
  for (const entry of CATALOG) assert.ok(['live', 'final'].includes(entry.category), entry.id);
});
