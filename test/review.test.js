// -----------------------------------------------------------------------------
// The scenarios of the first review (hostile devices, restarts, deadlines),
// each asserting the expected behaviour. Same wiring as test/app.test.js.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { MyPvApp } from '../src/app.js';
import { ACTIONS, MINUTE, SECOND } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { memoryStore, normalizeMemory } from '../src/store.js';
import { ERROR_KINDS, MyPvError } from '../src/mypv/http.js';
import {
  HOST,
  NOW,
  PASSWORD,
  SERIAL,
  TOKEN,
  acThor,
  fakeMyPv,
  settle,
} from './fixtures/fakeMyPv.js';

const CONFIG = { host: HOST };
const DEVICE = `ext:test-integration:my-pv:${SERIAL}`;
const feature = (role) => `${DEVICE}:${role}`;
const CLOUD = { connection: 'cloud', serial_number: SERIAL, api_token: TOKEN };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const recorder = (logs) =>
  Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push(args.map(String).join(' ')),
    ]),
  );

async function setup(
  t,
  { config = CONFIG, server = fakeMyPv(), store = memoryStore(), transport } = {},
) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: NOW });
  const logs = [];
  const gladys = createFakeGladys({ config });
  const app = new MyPvApp({
    gladys,
    logger: recorder(logs),
    transport: transport ?? server.transport,
    now: () => Date.now(),
    store,
  });
  registerHandlers(gladys, app);
  await gladys.connect();
  await settle();
  t.after(() => app.stop());
  const advance = async (ms, step = SECOND) => {
    for (let elapsed = 0; elapsed < ms; elapsed += step) {
      t.mock.timers.tick(Math.min(step, ms - elapsed));
      await settle();
    }
  };
  if (gladys.fake.discoveredDevices.length > 0) {
    await gladys.fake.deviceCreated(gladys.fake.discoveredDevices.at(-1));
    await settle();
  }
  const send = (role, value = 1) => {
    const created = gladys.fake.devices.find((d) => d.external_id === DEVICE);
    const target = created.features.find((f) => f.external_id === feature(role));
    assert.ok(target, `no feature ${role}`);
    return gladys.fake.setValue(created, target, value);
  };
  const press = async (role, value = 1, ms = 5 * SECOND) => {
    const ack = send(role, value);
    await settle();
    await advance(ms, 100);
    return ack;
  };
  return { gladys, app, server, store, advance, logs, send, press };
}

const message = (gladys) => gladys.fake.connectionStatus?.message ?? {};
const reads = (server) => server.requests.filter((r) => r.method === 'GET').length;

/** A device that answers 429 to a request arriving while it handles another one (py-mypv). */
function busyDevice(server, holdMs = () => 0) {
  let active = 0;
  return async (o) => {
    if (o.host !== HOST) return server.transport(o);
    if (active > 0) {
      server.requests.push({ ...o, busy: true });
      return { status: 429, headers: {}, body: 'busy' };
    }
    active += 1;
    try {
      const hold = holdMs(o);
      if (hold) await wait(hold);
      return await server.transport(o);
    } finally {
      active -= 1;
    }
  };
}

// --- I1: cloud 429 on a write ------------------------------------------------------

test('I1 cloud: a 429 on a write is not sent again within the second, and pauses', async (t) => {
  const server = fakeMyPv({ cloud: { token: TOKEN, device: acThor() } });
  const store = memoryStore();
  const transport = async (o) => {
    if (o.method === 'PUT') {
      server.requests.push({ ...o });
      return {
        status: 429,
        headers: { 'retry-after': '600' },
        body: '{"msg":"Too Many Attempts."}',
      };
    }
    return server.transport(o);
  };
  const { press } = await setup(t, {
    config: { ...CLOUD, allow_setpoint: true },
    server,
    store,
    transport,
  });
  await press('target-temperature', 48);
  const puts = server.requests.filter((r) => r.method === 'PUT').length;
  assert.ok(puts <= 1, `${puts} PUT to api.my-pv.com after a 429 with Retry-After: 600`);
  assert.ok(store.data?.pause, 'no pause kept after a cloud 429 on a write');
});

// --- I2: a write refused 401/403 blocks every read for an hour ------------------------

test('I2 cloud: a 403 on the write (read-only token) does not stop the reads for an hour', async (t) => {
  const server = fakeMyPv({ cloud: { token: TOKEN, device: acThor() } });
  const transport = async (o) => {
    if (o.method === 'PUT') {
      server.requests.push({ ...o });
      return { status: 403, headers: {}, body: '{"msg":"This action is unauthorized."}' };
    }
    return server.transport(o);
  };
  const { press, advance, gladys } = await setup(t, {
    config: { ...CLOUD, allow_setpoint: true },
    server,
    transport,
  });
  await press('target-temperature', 48);
  server.requests.length = 0;
  await advance(5 * MINUTE, 10 * SECOND);
  assert.doesNotMatch(message(gladys).fr ?? '', /refusé le jeton/, 'status: token refused');
  assert.ok(reads(server) > 0, 'no read for 5 min after a refused write');
});

