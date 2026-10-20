// -----------------------------------------------------------------------------
// The my-PV APIs, ported from py-mypv 0.0.14 (Apache-2.0, my-PV GmbH),
// my_pv/connection.py: the local HTTP API (no password), the local HTTPS API
// (password, POST /auth.jsn first) and the cloud API (a bearer token).
//
// Changed from py-mypv:
//   - one request at a time is enforced by the app (src/app.js), not here;
//   - reads are never retried here (the app spaces its new tries); a write
//     is tried again only while the device answers 429 ("busy": it was not
//     applied), every 250 ms, 10 tries at most and never after its deadline
//     (py-mypv's _handle_rate_limiting); never on any other answer;
//   - a 401 makes one new login, then one new try, never more (py-mypv's
//     _handle_reauthentication); a refused login is final until the app
//     tries again later;
//   - no redirect is followed: a device that sends plain HTTP to HTTPS asks
//     for a password ("needs_password");
//   - the password, the token and the cookies never appear in an error, a
//     log line nor /data.
// -----------------------------------------------------------------------------

import {
  CLOUD_HOST,
  LIMITS,
  LOCAL_HTTP_PORT,
  LOCAL_HTTPS_PORT,
  PATHS,
  TIMINGS,
} from '../constants.js';
import { integerOf, plainOf, textOf } from '../models.js';
import { ERROR_KINDS, MyPvError, request as httpRequest } from './http.js';

/** Retry-After (seconds or an HTTP date) in ms, else undefined. */
export function retryAfterOf(header, now = Date.now()) {
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string' || value.trim() === '') {
    return undefined;
  }
  if (/^\s*\d{1,9}\s*$/.test(value)) {
    return Number(value) * 1000;
  }
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/** The error of an answer that is not 2xx. */
export function statusError(response, now) {
  const status = response.status;
  const retryAfter = retryAfterOf(response.headers?.['retry-after'], now);
  if (status === 429) {
    return new MyPvError(ERROR_KINDS.RATE_LIMITED, 'HTTP 429', { status, retryAfter });
  }
  if (status >= 500 && status <= 599) {
    return new MyPvError(ERROR_KINDS.SERVER, `HTTP ${status}`, { status, retryAfter });
  }
  if (status === 401 || status === 403) {
    return new MyPvError(ERROR_KINDS.AUTH, `HTTP ${status}`, { status });
  }
  return new MyPvError(ERROR_KINDS.HTTP, `HTTP ${status}`, { status });
}

/** The reason of an error for a log or a message: its kind and status, never the answer. */
export function errorReason(err) {
  if (typeof err?.status === 'number') {
    return `HTTP ${err.status}`;
  }
  return err?.kind ?? 'error';
}

