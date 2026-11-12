const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const qr = require('../src/core/qr');

test('Reed-Solomon codewords match the published "HELLO WORLD" 1-M example', () => {
  const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
  assert.deepEqual(qr.rsRemainder(data, 10), [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
});

test('format bits for level M and version bits match the specification tables', () => {
  const table = [
    '101010000010010', '101000100100101', '101111001111100', '101101101001011',
    '100010111111001', '100000011001110', '100111110010111', '100101010100000'
  ];
  table.forEach((bits, mask) => assert.equal(qr.formatBits(mask).toString(2).padStart(15, '0'), bits, `mask ${mask}`));
  assert.equal(qr.versionBits(7).toString(2).padStart(18, '0'), '000111110010010100');
});

test('the smallest version that fits is chosen, up to 213 bytes', () => {
  assert.equal(qr.pickVersion(14), 1);
  assert.equal(qr.pickVersion(15), 2);
  assert.equal(qr.pickVersion(84), 5);
  assert.equal(qr.pickVersion(85), 6);
  assert.equal(qr.pickVersion(213), 10);
  assert.throws(() => qr.pickVersion(214));
});

test('finder and timing patterns sit where scanners look for them', () => {
  const { size, modules } = qr.encode('https://192.168.1.20:51234/');
  const finder = ['1111111', '1000001', '1011101', '1011101', '1011101', '1000001', '1111111'];
  for (const [ox, oy] of [[0, 0], [size - 7, 0], [0, size - 7]]) {
    finder.forEach((row, y) => [...row].forEach((bit, x) => assert.equal(modules[oy + y][ox + x], bit === '1')));
  }
  for (let i = 8; i < size - 8; i++) {
    assert.equal(modules[6][i], i % 2 === 0);
    assert.equal(modules[i][6], i % 2 === 0);
  }
  assert.equal(modules[size - 8][8], true, 'the dark module');
});

test('a typical phone link encodes to the same matrix as a reference encoder', () => {
  // Fingerprint of a matrix checked module by module against an independent
  // QR library (byte mode, level M), so a change to the layout shows up here.
  const { version, mask, modules } = qr.encode('https://192.168.1.20:51234/?token=' + 'a'.repeat(48));
  assert.equal(version, 5);
  assert.equal(mask, 4);
  const rows = modules.map((row) => row.map((dark) => (dark ? 1 : 0)).join('')).join('\n');
  assert.equal(crypto.createHash('sha256').update(rows).digest('hex'), '207c0b3abab6af910c1e543f6559fde2516f7b66514c3dffa3bbef6515d743ea');
});

test('the SVG is dark on light with a quiet zone', () => {
  const svg = qr.toSvg('hi');
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 29 29"/);
  assert.match(svg, /<rect width="29" height="29" fill="#fff"\/>/);
  assert.match(svg, /<path d="M4 4h1v1h-1z/);
});