// --- I3: reads sooner than the interval (button, restart, save) -----------------------

test('I3a "Test the connection" never reads sooner than the interval', async (t) => {
  const server = fakeMyPv();
  const { gladys, advance } = await setup(t, { config: { host: HOST, poll_interval: 60 }, server });
  server.requests.length = 0;
  for (let i = 0; i < 4; i += 1) {
    await advance(11 * SECOND);
    await gladys.fake.action(ACTIONS.TEST_CONNECTION);
    await settle();
  }
  // 44 s after the first read, interval 60 s.
  assert.equal(reads(server), 0, `${reads(server)} GET in 44 s for an interval of 60 s`);
});

test('I3b a restart 5 s after a read does not read the device again at once', async (t) => {
  const server = fakeMyPv();
  const store = memoryStore();
  const { app, advance } = await setup(t, { server, store });
  app.stop();
  await advance(5 * SECOND);
  const gladys2 = createFakeGladys({ config: CONFIG });
  const app2 = new MyPvApp({
    gladys: gladys2,
    logger: recorder([]),
    transport: server.transport,
    now: () => Date.now(),
    store,
  });
  registerHandlers(gladys2, app2);
  t.after(() => app2.stop());
  server.requests.length = 0;
  await gladys2.connect();
  await settle();
  await advance(20 * SECOND);
  assert.equal(
    reads(server),
    0,
    `${reads(server)} GET within 25 s of the last read (interval 30 s)`,
  );
});

test('I3c saving only a new interval does not read at once', async (t) => {
  const server = fakeMyPv();
  const { gladys, advance } = await setup(t, { server });
  await advance(5 * SECOND);
  server.requests.length = 0;
  await gladys.fake.configUpdated({ host: HOST, poll_interval: 45 });
  await settle();
  assert.equal(reads(server), 0, `${reads(server)} GET at once after saving poll_interval`);
});

// --- I4: "Stop the boost" again after a late start: one try only --------------------------

test('I4 a start that lands late (device busy 5 s): the boost ends up stopped', async (t) => {
  const server = fakeMyPv();
  let busyUntil = 0;
  let slow = true;
  const transport = async (o) => {
    const now = Date.now();
    if (now < busyUntil) {
      server.requests.push({ ...o, busy: true });
      return { status: 429, headers: {}, body: 'busy' };
    }
    if (slow && o.path === '/setup.jsn?bststrt=1') {
      slow = false;
      server.requests.push({ ...o });
      busyUntil = now + 5000;
      // The device applies the start after 5 s; the request times out before.
      setTimeout(() => {
        server.device.data.boostactive = 1;
        server.device.data.screen_mode_flag = 2;
      }, 5000);
      await wait(Math.min(o.timeoutMs, 5000));
      throw new MyPvError(ERROR_KINDS.TIMEOUT, 'Connected but silent: timeout');
    }
    return server.transport(o);
  };
  const { send, advance } = await setup(t, {
    config: { host: HOST, allow_boost: true },
    server,
    transport,
  });
  const start = send('boost-start');
  await advance(1000, 100);
  const stop = send('boost-stop');
  await advance(30 * SECOND, 100);
  await start;
  await stop;
  assert.equal(
    server.device.data.boostactive,
    0,
    'the boost runs although "Stop" was pressed after the start',
  );
});

// --- I5: our own "Stop the boost" collides with a poll read: a 5 min pause ---------------

test('I5 a stop that overlaps a poll read never pauses the integration', async (t) => {
  const server = fakeMyPv();
  const store = memoryStore();
  const transport = busyDevice(server, (o) => (o.path === '/setup.jsn?bststrt=0' ? 800 : 0));
  const { send, advance, press, gladys } = await setup(t, {
    config: { host: HOST, allow_setpoint: true },
    server,
    store,
    transport,
  });
  await advance(29_500, 500);
  const stop = send('boost-stop');
  await advance(2000, 100);
  await stop;
  assert.equal(store.data?.pause ?? null, null, 'paused by our own stop');
  await advance(10 * SECOND);
  const ack = await press('target-temperature', 45);
  assert.equal(ack.success, true, `setpoint after our own stop: ${ack.error}`);
  assert.doesNotMatch(message(gladys).fr ?? '', /pause/);
});

// --- I6: answer after 5 s (401 then a new login inside a command) -------------------------