/** The JSON of an answer, else a protocol error. */
function jsonOf(response) {
  try {
    return JSON.parse(response.body);
  } catch {
    throw new MyPvError(ERROR_KINDS.PROTOCOL, 'Not JSON');
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A refusal of the last check is marked: nothing was sent, the caller passes it on as is. */
function runBeforeSend(beforeSend) {
  if (!beforeSend) {
    return;
  }
  try {
    beforeSend();
  } catch (err) {
    err.beforeSend = true;
    throw err;
  }
}

/** What both clients share: the deadline checks and the busy retries of a write. */
class BaseClient {
  constructor({ transport = httpRequest, now = Date.now, sleep = wait }) {
    this.transport = transport;
    this.now = now;
    this.sleep = sleep;
  }

  /**
   * One write, tried again only while the device answers 429 (not applied).
   * `startBy`: nothing leaves after it (LATE). `retryBusy`: false for one try.
   */
  async write(key, value, { startBy, answerBy, retryBusy = true, beforeSend }) {
    if (!Number.isInteger(value) || value < 0 || value > 1000) {
      throw new MyPvError(ERROR_KINDS.PROTOCOL, `Bad value for ${key}`, { notSent: true });
    }
    for (let tries = 1; ; tries += 1) {
      if (this.now() > startBy) {
        throw new MyPvError(ERROR_KINDS.LATE, 'Too late to send');
      }
      try {
        return await this.writeOnce(key, value, {
          timeoutMs: Math.max(200, answerBy - this.now()),
          startBy,
          beforeSend,
        });
      } catch (err) {
        const again =
          err.kind === ERROR_KINDS.RATE_LIMITED &&
          retryBusy &&
          tries < TIMINGS.busyTries &&
          this.now() + TIMINGS.busyRetry <= startBy;
        if (!again) {
          throw err;
        }
        await this.sleep(TIMINGS.busyRetry);
      }
    }
  }
}

/** The local API of the device, plain HTTP or HTTPS with a password. */
export class LocalClient extends BaseClient {
  /**
   * @param {object} options
   * @param {{ host: string, port?: number }} options.address
   * @param {string} [options.password] HTTPS and a login when set
   * @param {{ get: () => string | undefined, set: (fp: string) => void }} [options.pin]
   */
  constructor({ address, password = '', pin, ...rest }) {
    super(rest);
    this.host = address.host;
    this.password = password;
    this.secure = password !== '';
    this.port = address.port ?? (this.secure ? LOCAL_HTTPS_PORT : LOCAL_HTTP_PORT);
    this.pin = pin;
    this.authed = false;
    /** name=value of the cookies the device set at login (memory only). */
    this.cookies = new Map();
    this.label = `${this.host}${address.port ? `:${address.port}` : ''}`;
  }

  get trust() {
    if (!this.secure) {
      return undefined;
    }
    return { pin: this.pin?.get(), onPin: (fp) => this.pin?.set(fp) };
  }

  headers(extra = {}) {
    const headers = { ...extra };
    if (this.cookies.size > 0) {
      headers.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    }
    return headers;
  }

  /** Keeps the cookies of a login answer (a few, short, plain ones only). */
  keepCookies(response) {
    const raw = response.headers?.['set-cookie'];
    const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
    for (const line of list.slice(0, 4)) {
      const match = /^\s*([A-Za-z0-9_.-]{1,64})=([\x21-\x3a\x3c-\x7e]{0,256})/.exec(String(line));
      if (match) {
        this.cookies.set(match[1], match[2]);
      }
    }
  }

  async send({
    method = 'GET',
    path,
    body,
    timeoutMs,
    contentType,
    startBy = Infinity,
    beforeSend,
  }) {
    // A write never leaves after its deadline, a login before it included.
    if (this.now() > startBy) {
      throw new MyPvError(ERROR_KINDS.LATE, 'Too late to send');
    }
    // The very last check of a command, right before its request leaves.
    runBeforeSend(beforeSend);
    const response = await this.transport({
      protocol: this.secure ? 'https' : 'http',
      host: this.host,
      port: this.port,
      path,
      method,
      headers: this.headers(contentType ? { 'Content-Type': contentType } : {}),
      body,
      timeoutMs,
      trust: this.trust,
    });
    if (!this.secure && response.status >= 300 && response.status <= 399) {
      const location = String(response.headers?.location ?? '');
      if (/^https:/i.test(location)) {
        throw new MyPvError(ERROR_KINDS.NEEDS_PASSWORD, 'The device asks for HTTPS');
      }
    }
    return response;
  }

  /** POST /auth.jsn: `{"auth": 1}` or the password is refused. */
  async login(timeoutMs, startBy) {
    this.cookies.clear();
    const response = await this.send({
      method: 'POST',
      path: PATHS.auth,
      body: `pw=${encodeURIComponent(this.password)}`,
      contentType: 'application/x-www-form-urlencoded',
      timeoutMs,
      startBy,
    });
    if (response.status === 429 || response.status >= 500) {
      throw statusError(response, this.now());
    }
    let ok = false;
    if (response.status === 200) {
      try {
        const answer = JSON.parse(response.body);
        ok = integerOf(answer?.auth) === 1;
      } catch {
        ok = false;
      }
    }
    if (!ok) {
      this.authed = false;
      throw new MyPvError(ERROR_KINDS.AUTH, 'Password refused');
    }
    this.keepCookies(response);
    this.authed = true;
  }

  /** A request, logged in first when a password is set; one new login on a 401. */
  async call(options) {
    if (this.secure && !this.authed) {
      await this.login(options.timeoutMs, options.startBy);
    }
    let response = await this.send(options);
    if (response.status === 401) {
      if (!this.secure) {
        throw new MyPvError(ERROR_KINDS.NEEDS_PASSWORD, 'HTTP 401', { status: 401 });
      }
      // The device lost the login (a 401 was not applied): one new login, one new try.
      this.authed = false;
      await this.login(options.timeoutMs, options.startBy);
      response = await this.send(options);
      if (response.status === 401) {
        // Logged in, refused again: never a third try.
        throw new MyPvError(ERROR_KINDS.AUTH, 'HTTP 401', { status: 401 });
      }
    }
    if (response.status < 200 || response.status > 299) {
      throw statusError(response, this.now());
    }
    return response;
  }

  /** GET /mypv_dev.jsn: { serial, firmware, name }. */
  async identify({ timeoutMs }) {
    const answer = plainOf(jsonOf(await this.call({ path: PATHS.identify, timeoutMs })));
    const serial = textOf(answer?.sn);
    if (!serial || !new RegExp(`^[0-9A-Za-z]{6,${LIMITS.serialLength}}$`).test(serial)) {
      throw new MyPvError(ERROR_KINDS.PROTOCOL, 'No serial number');
    }
    return { serial, firmware: textOf(answer.fwversion), name: textOf(answer.device) };
  }

  async readSetup({ timeoutMs }) {
    const answer = jsonOf(await this.call({ path: PATHS.setup, timeoutMs }));
    if (!plainOf(answer)) throw new MyPvError(ERROR_KINDS.PROTOCOL, 'Not an object');
    return answer;
  }

  async readData({ timeoutMs }) {
    const answer = jsonOf(await this.call({ path: PATHS.data, timeoutMs }));
    if (!plainOf(answer)) throw new MyPvError(ERROR_KINDS.PROTOCOL, 'Not an object');
    return answer;
  }

  /** setup.jsn?key=value (GET over HTTP, POST body over HTTPS): the echo of the settings. */
  async writeOnce(key, value, { timeoutMs, startBy, beforeSend }) {
    const pair = `${encodeURIComponent(key)}=${value}`;
    const response = this.secure
      ? await this.call({
          method: 'POST',
          path: PATHS.setup,
          body: pair,
          contentType: 'application/x-www-form-urlencoded',
          timeoutMs,
          startBy,
          beforeSend,
        })
      : await this.call({ path: `${PATHS.setup}?${pair}`, timeoutMs, startBy, beforeSend });
    let echo;
    try {
      echo = plainOf(JSON.parse(response.body));
    } catch {
      echo = undefined;
    }
    if (!echo) {
      throw new MyPvError(ERROR_KINDS.UNCONFIRMED, 'Answer is not the settings');
    }
    return { echo };
  }
}

/** The my-PV cloud API, a bearer token. */
export class CloudClient extends BaseClient {
  constructor({ serial, token, host = CLOUD_HOST, ...rest }) {
    super(rest);
    this.serial = serial;
    this.token = token;
    this.host = host;
    this.label = 'api.my-pv.com';
  }

  async call({ method = 'GET', path, body, timeoutMs, startBy = Infinity, beforeSend }) {
    if (this.now() > startBy) {
      throw new MyPvError(ERROR_KINDS.LATE, 'Too late to send');
    }
    runBeforeSend(beforeSend);
    const response = await this.transport({
      protocol: 'https',
      host: this.host,
      port: 443,
      path,
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body,
      timeoutMs,
      trust: 'verify',
    });
    if (response.status < 200 || response.status > 299) {
      throw statusError(response, this.now());
    }
    return response;
  }

  /** isOnline: the device is known by the cloud and online. */
  async identify({ timeoutMs }) {
    const answer = jsonOf(await this.call({ path: PATHS.cloudOnline(this.serial), timeoutMs }));
    if (answer?.isOnline !== true) {
      throw new MyPvError(ERROR_KINDS.OFFLINE, 'Device offline in the cloud');
    }
    return { serial: this.serial, firmware: undefined, name: undefined };
  }

  async readSetup({ timeoutMs }) {
    const answer = jsonOf(await this.call({ path: PATHS.cloudSetup(this.serial), timeoutMs }));
    const setup = answer && typeof answer === 'object' ? answer.setup : undefined;
    if (!plainOf(setup)) throw new MyPvError(ERROR_KINDS.PROTOCOL, 'No setup');
    return setup;
  }

  /** The measures, and the charge of the tank (a secondary endpoint: its failure is ignored). */
  async readData({ timeoutMs }) {
    const answer = jsonOf(await this.call({ path: PATHS.cloudData(this.serial), timeoutMs }));
    const data = plainOf(answer);
    if (!data) throw new MyPvError(ERROR_KINDS.PROTOCOL, 'Not an object');
    try {
      const soc = jsonOf(await this.call({ path: PATHS.cloudSoc(this.serial), timeoutMs }));
      const percentage = soc && typeof soc === 'object' ? soc.percentage : undefined;
      if (percentage !== undefined) {
        data.soc = percentage;
      }
    } catch (err) {
      if (err.kind === ERROR_KINDS.AUTH || err.kind === ERROR_KINDS.RATE_LIMITED) {
        throw err;
      }
    }
    return data;
  }

  /** PUT setup {"key": value}: the cloud answers "ok". */
  async writeOnce(key, value, { timeoutMs, startBy, beforeSend }) {
    const response = await this.call({
      method: 'PUT',
      path: PATHS.cloudSetup(this.serial),
      body: JSON.stringify({ [key]: value }),
      timeoutMs,
      startBy,
      beforeSend,
    });
    let answer;
    try {
      answer = JSON.parse(response.body);
    } catch {
      answer = undefined;
    }
    if (answer !== 'ok') {
      throw new MyPvError(ERROR_KINDS.UNCONFIRMED, 'Answer is not ok');
    }
    return { echo: undefined };
  }
}
