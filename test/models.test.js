// py-mypv's rules (my_pv/__init__.py, my_pv/configs), ported in src/models.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MODELS,
  decode,
  flagOf,
  integerOf,
  modelOf,
  parseData,
  parseSetup,
  plainOf,
} from '../src/models.js';

const thor = modelOf('2001001234567890');
const setup = (over = {}) =>
  parseSetup({ devmode: 1, bstmode: 1, ww1target: 500, ww1boost: 600, mainmode: 1, ...over });
const data = (over = {}, model = thor) =>
  parseData(
    { power_act: 900, temp1: 450, temp2: 0, screen_mode_flag: 1, boostactive: 1, ...over },
    model,
  );

test('the models of py-mypv, by the first 6 digits of the serial number', () => {
  assert.equal(Object.keys(MODELS).length, 15);
  assert.equal(modelOf('2001001234').name, 'AC•THOR');
  assert.equal(modelOf('1601501234').name, 'AC ELWA 2');
  assert.equal(modelOf('2103001234').devicePower, 'power_grid');
  assert.equal(modelOf('9999991234'), undefined);
  assert.equal(modelOf('constructor'), undefined);
  assert.equal(modelOf('__proto__'), undefined);
});

test('numbers and flags are read strictly', () => {
  assert.equal(integerOf(523), 523);
  assert.equal(integerOf(52.9), 52, 'truncated, as int()');
  assert.equal(integerOf('523'), 523);
  for (const bad of ['52.3', '', ' ', null, undefined, NaN, Infinity, {}, [], true, '1e3']) {
    assert.equal(integerOf(bad), undefined, String(bad));
  }
  assert.equal(flagOf(1), 1);
  assert.equal(flagOf('0'), 0);
  assert.equal(flagOf(2), undefined);
  assert.equal(flagOf(null), undefined);
});

test('an answer is read through own keys only, without prototype pollution', () => {
  const raw = JSON.parse('{"__proto__": {"devmode": 1}, "TEMP1": 400, "x": null, "y": "null"}');
  const plain = plainOf(raw);
  assert.equal(Object.getPrototypeOf(plain), null);
  assert.equal(plain.temp1, 400, 'keys in lower case');
  assert.ok(!('x' in plain) && !('y' in plain), 'null and "null" are missing');
  assert.equal({}.devmode, undefined);
  assert.equal(plainOf([1, 2]), undefined);
  assert.equal(plainOf('x'), undefined);
  const big = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`k${i}`, i]));
  assert.equal(Object.keys(plainOf(big)).length, 400);
});

test('dividers and the temperatures read 0 (no sensor)', () => {
  const values = decode(thor, setup(), data());
  assert.equal(values.target, 50);
  assert.equal(values.boostTarget, 60);
  assert.equal(values.temps[0], 45);
  assert.equal(values.temps[1], undefined, 'a temperature read 0 is missing');
  assert.equal(values.heatingPower, 900);
  assert.equal(values.screenMode, 1);
  assert.equal(values.boostActive, 1);
  assert.equal(values.boostSupported, true);
  const sol = modelOf('1401001234');
  const solar = parseData({ power: 300, power_solar: 1500, volt_solar: 230500 }, sol);
  assert.equal(solar.pvPower, 1500);
  assert.equal(solar.pvVoltage, 230.5);
  assert.equal(solar.heatingPower, 300);
});

test('no boost without temperature sensor 1, nor on an AC•THOR heating rooms', () => {
  assert.equal(decode(thor, setup(), data({ temp1: 0 })).boostSupported, false);
  assert.equal(decode(thor, setup(), data({ temp1: 0 })).boostTarget, undefined);
  assert.equal(decode(thor, setup({ mainmode: 5 }), data()).boostSupported, false);
  assert.equal(decode(thor, setup({ mainmode: 6 }), data()).boostActive, undefined);
  // Greenheiss is not in py-mypv's list of that rule.
  const green = modelOf('2001201234');
  assert.equal(decode(green, setup({ mainmode: 5 }), data({}, green)).boostSupported, true);
});

test('device mode off hides all but the setpoint; boost mode off hides the boost', () => {
  const off = decode(thor, setup({ devmode: 0 }), data());
  assert.equal(off.devmode, 0);
  assert.equal(off.target, 50);
  assert.equal(off.bstmode, undefined);
  assert.equal(off.boostActive, undefined);
  const noBoost = decode(thor, setup({ bstmode: 0 }), data());
  assert.equal(noBoost.bstmode, 0);
  assert.equal(noBoost.boostActive, undefined);
  assert.equal(noBoost.boostTarget, undefined);
});

test('an AC ELWA 2 in an ELWA-E compatibility mode is not supported', () => {
  const elwa = modelOf('1601501234');
  assert.throws(
    () => decode(elwa, setup({ compmode: 1 }), data({}, elwa)),
    (err) => err.unsupported === 'compmode',
  );
  assert.doesNotThrow(() => decode(elwa, setup({ compmode: 0 }), data({}, elwa)));
});

test('values out of their range are missing', () => {
  const values = decode(thor, setup({ ww1target: 5000 }), data({ temp1: 9999, soc: 120 }));
  assert.equal(values.target, undefined);
  assert.equal(values.temps[0], undefined);
  assert.equal(values.charge, undefined);
});
