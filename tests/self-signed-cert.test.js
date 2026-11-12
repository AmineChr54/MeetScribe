const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const selfSigned = require('../src/core/self-signed-cert');

const DAY = 24 * 60 * 60 * 1000;
const now = Date.UTC(2026, 0, 15, 12, 0, 0);
const { key, cert } = selfSigned.generate({ ips: ['192.168.1.20', '10.0.0.5'], now });
const x509 = new crypto.X509Certificate(cert);

test('the certificate parses and is signed by its own key', () => {
  assert.equal(x509.verify(crypto.createPublicKey(key)), true);
  assert.equal(x509.checkPrivateKey(crypto.createPrivateKey(key)), true);
  assert.equal(x509.ca, false);
  assert.match(x509.subject, /CN=MeetScribe phone recorder/);
  assert.equal(x509.subject, x509.issuer);
});

test('it names each LAN address and is meant for a TLS server', () => {
  assert.equal(x509.checkIP('192.168.1.20'), '192.168.1.20');
  assert.equal(x509.checkIP('10.0.0.5'), '10.0.0.5');
  assert.equal(x509.checkIP('192.168.1.21'), undefined);
  assert.match(x509.subjectAltName, /IP Address:192\.168\.1\.20/);
  assert.deepEqual(x509.keyUsage, ['1.3.6.1.5.5.7.3.1']);
});

test('validity stays under the 398 days iOS accepts and allows for a slow clock', () => {
  const from = Date.parse(x509.validFrom);
  const to = Date.parse(x509.validTo);
  assert.ok(from <= now - DAY + 1000 && from >= now - DAY - 1000);
  assert.ok(to - from < 398 * DAY);
});

test('a stored certificate is reused only while it fits', () => {
  assert.equal(selfSigned.stillGood(cert, ['192.168.1.20'], now), true);
  assert.equal(selfSigned.stillGood(cert, ['192.168.1.20', '10.0.0.5'], now), true);
  // The network changed: the phone would see a name mismatch.
  assert.equal(selfSigned.stillGood(cert, ['192.168.2.7'], now), false);
  // Close to expiry, or already expired.
  assert.equal(selfSigned.stillGood(cert, ['10.0.0.5'], now + 390 * DAY), false);
  assert.equal(selfSigned.stillGood('not a certificate', ['10.0.0.5'], now), false);
});

test('the addresses of a stored certificate can be read back', () => {
  assert.deepEqual(selfSigned.addressesOf(cert), ['192.168.1.20', '10.0.0.5']);
  assert.deepEqual(selfSigned.addressesOf('garbage'), []);
});

test('each certificate gets its own name (Firefox keeps exceptions per name)', () => {
  const other = new crypto.X509Certificate(selfSigned.generate({ ips: ['192.168.1.20'], now }).cert);
  assert.notEqual(other.subject, x509.subject);
});

test('an address is required and must be IPv4', () => {
  assert.throws(() => selfSigned.generate({ ips: [] }));
  assert.throws(() => selfSigned.generate({ ips: ['fe80::1'] }));
});
