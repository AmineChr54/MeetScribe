/**
 * A self-signed TLS certificate for the phone recorder, built with Node's own
 * crypto (no dependency). Phones only allow the microphone on https pages, and
 * a LAN address cannot get a real certificate, so the phone shows a warning
 * once and then trusts this one.
 *
 * Shaped for what iOS requires even of a certificate the user accepted by
 * hand: subjectAltName with the IP address, extKeyUsage serverAuth, and a
 * validity under 398 days. EC P-256 key, ecdsa-with-SHA256 signature.
 *
 * Pure apart from key generation; tests/self-signed-cert.test.js parses the
 * result with crypto.X509Certificate.
 */

const crypto = require('crypto');

const VALID_DAYS = 397;
const DAY_MS = 24 * 60 * 60 * 1000;
// Renew a little early so a phone never meets an expired certificate.
const RENEW_BEFORE_MS = 14 * DAY_MS;
const COMMON_NAME = 'MeetScribe phone recorder';

// ── DER ──

function length(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  for (let rest = n; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag, ...parts) {
  const body = Buffer.concat(parts.map((part) => (Buffer.isBuffer(part) ? part : Buffer.from(part))));
  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
}

const seq = (...parts) => tlv(0x30, ...parts);
const set = (...parts) => tlv(0x31, ...parts);

function oid(dotted) {
  const [a, b, ...rest] = dotted.split('.').map(Number);
  const bytes = [40 * a + b];
  for (const value of rest) {
    const chunk = [value & 0x7f];
    for (let v = Math.floor(value / 128); v > 0; v = Math.floor(v / 128)) chunk.unshift(0x80 | (v & 0x7f));
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

/** A non-negative INTEGER from big-endian bytes. */
function integer(bytes) {
  let body = Buffer.from(bytes);
  while (body.length > 1 && body[0] === 0 && !(body[1] & 0x80)) body = body.subarray(1);
  if (body[0] & 0x80) body = Buffer.concat([Buffer.from([0]), body]);
  return tlv(0x02, body);
}

function time(ms) {
  const iso = new Date(ms).toISOString(); // YYYY-MM-DDTHH:MM:SS.sssZ
  const digits = iso.slice(0, 19).replace(/[-T:]/g, '');
  // UTCTime up to 2049, GeneralizedTime after (RFC 5280 4.1.2.5).
  return new Date(ms).getUTCFullYear() < 2050
    ? tlv(0x17, Buffer.from(digits.slice(2) + 'Z', 'ascii'))
    : tlv(0x18, Buffer.from(digits + 'Z', 'ascii'));
}

function ipBytes(address) {
  const parts = String(address).split('.').map(Number);
  if (parts.length !== 4 || !parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    throw new Error(`Not an IPv4 address: ${address}`);
  }
  return Buffer.from(parts);
}

function extension(id, critical, value) {
  return seq(oid(id), ...(critical ? [tlv(0x01, Buffer.from([0xff]))] : []), tlv(0x04, value));
}

const ECDSA_SHA256 = '1.2.840.10045.4.3.2';

/**
 * @param {{ ips: string[], now?: number }} options
 * @returns {{ key: string, cert: string }} PEM strings
 */
function generate({ ips, now = Date.now() }) {
  const addresses = [...new Set(ips || [])];
  if (!addresses.length) throw new Error('A certificate needs at least one address');
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });

  const serial = crypto.randomBytes(16);
  serial[0] = (serial[0] & 0x7f) | 0x01; // positive and not zero
  // A new name for each certificate: Firefox refuses a new key under a name
  // it already holds an exception for.
  const commonName = `${COMMON_NAME} ${crypto.randomBytes(4).toString('hex')}`;
  const name = seq(set(seq(oid('2.5.4.3'), tlv(0x0c, Buffer.from(commonName, 'utf8')))));
  // A day of slack for a phone whose clock runs behind.
  const notBefore = now - DAY_MS;
  const notAfter = notBefore + VALID_DAYS * DAY_MS;

  const extensions = [
    extension('2.5.29.19', true, seq()), // basicConstraints: not a CA
    extension('2.5.29.15', true, tlv(0x03, Buffer.from([0x07, 0x80]))), // keyUsage: digitalSignature
    extension('2.5.29.37', false, seq(oid('1.3.6.1.5.5.7.3.1'))), // extKeyUsage: serverAuth
    extension('2.5.29.17', false, seq(...addresses.map((ip) => tlv(0x87, ipBytes(ip))))) // subjectAltName
  ];

  const tbs = seq(
    tlv(0xa0, integer([2])), // v3
    integer(serial),
    seq(oid(ECDSA_SHA256)),
    name,
    seq(time(notBefore), time(notAfter)),
    name,
    spki,
    tlv(0xa3, seq(...extensions))
  );
  const signature = crypto.sign('sha256', tbs, privateKey); // DER-encoded ECDSA
  const der = seq(tbs, seq(oid(ECDSA_SHA256)), tlv(0x03, Buffer.from([0]), signature));

  const base64 = der.toString('base64').match(/.{1,64}/g).join('\n');
  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    cert: `-----BEGIN CERTIFICATE-----\n${base64}\n-----END CERTIFICATE-----\n`
  };
}

/** The IPv4 addresses a certificate names. */
function addressesOf(certPem) {
  try {
    const san = new crypto.X509Certificate(certPem).subjectAltName || '';
    return [...san.matchAll(/IP Address:(\d{1,3}(?:\.\d{1,3}){3})/g)].map((match) => match[1]);
  } catch (_) {
    return [];
  }
}

/** Whether a stored certificate still covers these addresses for a while. */
function stillGood(certPem, ips, now = Date.now()) {
  try {
    const cert = new crypto.X509Certificate(certPem);
    if (Date.parse(cert.validTo) - RENEW_BEFORE_MS <= now) return false;
    if (Date.parse(cert.validFrom) > now) return false;
    return (ips || []).every((ip) => cert.checkIP(ip) !== undefined);
  } catch (_) {
    return false;
  }
}

module.exports = { generate, stillGood, addressesOf, VALID_DAYS };
