const test = require('node:test');
const assert = require('node:assert/strict');

const http = require('../src/core/manager-http');

const port = 51234;
const token = 'a'.repeat(48);
const cookie = `${http.COOKIE_NAME}=${token}`;

test('requests need the loopback Host header', () => {
  const ok = http.checkRequest({ method: 'GET', host: `127.0.0.1:${port}`, cookieHeader: cookie }, { port, token });
  assert.equal(ok.ok, true);
  for (const host of [`evil.example:${port}`, '127.0.0.1:1', undefined]) {
    const refused = http.checkRequest({ method: 'GET', host, cookieHeader: cookie }, { port, token });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'host');
  }
});

test('the token in the URL is swapped for a cookie, and nothing works without either', () => {
  const host = `localhost:${port}`;
  assert.deepEqual(http.checkRequest({ method: 'GET', host, queryToken: token }, { port, token }), { ok: true, setCookie: true });
  assert.equal(http.checkRequest({ method: 'GET', host }, { port, token }).reason, 'token');
  assert.equal(http.checkRequest({ method: 'GET', host, queryToken: 'b'.repeat(48) }, { port, token }).reason, 'token');
  assert.equal(http.checkRequest({ method: 'GET', host, cookieHeader: `${http.COOKIE_NAME}=wrong` }, { port, token }).reason, 'token');
  assert.match(http.sessionCookie(token), /HttpOnly; SameSite=Strict/);
});

test('changes need our own Origin even with a valid cookie', () => {
  const host = `127.0.0.1:${port}`;
  assert.equal(http.checkRequest({ method: 'POST', host, cookieHeader: cookie }, { port, token }).reason, 'origin');
  assert.equal(http.checkRequest({ method: 'POST', host, origin: 'https://evil.example', cookieHeader: cookie }, { port, token }).reason, 'origin');
  assert.equal(http.checkRequest({ method: 'POST', host, origin: `http://127.0.0.1:${port}`, cookieHeader: cookie }, { port, token }).ok, true);
  // A URL token never authorises a change.
  assert.equal(http.checkRequest({ method: 'POST', host, origin: `http://127.0.0.1:${port}`, queryToken: token }, { port, token }).ok, false);
});

test('the phone server checks its LAN host, an https Origin and its own cookie', () => {
  const lan = { port, token, hosts: ['192.168.1.20'], scheme: 'https', cookieName: 'phone' };
  const host = `192.168.1.20:${port}`;
  const phoneCookie = `phone=${token}`;
  assert.equal(http.checkRequest({ method: 'GET', host, cookieHeader: phoneCookie }, lan).ok, true);
  // Loopback names and other addresses are not ours here (DNS rebinding).
  assert.equal(http.checkRequest({ method: 'GET', host: `127.0.0.1:${port}`, cookieHeader: phoneCookie }, lan).reason, 'host');
  assert.equal(http.checkRequest({ method: 'GET', host: `192.168.1.21:${port}`, cookieHeader: phoneCookie }, lan).reason, 'host');
  // The manager's cookie does not open the phone server.
  assert.equal(http.checkRequest({ method: 'GET', host, cookieHeader: cookie }, lan).reason, 'token');
  assert.deepEqual(http.checkRequest({ method: 'GET', host, queryToken: token }, lan), { ok: true, setCookie: true });
  // Changes need the https Origin.
  assert.equal(http.checkRequest({ method: 'POST', host, origin: `http://${host}`, cookieHeader: phoneCookie }, lan).reason, 'origin');
  assert.equal(http.checkRequest({ method: 'POST', host, origin: `https://${host}`, cookieHeader: phoneCookie }, lan).ok, true);
  assert.match(http.sessionCookie(token, { cookieName: 'phone', secure: true }), /^phone=a+; HttpOnly; Secure; SameSite=Strict; Path=\/$/);
  // Opened from the camera app (a cross-site navigation): Lax, or the cookie
  // set on the first redirect is not sent on the next request.
  assert.match(http.sessionCookie(token, { cookieName: 'phone', secure: true, sameSite: 'Lax' }), /; Secure; SameSite=Lax; Path=\/$/);
  assert.match(http.sessionCookie(token), /SameSite=Strict/);
  assert.doesNotMatch(http.sessionCookie(token), /Secure/);
});

test('byte ranges are parsed for seeking', () => {
  assert.equal(http.parseRange(undefined, 100), null);
  assert.deepEqual(http.parseRange('bytes=0-9', 100), { start: 0, end: 9 });
  assert.deepEqual(http.parseRange('bytes=90-', 100), { start: 90, end: 99 });
  assert.deepEqual(http.parseRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.deepEqual(http.parseRange('bytes=50-500', 100), { start: 50, end: 99 });
  for (const bad of ['bytes=100-', 'bytes=9-1', 'bytes=-', 'items=0-1', 'bytes=0-1,5-6', 'bytes=-0']) {
    assert.equal(http.parseRange(bad, 100), 'invalid', bad);
  }
});

test('only known media types are served', () => {
  assert.equal(http.mediaType('.FLAC'), 'audio/flac');
  assert.equal(http.mediaType('.png'), 'image/png');
  assert.equal(http.mediaType('.json'), null);
  assert.equal(http.mediaType('.txt'), null);
});
