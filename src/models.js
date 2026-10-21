// -----------------------------------------------------------------------------
// The my-PV models and the decoding of their answers (pure).
//
// Ported from py-mypv 0.0.14 (Apache-2.0, my-PV GmbH): the configuration
// files my_pv/configs/*.json (a base, 000000.json, and one file per model,
// named after the first 6 digits of the serial number) and the rules of
// my_pv/__init__.py that hide or remove settings:
//   - a value null or "null" is missing; a temperature read 0 is missing
//     (no sensor connected);
//   - without a value on temperature sensor 1, there is no boost (bstmode,
//     ww1boost removed: the device would have nothing to stop it);
//   - an AC•THOR in main mode 5 or 6 (space heating) has no boost;
//   - device mode off (devmode 0): every setting but devmode and ww1target
//     is unknown; boost mode off (bstmode 0): the boost values are unknown;
//   - an AC ELWA 2 in an ELWA-E compatibility mode is not supported.
// Only the keys this integration shows are kept (see FEATURES); dividers and
// units are those of the configuration files.
// -----------------------------------------------------------------------------

import { LIMITS } from './constants.js';

/** The models, by the first 6 digits of the serial number (my_pv/configs). */
export const MODELS = Object.freeze({
  140100: { name: 'SOL•THOR', power: 'power', solar: true },
  160150: { name: 'AC ELWA 2', power: 'power_elwa2', elwa2: true },
  160151: { name: 'AC ELWA 2', power: 'power_elwa2', elwa2: true },
  160152: { name: 'AC ELWA 2 3 kW', power: 'power_elwa2', elwa2: true },
  200100: { name: 'AC•THOR', power: 'power_act', thor: true },
  200103: { name: 'AC•THOR i', power: 'power_act', thor: true },
  200110: { name: 'AC•THOR Viessmann', power: 'power_act', thor: true },
  200113: { name: 'AC•THOR i Viessmann', power: 'power_act', thor: true },
  200120: { name: 'AC•THOR Greenheiss', power: 'power_act' },
  200300: { name: 'AC•THOR 9s', power: 'power_ac9', thor: true },
  200310: { name: 'AC•THOR 9s Viessmann', power: 'power_ac9', thor: true },
  200320: { name: 'AC•THOR 9s Greenheiss', power: 'power_ac9' },
  200330: { name: 'AC•THOR 9s Tuxhorn tubra eTherm', power: 'power_ac9' },
  210300: { name: 'HEA•THOR IoT 3,5 kW', devicePower: 'power_grid' },
  210900: { name: 'HEA•THOR IoT 9 kW', devicePower: 'power_grid' },
});

/** The model of a serial number, or undefined when this integration does not know it. */
export function modelOf(serial) {
  const prefix = String(serial ?? '').slice(0, 6);
  return Object.hasOwn(MODELS, prefix) ? { prefix, ...MODELS[prefix] } : undefined;
}

/** The status of the device (screen_mode_flag of 000000.json). */
export const SCREEN_MODES = [0, 1, 2, 3, 4, 5, 6];

/** A temperature in tenths of °C (000000.json: divider 10). */
const TEMPERATURES = ['temp1', 'temp2', 'temp3', 'temp4'];

/**
 * An integer as py-mypv reads one (`int(value)`): a finite number,
 * truncated, or a text of digits. Anything else is missing.
 */
export function integerOf(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.trunc(value) : undefined;
  }
  if (typeof value === 'string' && /^\s*-?\d{1,12}\s*$/.test(value)) {
    return Number(value.trim());
  }
  return undefined;
}

/** A 0/1 flag, strictly (0, 1, "0", "1", false, true). */
export function flagOf(value) {
  if (value === true || value === 1 || value === '1') return 1;
  if (value === false || value === 0 || value === '0') return 0;
  return undefined;
}

/** A short text from the device, without control characters. */
export function textOf(value) {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return undefined;
  }
  // eslint-disable-next-line no-control-regex
  const CONTROL = /[\u0000-\u001f\u007f]/g;
  const clean = String(value).replace(CONTROL, '').trim();
  return clean === '' ? undefined : clean.slice(0, LIMITS.textLength);
}

/**
 * The plain object of an answer: own keys only, lower case, at most
 * LIMITS.answerKeys of them, into an object without prototype (a key such
 * as "__proto__" stays an ordinary key). Not an object: undefined.
 */
