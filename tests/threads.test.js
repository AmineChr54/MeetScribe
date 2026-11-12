const test = require('node:test');
const assert = require('node:assert/strict');

const { liveCpuThreads } = require('../src/core/threads');

test('live threads: half the cores, shared by workers, between 4 and 8', () => {
  assert.equal(liveCpuThreads(24), 8);
  assert.equal(liveCpuThreads(24, 2), 6);
  assert.equal(liveCpuThreads(12), 6);
  assert.equal(liveCpuThreads(8), 4);
  assert.equal(liveCpuThreads(4), 4);
  assert.equal(liveCpuThreads(64, 1), 8);
  assert.equal(liveCpuThreads(0), 4);
  assert.equal(liveCpuThreads(16, 0), 8);
});