test('I6 a write that meets a 401 and a new login is still answered by 4.3 s', async (t) => {
  const server = fakeMyPv();
  server.device.password = PASSWORD;
  let armed = false;
  let writes = 0;
  const transport = async (o) => {
    if (armed && o.method === 'POST' && o.path === '/setup.jsn') {
      writes += 1;
      if (writes === 1) {
        server.device.session = 'expired';
        await wait(1000);
        return server.transport(o); // 401: the session was lost
      }
      server.requests.push({ ...o });
      await wait(o.timeoutMs); // the second write: silent
      throw new MyPvError(ERROR_KINDS.TIMEOUT, 'Connected but silent: timeout');
    }
    if (armed && o.path === '/auth.jsn') {
      await wait(1400);
    }
    return server.transport(o);
  };
  const { send, advance } = await setup(t, {
    config: { host: HOST, password: PASSWORD, allow_setpoint: true },
    server,
    transport,
  });
  armed = true;
  const t0 = Date.now();
  let at;
  const ack = send('target-temperature', 45).then((r) => {
    at = Date.now() - t0;
    return r;
  });
  await advance(9000, 100);
  await ack;
  assert.ok(at <= 4500, `answered ${at} ms after the click (Gladys gives up at 5000)`);
});

// --- M: the boost ceiling not checked again right before sending ------------------------

test('M1 the ceiling lowered while a start retries on 429: the start is not sent', async (t) => {
  const server = fakeMyPv();
  server.device.setup.ww1boost = 580;
  const config = { host: HOST, allow_boost: true, dhw_max_temperature: 60 };
  const { send, advance, gladys } = await setup(t, { config, server });
  server.device.busy = 6;
  const ack = send('boost-start');
  await advance(600, 100);
  await gladys.fake.configUpdated({ ...config, dhw_max_temperature: 50 });
  await settle();
  await advance(5000, 100);
  await ack;
  assert.equal(server.device.data.boostactive, 0, 'boost started to 58 °C with a ceiling of 50 °C');
});

test('M2 a boost setpoint read outside py-mypv range (0) refuses the start', async (t) => {
  const server = fakeMyPv();
  server.device.setup.ww1boost = 0;
  const { press } = await setup(t, { config: { host: HOST, allow_boost: true }, server });
  const ack = await press('boost-start');
  assert.equal(ack.success, false, 'started with ww1boost = 0 (py-mypv: 5 to 95 °C)');
  assert.ok(!server.writes().includes('bststrt=1'));
});

test('M3 the pin of a 9th address survives a restart', () => {
  const pins = {};
  for (let i = 1; i <= 8; i += 1) {
    pins[`local:10.0.0.${i}:443`] = Array.from({ length: 32 }, () => '0' + i).join(':');
  }
  pins[`local:${HOST}:443`] = Array.from({ length: 32 }, () => 'AB').join(':');
  const back = normalizeMemory(JSON.parse(JSON.stringify({ pins })), NOW);
  assert.ok(back.pins[`local:${HOST}:443`], 'the newest pin is dropped: trust on first use again');
});

test('M4 a cloud pause does not stop the local reads after switching to local', async (t) => {
  const server = fakeMyPv({
    cloud: { token: TOKEN, device: acThor(), status: 429, headers: { 'retry-after': '3600' } },
  });
  const { gladys, advance } = await setup(t, { config: CLOUD, server });
  server.requests.length = 0;
  await gladys.fake.configUpdated({ host: HOST });
  await settle();
  await advance(MINUTE);
  assert.ok(
    server.requests.some((r) => r.host === HOST),
    'local device never read: the pause of api.my-pv.com applies to it',
  );
});

test('M5 values of another device at the same address are never published under the first id', async (t) => {
  const server = fakeMyPv();
  const { gladys, advance } = await setup(t, { server });
  const other = '2001009999999999';
  server.device = acThor({
    identity: { sn: other, fwversion: 'a0021300', device: 'AC-THOR' },
  });
  server.device.setup.serialno = other;
  server.device.data.temp1 = 700;
  await advance(31 * SECOND);
  assert.notEqual(
    gladys.fake.lastState(feature('temperature-1')),
    70,
    'temperature of the other device',
  );
});

// --- Further checks of the corrections -------------------------------------------------