export function plainOf(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  const out = Object.create(null);
  let count = 0;
  for (const key of Object.keys(raw)) {
    if (count >= LIMITS.answerKeys) break;
    count += 1;
    const value = raw[key];
    if (value === null || value === 'null' || value === undefined) continue;
    out[key.toLowerCase()] = value;
  }
  return out;
}

const own = (object, key) => (object && Object.hasOwn(object, key) ? object[key] : undefined);

/** A number of the answer divided by `divider`, within [min, max], else undefined. */
function scaled(object, key, divider, min, max) {
  const raw = integerOf(own(object, key));
  if (raw === undefined) {
    return undefined;
  }
  const value = raw / divider;
  return value >= min && value <= max ? value : undefined;
}

/** A temperature of the data: tenths of °C; 0 means "no sensor" (py-mypv). */
function temperature(data, key) {
  const raw = integerOf(own(data, key));
  if (raw === undefined || raw === 0) {
    return undefined;
  }
  const value = raw / 10;
  return value >= -50 && value <= 150 ? value : undefined;
}

/**
 * The settings of an answer of setup.jsn -> what this integration uses,
 * before the rules that depend on the data (decode applies them).
 */
export function parseSetup(raw) {
  const setup = plainOf(raw);
  if (!setup) {
    return undefined;
  }
  return {
    devmode: flagOf(own(setup, 'devmode')),
    bstmode: integerOf(own(setup, 'bstmode')),
    /** Whether the device has a boost mode at all (the key is there). */
    hasBoostMode: own(setup, 'bstmode') !== undefined,
    // py-mypv declares 5 to 95 °C (000000.json): anything else is missing.
    target: scaled(setup, 'ww1target', 10, 5, 95),
    boostTarget: scaled(setup, 'ww1boost', 10, 5, 95),
    mainmode: integerOf(own(setup, 'mainmode')),
    compmode: integerOf(own(setup, 'compmode')),
    firmware: textOf(own(setup, 'fwversion')),
    /** The serial number the settings carry (serialno), when they do. */
    serial: textOf(own(setup, 'serialno')),
  };
}

/** The measures of an answer of data.jsn (keys in lower case, as py-mypv). */
export function parseData(raw, model) {
  const data = plainOf(raw);
  if (!data) {
    return undefined;
  }
  const watts = (key) => (key ? scaled(data, key, 1, -100_000, 100_000) : undefined);
  const screen = integerOf(own(data, 'screen_mode_flag'));
  return {
    heatingPower: watts(model?.power),
    devicePower: watts(model?.devicePower),
    pvPower: model?.solar ? watts('power_solar') : undefined,
    pvVoltage: model?.solar ? scaled(data, 'volt_solar', 1000, 0, 1000) : undefined,
    meterPower: watts('surplus'),
    temps: TEMPERATURES.map((key) => temperature(data, key)),
    deviceTemp: temperature(data, 'temp_ps'),
    charge: scaled(data, 'soc', 1, 0, 100),
    screenMode: SCREEN_MODES.includes(screen) ? screen : undefined,
    /** Unknown codes are kept apart, for the status text. */
    screenCode: screen,
    boostActive: flagOf(own(data, 'boostactive')),
    firmware: textOf(own(data, 'fwversion')),
  };
}

/**
 * The values of one read: the settings (the last ones read) and the
 * measures, with py-mypv's rules. `setup` may be undefined (not read yet).
 * Throws `{ unsupported: 'compmode' }` for an AC ELWA 2 in an ELWA-E mode.
 */
export function decode(model, setup, data) {
  const s = setup ?? {};
  const d = data ?? { temps: [] };
  if (model?.elwa2 && s.compmode !== undefined && s.compmode !== 0) {
    throw Object.assign(new Error('compmode'), { unsupported: 'compmode' });
  }
  // No boost without temperature sensor 1, nor on an AC•THOR heating rooms.
  let boostSupported = Boolean(s.hasBoostMode) && d.temps[0] !== undefined;
  if (model?.thor && (s.mainmode === 5 || s.mainmode === 6)) {
    boostSupported = false;
  }
  const deviceOn = s.devmode;
  // Device mode off: only devmode and ww1target are known.
  const visible = deviceOn !== 0;
  const bstmode = boostSupported && visible ? s.bstmode : undefined;
  const boostOn = bstmode !== undefined && bstmode !== 0;
  return {
    ...d,
    devmode: deviceOn,
    target: s.target,
    bstmode,
    boostSupported,
    boostTarget: boostOn ? s.boostTarget : undefined,
    boostActive: boostOn ? d.boostActive : undefined,
    firmware: d.firmware ?? s.firmware,
  };
}
