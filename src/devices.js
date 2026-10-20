// -----------------------------------------------------------------------------
// The my-PV device -> one Gladys device and its states (pure).
//
// `ext:<selector>:my-pv:<serial>`: the serial number of the device, in lower
// case (the same locally and through the cloud: switching keeps the device).
// The feature roles (the last part of their external ids) are published
// forever: never rename them.
//
// A feature appears once its value was read; a device published again never
// loses a feature: those of the device already created in Gladys are kept as
// they are (the core would mark it `structure_changed`, and "Update" would
// delete the missing feature and its history).
//
// No switch, no writable binary: a "turn everything off" (Google Home, Alexa,
// HomeKit, MCP, `switch.*` scenes) must never reach the water heater. The
// commands are the hot water setpoint (`water-heater/target-temperature`),
// "Start the boost" and "Stop the boost" (`button/push`); the boost running
// and the heating enabled are read-only `unknown/binary`.
//
// Categories and units are those the core lists
// (DEVICE_FEATURE_UNITS_BY_CATEGORY): W on `energy-sensor` and
// `energy-production-sensor`, V on `energy-sensor`, °C on
// `temperature-sensor`, `device-temperature-sensor` and `water-heater`, % on
// `water-heater`. Tank temperatures are `probe`, kept out of the room
// temperature of the core. The meter power ("surplus", whose sign py-mypv
// does not document) and the power a HEA•THOR reads are plain
// `unknown/decimal` sensors, the unit in their name. No energy index: the
// device gives none.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { DHW_CAP, FEATURES as F, SETPOINT } from './constants.js';
import { FEATURE_NAMES, SCREEN_NAMES, STATE_TEXTS, word } from './i18n.js';

const sensor = (definition) => ({
  read_only: true,
  has_feedback: false,
  keep_history: true,
  ...definition,
});
const watts = (category, type, min = 0) =>
  sensor({ category, type, unit: U.WATT, min, max: 100_000 });
const probe = sensor({
  category: C.TEMPERATURE_SENSOR,
  type: T.TEMPERATURE_SENSOR.PROBE,
  unit: U.CELSIUS,
  min: -50,
  max: 150,
});
const binary = sensor({ category: C.UNKNOWN, type: T.SENSOR.BINARY, min: 0, max: 1 });
const button = {
  category: C.BUTTON,
  type: T.BUTTON.PUSH,
  min: 0,
  max: 1,
  read_only: false,
  has_feedback: false,
  keep_history: false,
};

/** The features, by role, in display order. */
export const DEFINITIONS = {
  [F.STATUS]: sensor({ category: C.TEXT, type: T.TEXT.TEXT, min: 0, max: 0, keep_history: false }),
  [F.HEATING_POWER]: watts(C.ENERGY_SENSOR, T.ENERGY_SENSOR.POWER),
  [F.DEVICE_POWER]: sensor({
    category: C.UNKNOWN,
    type: T.SENSOR.DECIMAL,
    min: -100_000,
    max: 100_000,
  }),
  [F.PV_POWER]: watts(C.ENERGY_PRODUCTION_SENSOR, T.ENERGY_PRODUCTION_SENSOR.POWER),
  [F.PV_VOLTAGE]: sensor({
    category: C.ENERGY_SENSOR,
    type: T.ENERGY_SENSOR.VOLTAGE,
    unit: U.VOLT,
    min: 0,
    max: 1000,
  }),
  [F.METER_POWER]: sensor({
    category: C.UNKNOWN,
    type: T.SENSOR.DECIMAL,
    min: -100_000,
    max: 100_000,
  }),
  [F.TEMP_1]: probe,
  [F.TEMP_2]: probe,
  [F.TEMP_3]: probe,
  [F.TEMP_4]: probe,
  [F.DEVICE_TEMP]: sensor({
    category: C.DEVICE_TEMPERATURE_SENSOR,
    type: T.SENSOR.DECIMAL,
    unit: U.CELSIUS,
    min: -50,
    max: 150,
  }),
  [F.CHARGE]: sensor({
    category: C.WATER_HEATER,
    type: T.WATER_HEATER.REMAINING_HOT_WATER,
    unit: U.PERCENT,
    min: 0,
    max: 100,
  }),
  [F.HEATING_ENABLED]: binary,
  [F.BOOST_ACTIVE]: binary,
  [F.TARGET]: {
    category: C.WATER_HEATER,
    type: T.WATER_HEATER.TARGET_TEMPERATURE,
    unit: U.CELSIUS,
    // The slider stops at the hard ceiling; the configured one refuses below it.
    min: SETPOINT.min,
    max: DHW_CAP.max,
    read_only: false,
    has_feedback: true,
    keep_history: true,
  },
  [F.BOOST_TARGET]: probe,
  [F.BOOST_START]: button,
  [F.BOOST_STOP]: button,
};

export const ROLES = Object.keys(DEFINITIONS);
export const COMMAND_ROLES = [F.TARGET, F.BOOST_START, F.BOOST_STOP];

