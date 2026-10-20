// -----------------------------------------------------------------------------
// End to end: the real SDK wiring (src/handlers.js) against the SDK's fake
// Gladys and a fake my-PV device behind the transport. Timers and Date are
// mocked: the tests move the clock.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_TRANSPORTS } from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { MyPvApp } from '../src/app.js';
import { ACTIONS, HOUR, MINUTE, SECOND } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { memoryStore } from '../src/store.js';
import {
  HOST,
  NOW,
  OTHER_FINGERPRINT,
  PASSWORD,
  SERIAL,
  TOKEN,
  acThor,
  fakeMyPv,
  settle,
} from './fixtures/fakeMyPv.js';

const CONFIG = { host: HOST };
const SETPOINT = { host: HOST, allow_setpoint: true };
const BOOST = { host: HOST, allow_boost: true };
const DEVICE = `ext:test-integration:my-pv:${SERIAL}`;
const feature = (role) => `${DEVICE}:${role}`;

async function setup(
  t,
  { config = CONFIG, server = fakeMyPv(), store = memoryStore(), create = true, logs = [] } = {},
) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: NOW });
  const gladys = createFakeGladys({ config });
  const app = new MyPvApp({
    gladys,
    logger: recorder(logs),
    transport: server.transport,
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
  if (create && gladys.fake.discoveredDevices.length > 0) {
    await gladys.fake.deviceCreated(gladys.fake.discoveredDevices.at(-1));
    await settle();
  }
  const send = (role, value = 1) => {
    const created = gladys.fake.devices.find((d) => d.external_id === DEVICE);
    const target = created.features.find((f) => f.external_id === feature(role));
    assert.ok(target, `no feature ${role}`);
    return gladys.fake.setValue(created, target, value);
  };
  const press = async (role, value = 1, wait = 5 * SECOND) => {
    const ack = send(role, value);
    await settle();
    await advance(wait, 100);
    return ack;
  };
  return { gladys, app, server, store, advance, logs, send, press };
}

const recorder = (logs) =>
  Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push(args.map((a) => (a instanceof Error ? a.stack : String(a))).join(' ')),
    ]),
  );

const last = (gladys, role) => gladys.fake.lastState(feature(role));
const message = (gladys) => gladys.fake.connectionStatus?.message ?? {};
const deviceOf = (gladys) => gladys.fake.discoveredDevices.at(-1);
const failure = async (ack) => {
  const result = await ack;
  assert.equal(result.success, false, 'the command should fail');
  return result.error;
};
const ok = async (ack) => {
  const result = await ack;
  assert.equal(result.success, true, result.error);
};

test('without an address, the status asks for it and nothing is requested', async (t) => {
  const server = fakeMyPv();
  const { gladys } = await setup(t, { config: {}, server });
  assert.equal(server.requests.length, 0);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(message(gladys).fr, /adresse IP/);
  const ack = await gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.match(ack.data.message.en, /IP address/);
  assert.equal(server.requests.length, 0);
});

test('one read: the device, its features, then its states', async (t) => {
  const { gladys, server } = await setup(t);
  assert.deepEqual(server.paths(), ['GET /mypv_dev.jsn', 'GET /setup.jsn', 'GET /data.jsn']);
  const device = deviceOf(gladys);
  assert.equal(device.external_id, DEVICE);
  assert.equal(device.name, 'my-PV AC•THOR');
  assert.deepEqual(
    device.features.map((f) => [
      f.external_id.slice(DEVICE.length + 1),
      f.category,
      f.type,
      f.unit,
    ]),
    [
      ['status', 'text', 'text', undefined],
      ['heating-power', 'energy-sensor', 'power', 'watt'],
      ['meter-power', 'unknown', 'decimal', undefined],
      ['temperature-1', 'temperature-sensor', 'probe', 'celsius'],
      ['device-temperature', 'device-temperature-sensor', 'decimal', 'celsius'],
      ['hot-water-charge', 'water-heater', 'remaining-hot-water', 'percent'],
      ['heating-enabled', 'unknown', 'binary', undefined],
      ['boost-active', 'unknown', 'binary', undefined],
      ['target-temperature', 'water-heater', 'target-temperature', 'celsius'],
      ['boost-target-temperature', 'temperature-sensor', 'probe', 'celsius'],
      ['boost-start', 'button', 'push', undefined],
      ['boost-stop', 'button', 'push', undefined],
    ],
  );
  // No switch, no writable binary.
  for (const f of device.features) {
    assert.ok(f.read_only || ['button', 'water-heater'].includes(f.category), f.external_id);
    assert.notEqual(f.category, 'switch');
  }
  const target = device.features.find((f) => f.external_id === feature('target-temperature'));
  assert.equal(target.max, 60, 'the slider stops at 60 °C');
  assert.equal(last(gladys, 'heating-power'), 1200);
  assert.equal(last(gladys, 'temperature-1'), 48.2);
  assert.equal(last(gladys, 'target-temperature'), 50);
  assert.equal(last(gladys, 'boost-target-temperature'), 55);
  assert.equal(last(gladys, 'hot-water-charge'), 64);
  assert.equal(last(gladys, 'meter-power'), -350);
  assert.equal(last(gladys, 'status'), 'Chauffe');
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.match(message(gladys).en, /Connected: AC•THOR 2001001234567890 \(local\)/);
});

