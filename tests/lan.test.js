const test = require('node:test');
const assert = require('node:assert/strict');

const lan = require('../src/core/lan');

const v4 = (address, internal = false) => ({ address, family: 'IPv4', internal });

test('Wi-Fi comes before Ethernet, and virtual adapters are left out', () => {
  const list = lan.candidates({
    'Loopback Pseudo-Interface 1': [v4('127.0.0.1', true)],
    'vEthernet (WSL)': [v4('172.20.0.1')],
    'VirtualBox Host-Only Network': [v4('192.168.56.1')],
    Ethernet: [v4('10.0.0.5')],
    'Wi-Fi': [{ address: 'fe80::1', family: 'IPv6', internal: false }, v4('192.168.1.20')]
  });
  assert.deepEqual(list, [
    { address: '192.168.1.20', name: 'Wi-Fi' },
    { address: '10.0.0.5', name: 'Ethernet' }
  ]);
});

test('link-local and public addresses: one dropped, the other kept last', () => {
  const list = lan.candidates({
    'Wi-Fi': [v4('169.254.10.10')],
    Ethernet: [v4('203.0.113.7')],
    eth1: [v4('172.16.4.2')]
  });
  assert.deepEqual(list.map((entry) => entry.address), ['172.16.4.2', '203.0.113.7']);
});

test('private ranges', () => {
  for (const address of ['10.1.2.3', '172.16.0.1', '172.31.255.1', '192.168.0.1']) assert.equal(lan.isPrivate(address), true, address);
  for (const address of ['172.15.0.1', '172.32.0.1', '192.169.0.1', '8.8.8.8', 'nonsense', '1.2.3']) assert.equal(lan.isPrivate(address), false, address);
});

test('no interfaces, no candidates', () => {
  assert.deepEqual(lan.candidates({}), []);
  assert.deepEqual(lan.candidates(null), []);
});
