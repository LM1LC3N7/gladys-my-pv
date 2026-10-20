import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dhwCapOf,
  normalizeConfig,
  parseAddress,
  parseSerial,
  secretOf,
  targetKey,
} from '../src/config.js';
import { DHW_CAP, POLL_INTERVAL } from '../src/constants.js';

test('the address: IPv4 or host name, optional port, a pasted URL reduced', () => {
  assert.deepEqual(parseAddress(' 192.168.1.80 '), { host: '192.168.1.80', port: undefined });
  assert.deepEqual(parseAddress('http://192.168.1.80/setup.jsn'), {
    host: '192.168.1.80',
    port: undefined,
  });
  assert.deepEqual(parseAddress('192.168.1.80:8080'), { host: '192.168.1.80', port: 8080 });
  assert.deepEqual(parseAddress('AC-THOR.local'), { host: 'ac-thor.local', port: undefined });
  for (const bad of [
    '',
    '300.1.1.1',
    '1.2.3',
    'a b',
    'x:0',
    'x:70000',
    '-x',
    'a_b',
    'u:p@h',
    '[::1]',
  ]) {
    assert.equal(parseAddress(bad), undefined, bad);
  }
  assert.deepEqual(normalizeConfig({ host: 'a_b' }).invalid, { field: 'host', typed: 'a_b' });
  assert.equal(normalizeConfig({ host: '' }).invalid, undefined);
});

test('the serial number and the secrets', () => {
  assert.equal(parseSerial(' 2001001234567890 '), '2001001234567890');
  for (const bad of ['', '12345', 'abc def', '2001-001', 'x'.repeat(33), null]) {
    assert.equal(parseSerial(bad), undefined, String(bad));
  }
  assert.equal(secretOf('  pw  '), 'pw');
  assert.equal(secretOf('a\nb'), '');
  assert.equal(secretOf('x'.repeat(513)), '');
  assert.equal(secretOf(12), '');
  assert.equal(secretOf('tok en', { header: true }), '', 'a space cannot go in a header');
  assert.equal(secretOf('toké', { header: true }), '');
  assert.equal(secretOf('tok-123', { header: true }), 'tok-123');
  const cloud = normalizeConfig({
    connection: 'cloud',
    serial_number: '2001001234567890',
    api_token: 'a b',
  });
  assert.equal(cloud.token, '');
  assert.equal(cloud.badToken, true);
});

test('local first: the cloud fields are ignored in local mode, and the other way round', () => {
  const local = normalizeConfig({
    host: '10.0.0.5',
    serial_number: '2001001234567890',
    api_token: 't',
  });
  assert.equal(local.connection, 'local');
  assert.equal(local.serial, undefined);
  assert.equal(local.token, '');
  assert.equal(targetKey(local), 'local:10.0.0.5:80');
  assert.equal(
    targetKey(normalizeConfig({ host: '10.0.0.5', password: 'p' })),
    'local:10.0.0.5:443',
  );
  const cloud = normalizeConfig({
    connection: 'cloud',
    host: '10.0.0.5',
    password: 'p',
    serial_number: '2001001234567890',
    api_token: 't',
  });
  assert.equal(cloud.address, undefined);
  assert.equal(cloud.password, '');
  assert.equal(targetKey(cloud), 'cloud:2001001234567890');
  assert.equal(normalizeConfig({ connection: 'other' }).connection, 'local');
});

test('the commands are allowed by true only', () => {
  for (const key of ['allow_setpoint', 'allow_boost']) {
    const field = key === 'allow_setpoint' ? 'allowSetpoint' : 'allowBoost';
    assert.equal(normalizeConfig({})[field], false);
    assert.equal(normalizeConfig({ [key]: true })[field], true);
    assert.equal(normalizeConfig({ [key]: 'true' })[field], true);
    for (const value of [1, '1', 'yes', 'TRUE', {}, [], null, undefined, false, 'false']) {
      assert.equal(normalizeConfig({ [key]: value })[field], false, `${key} ${String(value)}`);
    }
  }
});

test('the hot water ceiling: 55 °C by default, whole degrees from 40 to 60, never above 60', () => {
  assert.equal(normalizeConfig({}).dhwCap, DHW_CAP.default);
  assert.equal(DHW_CAP.default, 55);
  assert.equal(dhwCapOf(50), 50);
  assert.equal(dhwCapOf('52'), 52);
  assert.equal(dhwCapOf(58.9), 58, 'rounded down, never up');
  assert.equal(dhwCapOf(65), 60);
  assert.equal(dhwCapOf(1e9), 60);
  assert.equal(dhwCapOf(20), 40);
  for (const value of ['', ' ', null, undefined, 'abc', NaN, Infinity, {}, [], true]) {
    assert.equal(dhwCapOf(value), 55, String(value));
  }
});

test('interval bounded (60 s at least through the cloud), language fr or en, no pollution', () => {
  assert.equal(normalizeConfig({ poll_interval: 1 }).pollInterval, POLL_INTERVAL.min);
  assert.equal(normalizeConfig({ poll_interval: 99999 }).pollInterval, POLL_INTERVAL.max);
  assert.equal(normalizeConfig({ poll_interval: '' }).pollInterval, POLL_INTERVAL.default);
  assert.equal(normalizeConfig({ connection: 'cloud', poll_interval: 10 }).pollInterval, 60);
  assert.equal(normalizeConfig({ connection: 'cloud' }).pollInterval, 60);
  assert.equal(normalizeConfig({ language: 'de' }).language, 'fr');
  assert.equal(normalizeConfig({ language: 'en' }).language, 'en');
  const polluted = normalizeConfig(JSON.parse('{"__proto__":{"allow_boost":true}}'));
  assert.equal(polluted.allowBoost, false);
  assert.equal({}.allow_boost, undefined);
});
