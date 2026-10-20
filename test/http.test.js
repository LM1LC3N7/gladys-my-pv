// src/mypv/http.js against a plain HTTP server on the loopback (never the network).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { ERROR_KINDS, isUnicastIPv4, notSent, request } from '../src/mypv/http.js';

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