test('the settings are read on every 6th poll, the measures on every poll', async (t) => {
  const { server, advance } = await setup(t);
  server.requests.length = 0;
  await advance(5 * 30 * SECOND);
  assert.deepEqual(
    server.paths().filter((p) => p !== 'GET /data.jsn'),
    [],
    'polls 2 to 6: data only',
  );
  await advance(30 * SECOND);
  assert.ok(server.paths().includes('GET /setup.jsn'));
});

test('the setpoint is refused by default, and nothing is sent', async (t) => {
  const { server, press } = await setup(t);
  const error = await failure(press('target-temperature', 52));
  assert.match(error, /Autoriser la consigne d'eau chaude/);
  assert.deepEqual(server.writes(), []);
});

test('the setpoint, allowed: read again just before, then written in tenths', async (t) => {
  const { server, press, gladys } = await setup(t, { config: SETPOINT });
  server.requests.length = 0;
  await ok(press('target-temperature', 52, 200));
  assert.deepEqual(server.paths().slice(0, 2), ['GET /setup.jsn', 'GET /setup.jsn?ww1target=520']);
  assert.equal(server.device.setup.ww1target, 520);
  await ok(press('target-temperature', '52', 200));
  assert.deepEqual(server.writes(), ['ww1target=520'], 'already so after the read: nothing sent');
  assert.equal(last(gladys, 'target-temperature'), 52);
});

test('the setpoint ceiling: 55 °C by default, never above 60 °C, checked again before sending', async (t) => {
  const { server, press, gladys } = await setup(t, { config: SETPOINT });
  assert.match(await failure(press('target-temperature', 56)), /plafonnée à 55 °C/);
  for (const bad of [61, 95, '', null, 'abc', 52.5, true]) {
    await failure(press('target-temperature', bad));
  }
  assert.deepEqual(server.writes(), []);
  // A ceiling of 70 typed is 60.
  await gladys.fake.configUpdated({ ...SETPOINT, dhw_max_temperature: 70 });
  await settle();
  await ok(press('target-temperature', 60));
  assert.match(await failure(press('target-temperature', 61)), /60 °C/);
  // The ceiling lowered while the fresh read runs: refused unsent.
  server.device.readDelay = 500;
  const ack = gladys.fake.setValue(
    gladys.fake.devices[0],
    gladys.fake.devices[0].features.find((f) => f.external_id === feature('target-temperature')),
    58,
  );
  await settle();
  await gladys.fake.configUpdated({ ...SETPOINT, dhw_max_temperature: 50 });
  t.mock.timers.tick(600);
  await settle();
  assert.match(await failure(ack), /plafonnée à 50 °C/);
  assert.deepEqual(server.writes(), ['ww1target=600']);
});

test('the option turned off during the fresh read: refused before the request leaves', async (t) => {
  const { server, gladys, send, advance } = await setup(t, { config: SETPOINT });
  server.device.readDelay = 500;
  const ack = send('target-temperature', 45);
  await settle();
  await gladys.fake.configUpdated({ host: HOST, allow_setpoint: false });
  await advance(1000, 100);
  assert.match(await failure(ack), /désactivée/);
  assert.deepEqual(server.writes(), []);
});

test('the boost start is refused by default; "Stop the boost" is always allowed', async (t) => {
  const { server, press } = await setup(t);
  assert.match(await failure(press('boost-start')), /Autoriser le démarrage du boost/);
  assert.deepEqual(server.writes(), []);
  server.device.data.boostactive = 1;
  await ok(press('boost-stop', 1, 200));
  assert.deepEqual(server.writes(), ['bststrt=0']);
  assert.equal(server.device.data.boostactive, 0);
});

test('the boost start: decided on the settings and measures read just before', async (t) => {
  const { server, press } = await setup(t, { config: BOOST });
  server.requests.length = 0;
  await ok(press('boost-start', 1, 200));
  assert.deepEqual(server.paths().slice(0, 3), [
    'GET /setup.jsn',
    'GET /data.jsn',
    'GET /setup.jsn?bststrt=1',
  ]);
  assert.equal(server.device.data.boostactive, 1);
});

test('the boost start is refused when the boost setpoint of the device is above the ceiling', async (t) => {
  const server = fakeMyPv();
  server.device.setup.ww1boost = 650;
  const { press } = await setup(t, { config: BOOST, server });
  assert.match(await failure(press('boost-start')), /consigne du boost de l'appareil \(65 °C\)/);
  assert.deepEqual(server.writes(), []);
});

test('the boost start is refused without boost mode, device off, or without sensor 1', async (t) => {
  const server = fakeMyPv();
  const { press } = await setup(t, { config: BOOST, server });
  server.device.setup.bstmode = 0;
  assert.match(await failure(press('boost-start')), /pas de boost/);
  server.device.setup.bstmode = 1;
  server.device.setup.devmode = 0;
  assert.match(await failure(press('boost-start')), /pas de boost/);
  server.device.setup.devmode = 1;
  server.device.data.temp1 = 0;
  assert.match(await failure(press('boost-start')), /pas de boost/);
  assert.deepEqual(server.writes(), []);
});

test('a stop withdraws a start that has not left yet', async (t) => {
  const server = fakeMyPv();
  const { send, advance } = await setup(t, { config: BOOST, server });
  server.device.readDelay = 800;
  const start = send('boost-start');
  await settle();
  const stop = send('boost-stop');
  await advance(3000, 100);
  await ok(stop);
  assert.match(await failure(start), /Arrêter le boost/);
  assert.deepEqual(server.writes(), ['bststrt=0']);
});

test('a stop during a start in flight is sent again once the start settles', async (t) => {
  const server = fakeMyPv();
  const { send, advance } = await setup(t, { config: BOOST, server });
  server.device.writeDelay = 1500;
  const start = send('boost-start');
  await advance(500, 100);
  const stop = send('boost-stop');
  await advance(6000, 100);
  await ok(start);
  await stop;
  assert.deepEqual(server.writes().slice(0, 3), ['bststrt=1', 'bststrt=0', 'bststrt=0']);
  assert.equal(server.device.data.boostactive, 0);
});

test('one command at a time: a second setpoint is refused while one runs', async (t) => {
  const server = fakeMyPv();
  const { send, advance } = await setup(t, { config: SETPOINT, server });
  server.device.writeDelay = 1000;
  const first = send('target-temperature', 45);
  await settle();
  const second = send('target-temperature', 46);
  await advance(3000, 100);
  await ok(first);
  assert.match(await failure(second), /encore en cours/);
});

test('a silent write is "sent, without confirmation", then read again', async (t) => {
  const server = fakeMyPv();
  const { send, advance } = await setup(t, { config: SETPOINT, server });
  server.device.writeSilent = true;
  const ack = send('target-temperature', 45);
  await advance(5000, 100);
  assert.match(await failure(ack), /envoyée, sans confirmation/);
  server.device.writeSilent = false;
  server.requests.length = 0;
  await advance(21 * SECOND);
  assert.ok(server.paths().includes('GET /setup.jsn'), 'the settings are read again after it');
});

test('a device that does not answer: the command is refused unsent', async (t) => {
  const server = fakeMyPv();
  const { press, advance } = await setup(t, { config: SETPOINT, server });
  server.device.down = true;
  await advance(31 * SECOND);
  assert.match(await failure(press('target-temperature', 45)), /non envoyée/);
  assert.deepEqual(server.writes(), []);
});

test('a write answered 429: tried again every 250 ms within the deadline (busy, not applied)', async (t) => {
  const server = fakeMyPv();
  const { press } = await setup(t, { config: SETPOINT, server });
  server.device.busy = 2;
  await ok(press('target-temperature', 45, 2000));
  assert.deepEqual(server.writes(), ['ww1target=450', 'ww1target=450', 'ww1target=450']);
});

test('a 429 on a read pauses every path but the stop, kept in /data', async (t) => {
  const server = fakeMyPv();
  const store = memoryStore();
  const { gladys, press, advance } = await setup(t, { config: SETPOINT, server, store });
  server.device.status = { '/data.jsn': 429 };
  server.device.headers = { 'retry-after': '600' };
  await advance(31 * SECOND);
  assert.match(message(gladys).fr, /pause pendant 10 min/);
  assert.equal(store.data.pause.until, NOW + 30 * SECOND + 10 * MINUTE);
  server.requests.length = 0;
  await advance(5 * MINUTE);
  assert.deepEqual(server.requests, [], 'nothing read during the pause');
  assert.match(await failure(press('target-temperature', 45)), /en pause/);
  // The stop: one try during the pause.
  server.device.busy = 3;
  assert.match(await failure(press('boost-stop', 1, 200)), /HTTP 429/);
  assert.deepEqual(server.writes(), ['bststrt=0']);
  server.device.busy = 0;
  await ok(press('boost-stop', 1, 200));
});

test('the pause survives a restart, bounded', async (t) => {
  const server = fakeMyPv();
  const store = memoryStore({ pause: { until: NOW + 100 * HOUR } });
  const { gladys } = await setup(t, { server, store });
  assert.deepEqual(server.requests, []);
  assert.match(message(gladys).en, /paused for 6 h/);
});

test('a refused password stops the reads, kept in /data, tried again after an hour', async (t) => {
  const server = fakeMyPv();
  server.device.password = 'right';
  const store = memoryStore();
  const logs = [];
  const { gladys, advance } = await setup(t, {
    config: { host: HOST, password: PASSWORD },
    server,
    store,
    logs,
  });
  assert.deepEqual(server.paths(), ['POST /auth.jsn']);
  assert.match(message(gladys).fr, /refusé le mot de passe/);
  assert.equal(store.data.block.kind, 'auth');
  await advance(59 * MINUTE, 30 * SECOND);
  assert.equal(server.paths().length, 1, 'no new login within the hour');
  await advance(2 * MINUTE, 30 * SECOND);
  assert.equal(server.paths().length, 2, 'one new try after the hour');
  // The password never appears in a log, the status nor /data.
  const everything = JSON.stringify([logs, store.data, gladys.fake.connectionStatus]);
  assert.ok(!everything.includes(PASSWORD));
  assert.ok(!everything.includes(encodeURIComponent(PASSWORD)));
});

test('a new password is tried at once; HTTPS login, cookie, certificate pinned', async (t) => {
  const server = fakeMyPv();
  server.device.password = PASSWORD;
  const store = memoryStore();
  const { gladys } = await setup(t, { config: { host: HOST, password: 'wrong' }, server, store });
  assert.equal(store.data.block.kind, 'auth');
  await gladys.fake.configUpdated({ host: HOST, password: PASSWORD });
  await settle();
  assert.equal(store.data.block, null);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  const pinned = Object.values(store.data.pins);
  assert.equal(pinned.length, 1);
  assert.ok(server.requests.every((r) => r.protocol === 'https' && r.port === 443));
  assert.equal(server.requests.at(-1).headers.Cookie, 'sid=s1');
});

test('a changed certificate: the password is never sent; the button trusts the new one', async (t) => {
  const server = fakeMyPv();
  server.device.password = PASSWORD;
  const store = memoryStore();
  const { gladys, advance } = await setup(t, {
    config: { host: HOST, password: PASSWORD },
    server,
    store,
  });
  assert.equal(gladys.fake.connectionStatus.connected, true);
  server.device.fingerprint = OTHER_FINGERPRINT;
  server.device.session = 'expired';
  server.requests.length = 0;
  await advance(31 * SECOND);
  // The fake refuses the request before any byte: nothing reached it but the attempt.
  assert.match(message(gladys).fr, /certificat de l'appareil a changé/);
  assert.equal(store.data.block.kind, 'certificate_changed');
  const ack = await gladys.fake.action(ACTIONS.TRUST_CERTIFICATE);
  assert.match(ack.data.message.en, /trusted at the next connection/);
  assert.equal(Object.values(store.data.pins)[0], OTHER_FINGERPRINT);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('a device asking for HTTPS without a password: said, no loop', async (t) => {
  const server = fakeMyPv();
  server.device.redirect = true;
  const { gladys, advance } = await setup(t, { server });
  assert.match(message(gladys).en, /asks for a password/);
  const count = server.requests.length;
  await advance(30 * MINUTE, 30 * SECOND);
  assert.equal(server.requests.length, count);
});

test('the cloud: bearer token, 60 s at least, the token never logged', async (t) => {
  const device = acThor();
  const server = fakeMyPv({ cloud: { token: TOKEN, device } });
  const logs = [];
  const store = memoryStore();
  const { gladys, advance, press } = await setup(t, {
    config: {
      connection: 'cloud',
      serial_number: SERIAL,
      api_token: TOKEN,
      poll_interval: 10,
      allow_setpoint: true,
    },
    server,
    logs,
    store,
  });
  assert.deepEqual(server.paths(), [
    `GET /api/v1/device/${SERIAL}/isOnline`,
    `GET /api/v1/device/${SERIAL}/setup`,
    `GET /api/v1/device/${SERIAL}/data`,
    `GET /api/v1/device/${SERIAL}/data/soc`,
  ]);
  assert.equal(server.requests[0].headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(last(gladys, 'hot-water-charge'), 71);
  assert.match(message(gladys).en, /my-PV cloud/);
  const count = server.requests.length;
  await advance(59 * SECOND);
  assert.equal(server.requests.length, count, 'never sooner than 60 s through the cloud');
  await ok(press('target-temperature', 48, 200));
  assert.ok(server.writes().includes('{"ww1target":480}'));
  const everything = JSON.stringify([logs, store.data, gladys.fake.connectionStatus]);
  assert.ok(!everything.includes(TOKEN));
});

test('a refused cloud token stops the reads; a new token is tried at once', async (t) => {
  const server = fakeMyPv({ cloud: { token: TOKEN, device: acThor() } });
  const store = memoryStore();
  const { gladys, advance } = await setup(t, {
    config: { connection: 'cloud', serial_number: SERIAL, api_token: 'bad' },
    server,
    store,
  });
  assert.match(message(gladys).fr, /refusé le jeton/);
  const count = server.requests.length;
  await advance(30 * MINUTE, MINUTE);
  assert.equal(server.requests.length, count);
  await gladys.fake.configUpdated({ connection: 'cloud', serial_number: SERIAL, api_token: TOKEN });
  await settle();
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('a reconnection to Gladys sends the status and the Discovery list again', async (t) => {
  const { gladys, app } = await setup(t);
  const discovered = gladys.fake.bodies('POST', '/discovered_device').length;
  const statuses = gladys.fake.connectionStatuses.length;
  await app.connected(await gladys.getConfig());
  await settle();
  assert.equal(gladys.fake.connectionStatuses.length, statuses + 1);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(gladys.fake.bodies('POST', '/discovered_device').length, discovered + 1);
});

test('a republished device never loses a feature', async (t) => {
  const server = fakeMyPv();
  const { gladys, advance } = await setup(t, { server });
  const before = deviceOf(gladys).features.map((f) => f.external_id);
  // The boost mode and sensor 1 disappear: their features stay.
  server.device.setup.bstmode = 0;
  server.device.data.temp1 = 0;
  await gladys.fake.configUpdated({ host: HOST, language: 'en' });
  await settle();
  await advance(6 * 30 * SECOND);
  const after = deviceOf(gladys).features.map((f) => f.external_id);
  for (const id of before) {
    assert.ok(after.includes(id), `${id} lost`);
  }
});

test('the transport badge: local when read, unreachable when not', async (t) => {
  const server = fakeMyPv();
  const { gladys, advance } = await setup(t, { server });
  assert.deepEqual(gladys.fake.transports.at(-1), {
    device_external_id: DEVICE,
    transport: DEVICE_TRANSPORTS.LOCAL,
  });
  server.device.down = true;
  await advance(31 * SECOND);
  assert.equal(gladys.fake.transports.at(-1).transport, DEVICE_TRANSPORTS.UNREACHABLE);
});
