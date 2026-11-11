/**
 * Pure request checks for the manager's local HTTP server. No sockets here, so
 * the security rules are unit-tested on their own (tests/manager-http.test.js).
 *
 * The server listens on 127.0.0.1 only, but any web page the user has open can
 * still send requests to it. Three rules keep those out:
 *   - a per-start secret, handed over once in the URL and kept in an HttpOnly,
 *     SameSite=Strict cookie, is required on every request;
 *   - the Host header must name the loopback address, which defeats DNS
 *     rebinding (a hostile domain that resolves to 127.0.0.1);
 *   - requests that change anything must also carry our own Origin.
 */

const crypto = require('crypto');

const COOKIE_NAME = 'meetscribe_manager';

function newToken() {
  return crypto.randomBytes(24).toString('hex');
}

function sameSecret(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length > 0 && left.length === right.length && crypto.timingSafeEqual(left, right);
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    try {
      out[key] = decodeURIComponent(value);
    } catch (_) {
      out[key] = value;
    }
  }
  return out;
}

const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost'];

/** `hosts` are bare names or addresses; the port is added here. */
function hostAllowed(host, port, hosts = LOOPBACK_HOSTS) {
  return hosts.some((name) => host === `${name}:${port}`);
}

function originAllowed(origin, port, hosts = LOOPBACK_HOSTS, scheme = 'http') {
  return hosts.some((name) => origin === `${scheme}://${name}:${port}`);
}

/**
 * Decide what to do with a request.
 *
 * The defaults are the manager's (loopback, http, its own cookie). The phone
 * server passes its LAN addresses, `scheme: 'https'` and its own cookie name.
 * @returns {{ ok: true }|{ ok: false, status: number, reason: string }|{ ok: true, setCookie: true }}
 */
function checkRequest({ method, host, origin, cookieHeader, queryToken }, { port, token, hosts, scheme, cookieName = COOKIE_NAME }) {
  if (!hostAllowed(host, port, hosts)) return { ok: false, status: 403, reason: 'host' };
  const mutating = !['GET', 'HEAD'].includes(String(method || 'GET').toUpperCase());
  if (mutating && !originAllowed(origin, port, hosts, scheme)) return { ok: false, status: 403, reason: 'origin' };
  if (sameSecret(parseCookies(cookieHeader)[cookieName], token)) return { ok: true };
  if (!mutating && queryToken && sameSecret(queryToken, token)) return { ok: true, setCookie: true };
  return { ok: false, status: 403, reason: 'token' };
}

function sessionCookie(token, { cookieName = COOKIE_NAME, secure = false } = {}) {
  return `${cookieName}=${encodeURIComponent(token)}; HttpOnly;${secure ? ' Secure;' : ''} SameSite=Strict; Path=/`;
}

/**
 * Parse a single-range "Range: bytes=a-b" header against a file size.
 * @returns {{ start: number, end: number }|null|'invalid'}  null = no range (send it all)
 */
function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match || (match[1] === '' && match[2] === '')) return 'invalid';
  let start;
  let end;
  if (match[1] === '') {
    const suffix = Number(match[2]);
    if (suffix === 0) return 'invalid';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (start >= size || start > end) return 'invalid';
  return { start, end };
}

const MEDIA_TYPES = {
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.webm': 'audio/webm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg'
};

function mediaType(extension) {
  return MEDIA_TYPES[String(extension || '').toLowerCase()] || null;
}

module.exports = {
  COOKIE_NAME,
  newToken,
  sameSecret,
  parseCookies,
  hostAllowed,
  originAllowed,
  checkRequest,
  sessionCookie,
  parseRange,
  mediaType
};