test('I2 local: a 403 on a write is a refused command, never "password refused"', async (t) => {
  const server = fakeMyPv();
  const transport = async (o) => {
    if (o.path.startsWith('/setup.jsn?')) {
      server.requests.push({ ...o });
      return { status: 403, headers: {}, body: 'forbidden' };
    }
    return server.transport(o);
  };
  const store = memoryStore();
  const { press, advance, gladys } = await setup(t, {
    config: { host: HOST, allow_setpoint: true },
    server,
    store,
    transport,
  });
  const ack = await press('target-temperature', 45);
  assert.match(ack.error, /refusé la commande \(HTTP 403\)/);
  assert.equal(store.data.block, null);
  await advance(MINUTE);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('I2 a stop during a refusal never pushes the next try further away', async (t) => {
  const server = fakeMyPv();
  server.device.password = 'right';
  const store = memoryStore();
  const { app, advance, gladys } = await setup(t, {
    config: { host: HOST, password: PASSWORD },
    server,
    store,
  });
  const until = store.data.block.until;
  await advance(10 * MINUTE, MINUTE);
  app.dev.knownSerial = SERIAL;
  await app.setValue(undefined, { external_id: feature('boost-stop') }, 1).catch(() => {});
  await settle();
  assert.equal(store.data.block.until, until);
  assert.match(gladys.fake.connectionStatus.message.fr, /refusé le mot de passe/);
});

test('M6 a stop that may have left during a restart is "sent, without confirmation"', async (t) => {
  const server = fakeMyPv();
  server.device.writeSilent = true;
  const { app, send, advance, gladys } = await setup(t, { server });
  const ack = send('boost-stop');
  await advance(500, 100);
  await gladys.fake.configUpdated({ host: HOST, language: 'en', poll_interval: 40 });
  await settle();
  await advance(5000, 100);
  const result = await ack;
  assert.equal(result.success, false);
  assert.match(result.error, /sans confirmation|without confirmation/);
  assert.ok(app);
});

test('M7 a restart during a pause kept in /data still shows the device in Discovery', async (t) => {
  const server = fakeMyPv();
  const store = memoryStore();
  const first = await setup(t, { server, store });
  first.app.stop();
  store.data.pause = { target: `local:${HOST}:80`, until: Date.now() + 30 * MINUTE };
  const gladys2 = createFakeGladys({ config: CONFIG, devices: first.gladys.fake.devices });
  const app2 = new MyPvApp({
    gladys: gladys2,
    logger: recorder([]),
    transport: server.transport,
    now: () => Date.now(),
    store,
  });
  registerHandlers(gladys2, app2);
  t.after(() => app2.stop());
  server.requests.length = 0;
  await gladys2.connect();
  await settle();
  assert.equal(server.requests.length, 0, 'nothing read during the pause');
  assert.equal(gladys2.fake.discoveredDevices.at(-1)?.external_id, DEVICE);
});

test('M9 /data is read once: a save just before a new configuration is never lost', async (t) => {
  const server = fakeMyPv();
  server.device.password = PASSWORD;
  const store = memoryStore();
  let loads = 0;
  const load = store.load.bind(store);
  store.load = async () => {
    loads += 1;
    return load();
  };
  const { gladys } = await setup(t, { config: { host: HOST, password: PASSWORD }, server, store });
  await gladys.fake.configUpdated({ host: HOST, password: PASSWORD, poll_interval: 45 });
  await settle();
  assert.equal(loads, 1);
});

test('F a stop still at the device when a setpoint reads: our own 429 never pauses', async (t) => {
  const server = fakeMyPv();
  const store = memoryStore();
  let armed = false;
  const transport = busyDevice(server, (o) => {
    if (!armed) return 0;
    if (o.path === '/data.jsn') return 500; // the poll read at 30 s
    if (o.path === '/setup.jsn?bststrt=0') return 800;
    return 0;
  });
  const { send, advance, gladys } = await setup(t, {
    config: { host: HOST, allow_setpoint: true },
    server,
    store,
    transport,
  });
  armed = true;
  await advance(30_000, 500); // the poll at 30 s: its data read holds the device 0.5 s
  await advance(100, 100);
  const stop = send('boost-stop'); // 30.1 s: the gate is busy, the stop goes without it
  await advance(600, 50); // its new try at ~30.6 s is at the device until ~31.4 s
  const setpoint = send('target-temperature', 45);
  await advance(6000, 100);
  await stop;
  const result = await setpoint;
  assert.equal(
    store.data?.pause ?? null,
    null,
    `paused by our own stop (setpoint: ${result.error})`,
  );
  assert.doesNotMatch(gladys.fake.connectionStatus?.message?.fr ?? '', /pause/);
});
test('/data: the time of the last read is written at most once a minute', async (t) => {
  const server = fakeMyPv();
  const store = memoryStore();
  const { advance } = await setup(t, { config: { host: HOST, poll_interval: 10 }, server, store });
  const saves = store.saves;
  await advance(10 * MINUTE, 10 * SECOND);
  // 60 reads in 10 minutes: about 10 writes, never one per read.
  assert.ok(store.saves - saves <= 11, `${store.saves - saves} writes in 10 min`);
});

test('a local command without serialno in the settings: refused with its own message', async (t) => {
  const server = fakeMyPv();
  const { press } = await setup(t, { config: { host: HOST, allow_setpoint: true }, server });
  delete server.device.setup.serialno;
  const ack = await press('target-temperature', 45);
  assert.equal(ack.success, false);
  assert.match(ack.error, /serialno/);
  assert.deepEqual(server.writes(), []);
});