/** Where each number or flag comes from in the decoded values (src/models.js decode). */
const VALUES = {
  [F.HEATING_POWER]: (v) => v.heatingPower,
  [F.DEVICE_POWER]: (v) => v.devicePower,
  [F.PV_POWER]: (v) => v.pvPower,
  [F.PV_VOLTAGE]: (v) => v.pvVoltage,
  [F.METER_POWER]: (v) => v.meterPower,
  [F.TEMP_1]: (v) => v.temps?.[0],
  [F.TEMP_2]: (v) => v.temps?.[1],
  [F.TEMP_3]: (v) => v.temps?.[2],
  [F.TEMP_4]: (v) => v.temps?.[3],
  [F.DEVICE_TEMP]: (v) => v.deviceTemp,
  [F.CHARGE]: (v) => v.charge,
  [F.HEATING_ENABLED]: (v) => v.devmode,
  [F.BOOST_ACTIVE]: (v) => v.boostActive,
  [F.TARGET]: (v) => v.target,
  [F.BOOST_TARGET]: (v) => v.boostTarget,
};

/** The fields of a feature Gladys stores (what is kept of a created feature). */
const DECLARED = [
  'name',
  'external_id',
  'category',
  'type',
  'unit',
  'min',
  'max',
  'read_only',
  'has_feedback',
  'keep_history',
];

/** The platform id of a serial number: lower case. */
export const platformIdOf = (serial) => String(serial).toLowerCase();

export const deviceIds = (gladys, serial) => gladys.externalIds('my-pv', platformIdOf(serial));

/** The platform id and the role of one of our feature external ids, else undefined. */
export function parseFeatureId(externalId) {
  if (typeof externalId !== 'string') {
    return undefined;
  }
  const match = /:my-pv:([0-9a-z]{6,32}):([a-z0-9-]+)$/.exec(externalId);
  if (!match || !ROLES.includes(match[2])) {
    return undefined;
  }
  return { id: match[1], role: match[2] };
}

/** The platform id of one of our device external ids, else undefined. */
export function parseDeviceId(externalId) {
  const match = /:my-pv:([0-9a-z]{6,32})$/.exec(String(externalId ?? ''));
  return match ? match[1] : undefined;
}

/** The roles the values of one read report (a value read, not missing). */
export function reportedRoles(values) {
  const roles = new Set();
  if (values.screenCode !== undefined) {
    roles.add(F.STATUS);
  }
  for (const [role, valueOf] of Object.entries(VALUES)) {
    if (valueOf(values) !== undefined) {
      roles.add(role);
    }
  }
  if (values.boostSupported) {
    roles.add(F.BOOST_START);
    roles.add(F.BOOST_STOP);
  }
  return roles;
}

/**
 * The Gladys device. `roles`: those seen; `created`: the device already
 * created in Gladys, whose features are kept when the new build lacks them.
 */
export function buildDevice(
  gladys,
  { serial, model, firmware, connection },
  { roles, language, created },
) {
  const ids = deviceIds(gladys, serial);
  const params = [
    { name: 'serial_number', value: String(serial) },
    { name: 'connection', value: connection },
  ];
  if (firmware) {
    params.push({ name: 'firmware', value: firmware });
  }
  const built = {
    name: `my-PV ${model.name}`,
    external_id: ids.device,
    model: `my-PV ${model.name}`,
    should_poll: false,
    features: ROLES.filter((role) => roles.has(role)).map((role) => ({
      name: word(FEATURE_NAMES[role], language),
      external_id: ids.feature(role),
      ...DEFINITIONS[role],
    })),
    params,
  };
  return keepCreatedFeatures(built, created);
}

/** The features of the created device that the new build lacks, kept as they are. */
export function keepCreatedFeatures(built, created) {
  if (!created) {
    return built;
  }
  const have = new Set(built.features.map((f) => f.external_id));
  const kept = (created.features ?? [])
    .filter((f) => typeof f?.external_id === 'string' && !have.has(f.external_id))
    .map((f) =>
      Object.fromEntries(
        DECLARED.filter((k) => f[k] !== undefined && f[k] !== null).map((k) => [k, f[k]]),
      ),
    );
  return { ...built, features: [...built.features, ...kept] };
}

/** The text of the status read. */
export function statusText(values, language) {
  if (values.screenMode !== undefined) {
    return word(SCREEN_NAMES[values.screenMode], language);
  }
  return word(STATE_TEXTS.unknownScreen(values.screenCode), language);
}

/**
 * The current values of the device. `status`: 'online', or 'offline' / 'other'
 * (the device does not answer / another device answers): then only the
 * status text changes, Gladys keeps the last value of the others.
 */
export function deviceStates(ids, values, { status = 'online', language }) {
  if (status !== 'online') {
    const text = status === 'other' ? STATE_TEXTS.other : STATE_TEXTS.offline;
    return [{ device_feature_external_id: ids.feature(F.STATUS), text: word(text, language) }];
  }
  const states = [];
  if (values.screenCode !== undefined) {
    states.push({ role: F.STATUS, text: statusText(values, language) });
  }
  for (const [role, valueOf] of Object.entries(VALUES)) {
    const value = valueOf(values);
    if (value !== undefined && Number.isFinite(value)) {
      states.push({ role, state: value });
    }
  }
  return states.map(({ role, ...value }) => ({
    device_feature_external_id: ids.feature(role),
    ...value,
  }));
}
