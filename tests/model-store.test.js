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
