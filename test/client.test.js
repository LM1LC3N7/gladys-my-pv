// The clients of src/mypv/client.js against a recorded transport (no network).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CloudClient, LocalClient, retryAfterOf } from '../src/mypv/client.js';
import { ERROR_KINDS } from '../src/mypv/http.js';

const reply = (status, body = {}, headers = {}) => ({
  status,
  headers,
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

/** A transport answering from a list, recording the requests. */
function scripted(answers) {
  const requests = [];
  const transport = async (options) => {
    requests.push(options);
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next(options) : next;
  };
  return { requests, transport };
}

test('local HTTP: identification, settings and measures; a redirect to HTTPS asks for a password', async () => {
  const { requests, transport } = scripted([
    reply(200, { sn: '2001001234567890', fwversion: 'a1', device: 'AC-THOR' }),
    reply(200, { devmode: 1 }),
    reply(302, '', { location: 'https://192.168.1.80/data.jsn' }),
  ]);
  const client = new LocalClient({ address: { host: '192.168.1.80' }, transport });
  assert.deepEqual(await client.identify({ timeoutMs: 1000 }), {
    serial: '2001001234567890',
    firmware: 'a1',
    name: 'AC-THOR',
  });
  assert.deepEqual(await client.readSetup({ timeoutMs: 1000 }), { devmode: 1 });
  await assert.rejects(
    client.readData({ timeoutMs: 1000 }),
    (e) => e.kind === ERROR_KINDS.NEEDS_PASSWORD,
  );
  assert.deepEqual(
    requests.map((r) => [r.protocol, r.port, r.path]),
    [
      ['http', 80, '/mypv_dev.jsn'],
      ['http', 80, '/setup.jsn'],
      ['http', 80, '/data.jsn'],
    ],
  );
});

test('local HTTPS: one login, its cookie, one new login on a 401, never a third try', async () => {
  const pins = [];
  const { requests, transport } = scripted([
    reply(200, { auth: 1 }, { 'set-cookie': ['sid=abc; Path=/; HttpOnly'] }),
    reply(200, { devmode: 1 }),
    reply(401, { msg: 'expired' }),
    reply(200, { auth: 1 }, { 'set-cookie': 'sid=def' }),
    reply(200, { devmode: 0 }),
    reply(401, {}),
    reply(200, { auth: 1 }),
    reply(401, {}),
  ]);
  const client = new LocalClient({
    address: { host: '192.168.1.80' },
    password: 'a b&c',
    transport,
    pin: { get: () => pins.at(-1), set: (fp) => pins.push(fp) },
  });
  await client.readSetup({ timeoutMs: 1000 });
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].body, 'pw=a%20b%26c');
  assert.equal(requests[0].protocol, 'https');
  assert.equal(requests[0].port, 443);
  assert.equal(typeof requests[0].trust.onPin, 'function', 'trust on first use');
  assert.equal(requests[1].headers.Cookie, 'sid=abc');
  assert.deepEqual(await client.readSetup({ timeoutMs: 1000 }), { devmode: 0 });
  assert.equal(requests[4].headers.Cookie, 'sid=def');
  await assert.rejects(client.readSetup({ timeoutMs: 1000 }), (e) => e.kind === ERROR_KINDS.AUTH);
  assert.equal(requests.length, 8);
});

test('a refused password: an auth error, the password nowhere in it', async () => {
  const { transport } = scripted([reply(200, { auth: 0 })]);
  const client = new LocalClient({ address: { host: 'h' }, password: 'secret-pw', transport });
  await assert.rejects(client.readData({ timeoutMs: 1000 }), (e) => {
    assert.equal(e.kind, ERROR_KINDS.AUTH);
    assert.ok(!JSON.stringify({ ...e, message: e.message }).includes('secret-pw'));
    return true;
  });
});

