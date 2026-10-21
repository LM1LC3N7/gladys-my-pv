// src/mypv/http.js against a plain HTTP server on the loopback (never the network).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { ERROR_KINDS, isUnicastIPv4, notSent, request } from '../src/mypv/http.js';
import { selfSigned } from './fixtures/selfSigned.js';

async function serve(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return server.address().port;
}

test('an answer: status, headers and body; no redirect followed', async (t) => {
  const port = await serve(t, (req, res) => {
    if (req.url === '/moved') {
      res.writeHead(302, { location: 'https://127.0.0.1/' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ method: req.method, url: req.url }));
  });
  const ok = await request({
    protocol: 'http',
    host: '127.0.0.1',
    port,
    path: '/data.jsn',
    timeoutMs: 2000,
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(JSON.parse(ok.body), { method: 'GET', url: '/data.jsn' });
  const moved = await request({
    protocol: 'http',
    host: '127.0.0.1',
    port,
    path: '/moved',
    timeoutMs: 2000,
  });
  assert.equal(moved.status, 302);
});

test('an answer too large is refused', async (t) => {
  const port = await serve(t, (_req, res) => {
    res.writeHead(200);
    res.end('x'.repeat(70 * 1024));
  });
  await assert.rejects(
    request({ protocol: 'http', host: '127.0.0.1', port, path: '/', timeoutMs: 2000 }),
    (e) => e.kind === ERROR_KINDS.PROTOCOL,
  );
});

test('connected then silent: a timeout (may have been received); nothing listening: unreachable', async (t) => {
  const port = await serve(t, () => {});
  await assert.rejects(
    request({ protocol: 'http', host: '127.0.0.1', port, path: '/', timeoutMs: 300 }),
    (e) => e.kind === ERROR_KINDS.TIMEOUT && !notSent(e),
  );
  // A port that was just closed: the connection is refused.
  const spare = http.createServer();
  await new Promise((resolve) => spare.listen(0, '127.0.0.1', resolve));
  const closed = spare.address().port;
  await new Promise((resolve) => spare.close(resolve));
  await assert.rejects(
    request({ protocol: 'http', host: '127.0.0.1', port: closed, path: '/', timeoutMs: 1000 }),
    (e) => e.kind === ERROR_KINDS.UNREACHABLE && notSent(e),
  );
});

test('unicast addresses only for host names', () => {
  assert.ok(isUnicastIPv4('192.168.1.80'));
  for (const bad of [
    '127.0.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '192.168.1.255',
    'x',
  ]) {
    assert.ok(!isUnicastIPv4(bad), bad);
  }
});

// --- TLS on the loopback (a certificate made in JS): the pinned path ------------------

const login = (port, trust) =>
  request({
    protocol: 'https',
    host: '127.0.0.1',
    port,
    path: '/auth.jsn',
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'pw=secret',
    timeoutMs: 3000,
    trust,
  });

const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

test('pinned TLS: the request goes through the checked TLS socket only, never in clear', async (t) => {
  const a = selfSigned('device-a', 1);
  const bodies = [];
  const plain = [];
  const server = https.createServer({ key: a.key, cert: a.cert }, (req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      bodies.push(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"auth":1}');
    });
  });
  server.on('tlsClientError', (e) => plain.push(e.code));
  const port = await listen(server);
  t.after(() => server.close());
  const pins = [];
  const first = await login(port, { pin: undefined, onPin: (fp) => pins.push(fp) });
  assert.equal(first.status, 200);
  assert.deepEqual(pins, [a.fingerprint], 'pinned on first use');
  const again = await login(port, { pin: a.fingerprint, onPin: () => pins.push('x') });
  assert.equal(again.status, 200);
  assert.deepEqual(bodies, ['pw=secret', 'pw=secret']);
  assert.deepEqual(plain, [], 'nothing reached the TLS port in clear text');
  assert.equal(pins.length, 1);
});

test('pinned TLS: another certificate, or a self-signed one for the cloud: nothing written', async (t) => {
  const a = selfSigned('device-a', 1);
  const b = selfSigned('device-b', 2);
  let bytes = 0;
  const server = tls.createServer({ key: b.key, cert: b.cert }, (socket) => {
    socket.on('data', (c) => (bytes += c.length));
    socket.on('error', () => {});
  });
  const plain = [];
  server.on('tlsClientError', (e) => plain.push(e.code));
  const port = await listen(server);
  t.after(() => server.close());
  await assert.rejects(login(port, { pin: a.fingerprint, onPin: () => {} }), (e) => {
    assert.equal(e.kind, ERROR_KINDS.TLS_CHANGED);
    assert.ok(notSent(e));
    return true;
  });
  await assert.rejects(login(port, 'verify'), (e) => {
    assert.equal(e.kind, ERROR_KINDS.TLS_UNTRUSTED);
    assert.ok(notSent(e));
    return true;
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(bytes, 0, 'bytes reached the other certificate');
  assert.deepEqual(
    plain.filter((c) => c === 'ERR_SSL_HTTP_REQUEST'),
    [],
  );
});
