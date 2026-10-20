// -----------------------------------------------------------------------------
// Constants: the my-PV APIs, manifest keys, feature roles, limits and timings.
//
// Ported from py-mypv 0.0.14 (Apache-2.0, my-PV GmbH, the library of Home
// Assistant's my-PV integration), my_pv/connection.py:
//   local, firmware without a password: plain HTTP on port 80
//     GET  /mypv_dev.jsn            identification (sn, fwversion, device)
//     GET  /setup.jsn               the settings
//     GET  /data.jsn                the measures
//     GET  /setup.jsn?<key>=<value> one setting or command
//   local, firmware with a password: HTTPS on port 443 (a self-signed
//     certificate), POST /auth.jsn `pw=<password>` first (answer
//     {"auth": 1}), then the same paths, the writes as a POST body;
//   cloud: https://api.my-pv.com, `Authorization: Bearer <token>`
//     GET  /api/v1/device/<sn>/isOnline   {"isOnline": true}
//     GET  /api/v1/device/<sn>/setup      {"setup": {...}}
//     GET  /api/v1/device/<sn>/data       the measures
//     GET  /api/v1/device/<sn>/data/soc   {"percentage": ...}
//     PUT  /api/v1/device/<sn>/setup      {"<key>": <value>}, answer "ok"
// -----------------------------------------------------------------------------

export const LOCAL_HTTP_PORT = 80;
export const LOCAL_HTTPS_PORT = 443;
export const CLOUD_HOST = 'api.my-pv.com';

export const PATHS = {
  identify: '/mypv_dev.jsn',
  auth: '/auth.jsn',
  setup: '/setup.jsn',
  data: '/data.jsn',
  cloudOnline: (sn) => `/api/v1/device/${sn}/isOnline`,
  cloudSetup: (sn) => `/api/v1/device/${sn}/setup`,
  cloudData: (sn) => `/api/v1/device/${sn}/data`,
  cloudSoc: (sn) => `/api/v1/device/${sn}/data/soc`,
};

export const CONNECTIONS = ['local', 'cloud'];

/** The only keys this integration ever writes. */
export const WRITABLE = Object.freeze({
  /** Hot water target temperature, in tenths of °C. */
  TARGET: 'ww1target',
  /** Manual boost: 1 starts it, 0 stops it (py-mypv's `bststrt` command). */
  BOOST: 'bststrt',
});

/** Feature roles (the last part of the feature external ids): frozen. */
export const FEATURES = {
  STATUS: 'status',
  HEATING_POWER: 'heating-power',
  DEVICE_POWER: 'device-power',
  PV_POWER: 'pv-power',
  PV_VOLTAGE: 'pv-voltage',
  METER_POWER: 'meter-power',
  TEMP_1: 'temperature-1',
  TEMP_2: 'temperature-2',
  TEMP_3: 'temperature-3',
  TEMP_4: 'temperature-4',
  DEVICE_TEMP: 'device-temperature',
  CHARGE: 'hot-water-charge',
  HEATING_ENABLED: 'heating-enabled',
  BOOST_ACTIVE: 'boost-active',
  TARGET: 'target-temperature',
  BOOST_TARGET: 'boost-target-temperature',
  BOOST_START: 'boost-start',
  BOOST_STOP: 'boost-stop',
};

export const ACTIONS = {
  TEST_CONNECTION: 'test_connection',
  TRUST_CERTIFICATE: 'trust_certificate',
};

/** The value a `button/push` feature sends (BUTTON_PUSH.PRESSED of the core). */
export const PRESSED = 1;

/** The poll interval of the configuration, in seconds; never below 60 s on the cloud. */
export const POLL_INTERVAL = {
  min: 10,
  max: 600,
  default: 30,
  cloudMin: 60,
};

/**
 * The hot water ceiling, in °C (scalding risk): the configuration chooses it
 * between `min` and `max`, 55 °C by default; nothing above 60 °C is ever
 * set, whatever the configuration or the device would accept (95 °C).
 */
export const DHW_CAP = {
  min: 40,
  max: 60,
  default: 55,
};

/** The setpoint the slider offers and a command may set, in whole °C. */
export const SETPOINT = {
  min: 10,
};

export const LIMITS = {
  /** Gladys: 300 states per minute. */
  statesPerMinute: 300,
  statesPerRequest: 100,
  /** setup.jsn and data.jsn are a few KB; 64 KB is plenty. */
  responseBytes: 64 * 1024,
  /** Keys read from one answer (the rest is ignored). */
  answerKeys: 400,
  /** Longest text kept from an answer (firmware, model). */
  textLength: 40,
  /** A serial number: digits and letters, 32 characters at most. */
  serialLength: 32,
  /** A cloud token or a device password: longer is refused before sending. */
  secretLength: 512,
};

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

export const TIMINGS = {
  /** One request of the polling (py-mypv: 5 s in total, 1 s to connect, locally). */
  readTimeout: 5 * SECOND,
  cloudTimeout: 10 * SECOND,
  /** Failed reads: 30 s, 1, 2, then 5 minutes, never shorter than the interval. */
  backoff: [30 * SECOND, MINUTE, 2 * MINUTE, 5 * MINUTE],
  /** 429 or 5xx: a pause of Retry-After, 1 min .. 6 h, 5 min without one; kept in /data. */
  pauseMin: MINUTE,
  pauseMax: 6 * HOUR,
  pauseDefault: 5 * MINUTE,
  /** A refused password or token, a certificate that changed: tried again every hour at most. */
  blockedRetry: HOUR,
  /** An unknown model: read again every 30 minutes. */
  unsupportedRetry: 30 * MINUTE,
  /** The settings (setup) are read on every 6th poll (py-mypv's _SETUP_REFRESH_EVERY). */
  setupEvery: 6,
  /** The publisher sends what is pending every second; unchanged states again every 30 min. */
  flushInterval: SECOND,
  stateHeartbeat: 30 * MINUTE,
  /** The "Test the connection" button reads the device at most this often. */
  testCooldown: 10 * SECOND,
  /**
   * Commands (Gladys waits 5 s for the ack): the fresh read and the write
   * must leave by 3.5 s after the click, or the command is refused unsent;
   * the answer is awaited until 4.3 s, after which the command is "sent,
   * without confirmation".
   */
  commandSendBy: 3_500,
  commandAnswerBy: 4_300,
  /** The fresh read of a command: 2 s at most, and 0.3 s left to send after it. */
  commandReadMax: 2_000,
  commandMinRead: 300,
  commandMinSend: 300,
  /** A device busy answering 429 to a write: tried again every 250 ms, 10 tries at most (py-mypv). */
  busyRetry: 250,
  busyTries: 10,
  /** Reads after a command, spaced: its effect, then a check. */
  followUps: [5 * SECOND, 20 * SECOND],
  /** A sent command keeps its guard until a read shows what it asked, or 90 s. */
  guard: 90 * SECOND,
};