test('a write: tried again only on 429, never after its deadline, never on another answer', async () => {
  let now = 0;
  const sleep = async (ms) => {
    now += ms;
  };
  const { requests, transport } = scripted([
    reply(429, 'busy'),
    reply(429, 'busy'),
    reply(200, { ww1target: 520 }),
    reply(500, 'x'),
  ]);
  const client = new LocalClient({ address: { host: 'h' }, transport, now: () => now, sleep });
  const result = await client.write('ww1target', 520, { startBy: 3500, answerBy: 4300 });
  assert.equal(result.echo.ww1target, 520);
  assert.equal(requests.length, 3);
  assert.equal(requests[0].path, '/setup.jsn?ww1target=520');
  await assert.rejects(
    client.write('bststrt', 0, { startBy: 3500, answerBy: 4300 }),
    (e) => e.kind === ERROR_KINDS.SERVER,
  );
  assert.equal(requests.length, 4, 'a 5xx is never sent again');
  now = 5000;
  await assert.rejects(
    client.write('bststrt', 0, { startBy: 3500, answerBy: 4300 }),
    (e) => e.kind === ERROR_KINDS.LATE,
  );
  assert.equal(requests.length, 4);
});

test('one try only when asked (during a pause)', async () => {
  const { requests, transport } = scripted([reply(429, 'busy')]);
  const client = new LocalClient({
    address: { host: 'h' },
    transport,
    now: () => 0,
    sleep: async () => {},
  });
  await assert.rejects(
    client.write('bststrt', 0, { startBy: 3500, answerBy: 4300, retryBusy: false }),
    (e) => e.kind === ERROR_KINDS.RATE_LIMITED,
  );
  assert.equal(requests.length, 1);
});

test('the last check runs right before the write leaves, after the login', async () => {
  const { requests, transport } = scripted([reply(200, { auth: 1 })]);
  const client = new LocalClient({
    address: { host: 'h' },
    password: 'p',
    transport,
    now: () => 0,
  });
  await assert.rejects(
    client.write('ww1target', 500, {
      startBy: 3500,
      answerBy: 4300,
      beforeSend: () => {
        throw new Error('option off');
      },
    }),
    (e) => e.beforeSend === true && e.message === 'option off',
  );
  assert.deepEqual(
    requests.map((r) => r.path),
    ['/auth.jsn'],
  );
});

test('the cloud: bearer token, verified certificate, soc merged, "ok" for a write', async () => {
  const { requests, transport } = scripted([
    reply(200, { isOnline: true }),
    reply(200, { Temp1: 450 }),
    reply(200, { percentage: 80 }),
    reply(200, '"ok"'),
    reply(200, '"nope"'),
    reply(200, { isOnline: false }),
  ]);
  const client = new CloudClient({
    serial: '2001001234567890',
    token: 'tok',
    transport,
    now: () => 0,
  });
  await client.identify({ timeoutMs: 1000 });
  const data = await client.readData({ timeoutMs: 1000 });
  assert.equal(data.temp1, 450);
  assert.equal(data.soc, 80);
  await client.write('ww1target', 480, { startBy: 3500, answerBy: 4300 });
  assert.equal(requests[3].method, 'PUT');
  assert.equal(requests[3].body, '{"ww1target":480}');
  await assert.rejects(
    client.write('ww1target', 480, { startBy: 3500, answerBy: 4300 }),
    (e) => e.kind === ERROR_KINDS.UNCONFIRMED,
  );
  await assert.rejects(client.identify({ timeoutMs: 1000 }), (e) => e.kind === ERROR_KINDS.OFFLINE);
  for (const r of requests) {
    assert.equal(r.headers.Authorization, 'Bearer tok');
    assert.equal(r.trust, 'verify');
    assert.equal(r.host, 'api.my-pv.com');
  }
});

test('the charge of the tank is secondary: its failure never blocks the measures', async () => {
  const { transport } = scripted([reply(200, { temp1: 450 }), reply(503, 'x')]);
  const client = new CloudClient({
    serial: '2001001234567890',
    token: 'tok',
    transport,
    now: () => 0,
  });
  const data = await client.readData({ timeoutMs: 1000 });
  assert.equal(data.temp1, 450);
  assert.equal(data.soc, undefined);
});

test('Retry-After: seconds or a date', () => {
  assert.equal(retryAfterOf('120'), 120_000);
  assert.equal(retryAfterOf(new Date(10_000).toUTCString(), 4_000), 6_000);
  assert.equal(retryAfterOf('soon'), undefined);
  assert.equal(retryAfterOf(undefined), undefined);
});
