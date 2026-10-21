// -----------------------------------------------------------------------------
// The configuration: the manifest `config_schema` values, normalized so the
// rest of the code never deals with strings typed in a form. The password
// and the token are kept in memory only, never logged nor written to /data.
// -----------------------------------------------------------------------------

import { isIP } from 'node:net';
import { CONNECTIONS, DHW_CAP, LIMITS, POLL_INTERVAL } from './constants.js';
import { isDeviceIPv4 } from './mypv/http.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULT_CONFIG = {
  connection: 'local',
  host: '',
  serial_number: '',
  allow_setpoint: false,
  allow_boost: false,
  dhw_max_temperature: DHW_CAP.default,
  poll_interval: POLL_INTERVAL.default,
  language: 'fr',
};

/** The secret fields: no default (Gladys never shows them again). */
export const SECRET_KEYS = ['password', 'api_token'];

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

/**
 * The address of the device typed by the user: an IPv4 address or a host
 * name, with an optional port. A pasted URL is reduced to its host and port.
 * @returns {{ host: string, port: number | undefined } | undefined} undefined when invalid or empty.
 */
export function parseAddress(raw) {
  let text = String(raw ?? '')
    .trim()
    .toLowerCase();
  text = text.replace(/^https?:\/\//, '').replace(/[/?#].*$/, '');
  if (text === '' || text.length > 260) {
    return undefined;
  }
  const match = text.match(/^([^:@]+)(?::(\d{1,5}))?$/);
  if (!match) {
    return undefined;
  }
  const host = match[1];
  const port = match[2] === undefined ? undefined : Number(match[2]);
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    return undefined;
  }
  if (host.length > 253) {
    return undefined;
  }
  if (isIP(host) === 4) {
    // A device address only: never loopback, multicast, 0/8 nor 240/4.
    return isDeviceIPv4(host) ? { host, port } : undefined;
  }
  if (/^[\d.]+$/.test(host)) {
    return undefined;
  }
  return host.split('.').every((label) => LABEL.test(label)) ? { host, port } : undefined;
}

/** A serial number: digits and letters only, 6 to 32 characters (its first 6 digits name the model). */
export function parseSerial(raw) {
  const text = String(raw ?? '').trim();
  return new RegExp(`^[0-9A-Za-z]{6,${LIMITS.serialLength}}$`).test(text) ? text : undefined;
}

/**
 * A secret typed in the form: trimmed, at most LIMITS.secretLength
 * characters, without control characters; '' when empty or invalid.
 * `header`: it goes into an HTTP header (the token), visible ASCII only.
 */
export function secretOf(raw, { header = false } = {}) {
  if (typeof raw !== 'string') {
    return '';
  }
  const text = raw.trim();
  if (text.length > LIMITS.secretLength) {
    return '';
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(text)) {
    return '';
  }
  if (header && !/^[\x21-\x7e]*$/.test(text)) {
    return '';
  }
  return text;
}

/** Only `true` (or the text "true") allows: anything else, missing included, refuses. */
const strictTrue = (value) => value === true || value === 'true';

/** A number typed in the form: a finite number, or undefined ('' and null are not 0). */
export function numberOf(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string' && /^\s*-?\d{1,6}(\.\d{1,6})?\s*$/.test(value)) {
    return Number(value);
  }
  return undefined;
}

/**
 * The hot water ceiling: whole degrees within DHW_CAP, else the default
 * (55 °C). Never above DHW_CAP.max, whatever was typed.
 */
export function dhwCapOf(value) {
  const number = numberOf(value);
  if (number === undefined) {
    return DHW_CAP.default;
  }
  return Math.min(DHW_CAP.max, Math.max(DHW_CAP.min, Math.floor(number)));
}

export function normalizeConfig(raw = {}) {
  const c = { ...DEFAULT_CONFIG, password: '', api_token: '' };
  for (const [key, value] of Object.entries(raw ?? {})) {
    if ((Object.hasOwn(DEFAULT_CONFIG, key) || SECRET_KEYS.includes(key)) && value != null) {
      c[key] = value;
    }
  }
  const connection = CONNECTIONS.includes(c.connection) ? c.connection : 'local';
  const typedHost = String(c.host ?? '').trim();
  const typedSerial = String(c.serial_number ?? '').trim();
  const address = connection === 'local' ? parseAddress(typedHost) : undefined;
  const serial = connection === 'cloud' ? parseSerial(typedSerial) : undefined;
  const password = connection === 'local' ? secretOf(c.password) : '';
  const token = connection === 'cloud' ? secretOf(c.api_token, { header: true }) : '';
  const interval = numberOf(c.poll_interval);
  const floor = connection === 'cloud' ? POLL_INTERVAL.cloudMin : POLL_INTERVAL.min;
  let invalid;
  if (connection === 'local' && typedHost !== '' && !address) {
    invalid = { field: 'host', typed: typedHost.slice(0, 100) };
  } else if (connection === 'cloud' && typedSerial !== '' && !serial) {
    invalid = { field: 'serial', typed: typedSerial.slice(0, 40) };
  }
  return {
    connection,
    address,
    serial,
    password,
    token,
    /** What was typed, when it is not valid (shown in the status). */
    invalid,
    /** A cloud token was typed but cannot be used (control characters, too long). */
    badToken:
      connection === 'cloud' &&
      typeof c.api_token === 'string' &&
      c.api_token.trim() !== '' &&
      token === '',
    allowSetpoint: strictTrue(c.allow_setpoint),
    allowBoost: strictTrue(c.allow_boost),
    dhwCap: dhwCapOf(c.dhw_max_temperature),
    pollInterval:
      interval === undefined
        ? Math.max(floor, POLL_INTERVAL.default)
        : Math.min(POLL_INTERVAL.max, Math.max(floor, Math.round(interval))),
    language: c.language === 'en' ? 'en' : 'fr',
  };
}

/**
 * What identifies the device the configuration points at (never a secret):
 * `local:<host>:<port>` or `cloud:<serial>`. A refusal kept in /data only
 * applies to the same target.
 */
export function targetKey(config) {
  if (config.connection === 'cloud') {
    return config.serial ? `cloud:${config.serial.toLowerCase()}` : undefined;
  }
  return config.address
    ? `local:${config.address.host}:${config.address.port ?? (config.password ? 443 : 80)}`
    : undefined;
}
