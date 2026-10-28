// -----------------------------------------------------------------------------
// The integration: the my-PV device of the configuration (local first: its
// IP address; or the optional my-PV cloud: its serial number and a token),
// one read every poll interval, the Gladys device and its states, the
// transport badge, the buttons of the configuration screen, and the three
// commands. index.js only wires the SDK handlers.
//
// The commands follow the rules learnt on the previous modules:
//   - the hot water setpoint and "Start the boost" are refused unless their
//     option allows them (both off by default); the setpoint is never above
//     the configured ceiling (65 °C by default) nor 65 °C, and the boost is
//     refused when the boost setpoint of the device is above that ceiling;
//   - "Stop the boost" is protective: never refused by an option, a command
//     in flight nor a 429/5xx pause (then one try, no retry); it withdraws a
//     "Start the boost" that has not left yet, and is sent again once a start
//     that did leave settles;
//   - decided on settings read again just before (never the values kept in
//     memory), and refused when a value they need is missing;
//   - the options and the ceiling are checked on arrival, after the fresh
//     read and right before the request leaves (`beforeSend`);
//   - sent within 3.5 s of the click or refused unsent; answered by 4.3 s; a
//     request that may have reached the device (silence, a 5xx, an answer
//     that is not the expected one) is "sent, without confirmation", then
//     read again 5 and 20 s later; never retried, except while the device
//     answers 429 ("busy", not applied), as py-mypv does;
//   - the ack never waits for a publication to Gladys;
//   - one setpoint or start at a time.
// Errors: a refused password or token stops the reads (kept in /data, a new
// try every hour at most, at once when the configuration changes or on the
// "Test the connection" button); a 429 or a 5xx pauses every path but "Stop
// the boost" (Retry-After, 1 min to 6 h, kept in /data); other failures are
// tried again after 30 s to 5 min, never sooner than the interval.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { normalizeConfig, numberOf, targetKey } from './config.js';
import {
  DHW_CAP,
  FEATURES as F,
  PRESSED,
  MINUTE,
  SECOND,
  SETPOINT,
  TIMINGS,
  WRITABLE,
} from './constants.js';
import {
  COMMAND_ROLES,
  buildDevice,
  deviceIds,
  deviceStates,
  parseDeviceId,
  parseFeatureId,
  platformIdOf,
  reportedRoles,
} from './devices.js';
import { Gate } from './gate.js';
import { ERRORS, T, age, join, word } from './i18n.js';
import { decode, integerOf, modelOf, parseData, parseSetup } from './models.js';
import { CloudClient, LocalClient, errorReason } from './mypv/client.js';
import { ERROR_KINDS, notSent } from './mypv/http.js';
import { StatePublisher } from './publisher.js';
import { fileStore, normalizeMemory, setNewest } from './store.js';

/** A 429 of the local device this soon after one of our own requests: our own collision. */
const OWN_COLLISION = 5 * SECOND;

/** The kinds of refusal that stop the reads until a new try (kept in /data). */
const BLOCKING = new Set([ERROR_KINDS.AUTH, ERROR_KINDS.NEEDS_PASSWORD, ERROR_KINDS.TLS_CHANGED]);
/** The answers that pause every path but "Stop the boost". */
const PAUSING = new Set([ERROR_KINDS.RATE_LIMITED, ERROR_KINDS.SERVER]);

/** The value a guard watches in the decoded values. */
const WATCHED = {
  target: (v) => (v?.target === undefined ? undefined : Math.round(v.target * 10)),
  boost: (v) => v?.boostActive,
};

export class MyPvApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'my-pv' }),
    transport,
    now = Date.now,
    timers = globalThis,
    store = fileStore(),
    sleep,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.transport = transport;
    this.now = now;
    this.timers = timers;
    this.store = store;
    this.sleep = sleep;
    this.publisher = new StatePublisher({ gladys, logger, now, timers });
    this.config = normalizeConfig();
    this.memory = normalizeMemory(null, now());
    this.client = undefined;
    this.dev = undefined;
    this.gate = new Gate({ timers, now });
    this.generation = 0;
    this.started = false;
    this.lastStatus = undefined;
    this.published = undefined;
    this.badge = undefined;
    /** platform id -> the roles seen during this run (a feature never disappears). */
    this.seen = new Map();
    /** The setpoint or start in flight: { role, seq, sent, promise }. */
    this.inFlight = undefined;
    this.commandCount = 0;
    /** The number of the last "Stop the boost" (a start older than it gives way). */
    this.lastStop = 0;
    /** The number of the newest start that may have reached the device. */
    this.lastStartSent = 0;
    /** `${id}:target|boost` -> { from, expected, moved, until }: a command sent, not seen yet. */
    this.guards = new Map();
    /** /data is read once, at the first start: the memory is the truth afterwards. */
    this.loaded = false;
    /** When our last write to the device ended (a 429 right after it is ours). */
    this.ownWriteAt = -Infinity;
    /** Our writes in flight (a 429 to a read meanwhile is ours). */
    this.writing = 0;
    /** When the time of the last read was last written to /data, and its outcome then. */
    this.lastSavedAt = -Infinity;
    this.savedOk = undefined;
    /** "Stop the boost" wanted: { until, resent } (sent again once if a read shows the boost). */
    this.stopWanted = undefined;
  }

  // --- Lifecycle -------------------------------------------------------------

  get target() {
    return targetKey(this.config);
  }

  freshDevice() {
    return {
      serial: undefined,
      model: undefined,
      firmware: undefined,
      setup: undefined,
      data: undefined,
      values: undefined,
      online: undefined,
      failures: 0,
      wait: undefined,
      error: undefined,
      errorKind: undefined,
      unsupported: undefined,
      polls: 0,
      setupDue: true,
      timer: undefined,
      running: undefined,
      followUps: new Set(),
    };
  }

  makeClient() {
    const c = this.config;
    // undefined transport or sleep: the clients use the real ones.
    const common = { transport: this.transport, now: this.now, sleep: this.sleep };
    if (c.connection === 'cloud') {
      return c.serial && c.token
        ? new CloudClient({ serial: c.serial, token: c.token, ...common })
        : undefined;
    }
    if (!c.address) {
      return undefined;
    }
    const target = this.target;
    return new LocalClient({
      address: c.address,
      password: c.password,
      pin: {
        get: () => this.memory.pins[target],
        set: (fingerprint) => {
          setNewest(this.memory.pins, target, fingerprint);
          this.logger.info('my-PV: certificate of the device pinned (first connection)');
          this.saveMemory();
        },
      },
      ...common,
    });
  }

  async start(raw = {}) {
    const previous = this.dev;
    this.stop();
    await previous?.running;
    this.config = normalizeConfig(raw);
    if (!this.loaded) {
      // Once per process: later saves are never awaited, a new read of the
      // file could be older than the memory.
      this.memory = normalizeMemory(await this.store.load().catch(() => null), this.now());
      this.loaded = true;
      // Saved at most once a minute: the read may have been up to a minute
      // later than the file says (never later than now).
      if (this.memory.last) {
        this.memory.last.at = Math.min(this.now(), this.memory.last.at + MINUTE);
      }
    } else {
      this.memory = normalizeMemory(this.memory, this.now());
    }
    // A refusal kept in /data only applies to the same device or account.
    if (this.memory.block && this.memory.block.target !== this.target) {
      this.memory.block = null;
      await this.saveMemory();
    }
    this.client = this.makeClient();
    this.dev = this.client ? this.freshDevice() : undefined;
    if (this.dev && this.config.connection === 'cloud') {
      this.dev.serial = this.config.serial;
      this.dev.model = modelOf(this.config.serial);
    } else if (this.dev) {
      // The serial last read at this address: the device of "Stop the boost"
      // until the first read.
      this.dev.knownSerial = this.memory.serials[this.target];
    }
    // The last read of this target succeeded: the device is shown (status,
    // Discovery) from its serial kept, until the next read is due.
    const last = this.memory.last;
    const kept = this.memory.serials[this.target] ?? this.dev?.serial;
    if (this.dev && last?.target === this.target && last.ok && kept && modelOf(kept)) {
      this.dev.serial = kept;
      this.dev.model = modelOf(kept);
      this.dev.restored = true;
    }
    this.published = undefined;
    this.badge = undefined;
    this.lastStatus = undefined;
    this.publisher.start();
    if (!this.dev) {
      await this.publishAll();
      return;
    }
    await this.setStatus(false, T.connecting);
    await this.tick();
  }

  stop() {
    this.generation += 1;
    if (this.dev) {
      this.clearTimer();
      for (const handle of this.dev.followUps) {
        this.timers.clearTimeout(handle);
      }
      this.dev.followUps.clear();
    }
    this.publisher.stop();
  }

  clearTimer() {
    if (this.dev?.timer) {
      this.timers.clearTimeout(this.dev.timer);
      this.dev.timer = undefined;
    }
  }

  /**
   * Connected to Gladys. The first time, start; after a reconnection (Gladys
   * restarted), resend what Gladys keeps in memory only (status, Discovery
   * list, badge) and the last states. The client, the pause and the refusal stay.
   */
  async connected(raw = {}) {
    if (!this.started) {
      this.started = true;
      await this.start(raw);
      return;
    }
    if (this.needsRestart(raw)) {
      await this.start(raw);
      return;
    }
    this.config = normalizeConfig(raw);
    this.published = undefined;
    this.badge = undefined;
    this.lastStatus = undefined;
    this.gladys.forgetPublishedStates?.();
    await this.publishAll();
  }

  needsRestart(raw) {
    const next = normalizeConfig(raw);
    const c = this.config;
    return (
      next.connection !== c.connection ||
      next.pollInterval !== c.pollInterval ||
      JSON.stringify(next.address ?? null) !== JSON.stringify(c.address ?? null) ||
      next.serial !== c.serial ||
      next.password !== c.password ||
      next.token !== c.token ||
      JSON.stringify(next.invalid ?? null) !== JSON.stringify(c.invalid ?? null) ||
      next.badToken !== c.badToken
    );
  }

  /**
   * New credentials, address or interval restart, and a new password or
   * token is tried at once (the refusal kept is dropped). The options, the
   * ceiling and the language apply at once.
   */
  async configUpdated(raw = {}) {
    if (this.needsRestart(raw)) {
      const next = normalizeConfig(raw);
      const newCredentials =
        next.password !== this.config.password || next.token !== this.config.token;
      if (this.memory.block && (newCredentials || targetKey(next) !== this.memory.block.target)) {
        this.memory.block = null;
        await this.saveMemory();
      }
      if (newCredentials && this.memory.last) {
        // New credentials are tried at once; a new interval alone waits for
        // the last read + the new interval, a new address reads its target.
        this.memory.last = null;
        await this.saveMemory();
      }
      await this.start(raw);
      return;
    }
    const previous = this.config;
    this.config = normalizeConfig(raw);
    if (this.config.allowSetpoint !== previous.allowSetpoint) {
      this.logger.info(`my-PV setpoint ${this.config.allowSetpoint ? 'allowed' : 'disabled'}`);
    }
    if (this.config.allowBoost !== previous.allowBoost) {
      this.logger.info(`my-PV boost start ${this.config.allowBoost ? 'allowed' : 'disabled'}`);
    }
    if (this.config.language !== previous.language || this.config.dhwCap !== previous.dhwCap) {
      this.published = undefined;
      await this.publishAll();
    }
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  /**
   * The time of the last read goes to /data at most once a minute (an SD
   * card is not written at every poll), at once when its outcome changes. A
   * time read back from the file is moved forward by that minute (start).
   */
  saveLastRead() {
    const ok = this.memory.last?.ok;
    if (this.now() - this.lastSavedAt < MINUTE && ok === this.savedOk) {
      return;
    }
    this.lastSavedAt = this.now();
    this.savedOk = ok;
    this.saveMemory();
  }

  async saveMemory() {
    await this.store
      .save(this.memory)
      .catch((err) => this.logger.warn(`Saving the state to /data failed: ${err.message}`));
  }

  // --- Polling ---------------------------------------------------------------

  get interval() {
    return this.config.pollInterval * SECOND;
  }

  /** A pause of this target (the cloud's never stops the local device, nor the other way). */
  get paused() {
    const pause = this.memory.pause;
    return Boolean(pause && pause.target === this.target && this.now() < pause.until);
  }

  /** No read of this target before the last one + the interval (restarts and clicks included). */
  get due() {
    const last = this.memory.last;
    return last && last.target === this.target ? last.at + this.interval : -Infinity;
  }

  /** The refusal in force for this target, if any (even once its time to try again came). */
  get block() {
    const block = this.memory.block;
    return block && block.target === this.target ? block : undefined;
  }

  /** The next read: after the pause or the refusal, after the backoff, else the interval. */
  schedule(delay) {
    const dev = this.dev;
    this.clearTimer();
    let wait = delay ?? (dev.online === false ? dev.wait : this.interval);
    if (this.paused) {
      wait = Math.max(this.memory.pause.until - this.now(), this.interval);
    }
    const block = this.block;
    if (block) {
      wait = Math.max(block.until - this.now(), this.interval);
    }
    const generation = this.generation;
    dev.timer = this.timers.setTimeout(
      () => {
        dev.timer = undefined;
        if (generation === this.generation) {
          this.tick().catch(() => this.logger.error('my-PV refresh failed'));
        }
      },
      Math.max(0, wait ?? this.interval),
    );
  }

  /** One read at a time: a tick during a read joins it. */
  tick({ force = false, followUp = false } = {}) {
    const dev = this.dev;
    if (!dev) {
      return Promise.resolve();
    }
    if (!dev.running) {
      dev.running = this.run(dev, { force, followUp }).finally(() => {
        dev.running = undefined;
      });
    }
    return dev.running;
  }

  /** A read that starts now, never joining one begun before (after a command). */
  async freshTick() {
    if (this.dev?.running) {
      await this.dev.running.catch(() => {});
    }
    return this.tick({ followUp: true });
  }

  /** One request through the gate (one at a time to the device). */
  request(fn, options) {
    return this.gate.run(fn, options);
  }

  get timeout() {
    return this.config.connection === 'cloud' ? TIMINGS.cloudTimeout : TIMINGS.readTimeout;
  }

  /**
   * `force`: a click on "Test the connection" tries once even during a
   * refusal (a click, never a loop); a 429 pause is always waited out.
   */
  async run(dev, { force = false, followUp = false } = {}) {
    const generation = this.generation;
    const block = this.block;
    if (this.paused || (block && this.now() < block.until && !force)) {
      // Nothing read, but the device kept (Discovery, badge, status) is shown.
      await this.publishAll();
      if (generation === this.generation) {
        this.schedule();
      }
      return;
    }
    // Never sooner than the interval after the last read of this target,
    // whatever restarted or clicked; only the two reads after a command go
    // sooner (their effect, then a check).
    if (!followUp && this.now() < this.due) {
      await this.publishAll();
      if (generation === this.generation) {
        this.schedule(this.due - this.now());
      }
      return;
    }
    const previous = this.memory.last?.target === this.target ? this.memory.last : undefined;
    this.memory.last = { target: this.target, at: this.now(), ok: previous?.ok ?? false };
    this.saveLastRead();
    const timeoutMs = this.timeout;
    const local = this.config.connection === 'local';
    try {
      const full = dev.online !== true || dev.setupDue || dev.polls % TIMINGS.setupEvery === 0;
      // Locally the identification is read at every poll (one small request):
      // another device answering at the address is never shown as the first one.
      if (full || local) {
        const identity = await this.request(() => this.client.identify({ timeoutMs }));
        if (generation !== this.generation) return;
        this.identified(dev, identity);
      }
      if (full) {
        const raw = await this.request(() => this.client.readSetup({ timeoutMs }));
        if (generation !== this.generation) return;
        const setup = parseSetup(raw);
        if (
          setup?.serial &&
          dev.serial &&
          platformIdOf(setup.serial) !== platformIdOf(dev.serial)
        ) {
          dev.setup = undefined;
          dev.values = undefined;
          throw Object.assign(new Error('serial mismatch'), { kind: ERROR_KINDS.PROTOCOL });
        }
        dev.setup = setup;
        dev.setupDue = false;
      }
      const raw = await this.request(() => this.client.readData({ timeoutMs }));
      if (generation !== this.generation) return;
      this.applyRead(dev, dev.setup, parseData(raw, dev.model));
      dev.polls += 1;
    } catch (err) {
      if (generation !== this.generation) {
        return;
      }
      await this.failed(dev, err);
    }
    if (generation !== this.generation) {
      return;
    }
    await this.publishAll();
    if (generation === this.generation) {
      this.schedule();
    }
  }

  /** The identification of a read: the serial number gives the model. */
  identified(dev, { serial, firmware }) {
    const model = modelOf(serial);
    if (!model) {
      throw Object.assign(new Error('unsupported'), { unsupported: 'model', serial });
    }
    if (dev.serial && platformIdOf(dev.serial) !== platformIdOf(serial)) {
      // Another device answers at this address: what was read of the first one is dropped.
      this.logger.warn('my-PV: another device answers at this address');
      dev.setup = undefined;
      dev.data = undefined;
      dev.values = undefined;
    }
    dev.serial = serial;
    dev.model = model;
    if (firmware) {
      dev.firmware = firmware;
    }
    if (this.memory.serials[this.target] !== serial) {
      setNewest(this.memory.serials, this.target, serial);
      this.saveMemory();
    }
    dev.knownSerial = serial;
    dev.restored = false;
  }

  /** A read answered: the values, and the guards they may lift. */
  applyRead(dev, setup, data) {
    if (!data) {
      throw Object.assign(new Error('no data'), { kind: ERROR_KINDS.PROTOCOL });
    }
    const values = decode(dev.model, setup, data);
    dev.data = data;
    dev.values = values;
    if (values.firmware) {
      dev.firmware = values.firmware;
    }
    const wasBlocked = Boolean(this.memory.block);
    dev.online = true;
    dev.failures = 0;
    dev.wait = undefined;
    dev.error = undefined;
    dev.errorKind = undefined;
    dev.unsupported = undefined;
    dev.restored = false;
    this.observe(values);
    if (this.memory.last?.target === this.target) {
      this.memory.last.ok = true;
    }
    if (wasBlocked) {
      // Read again with these credentials: the refusal is over.
      this.memory.block = null;
      this.saveMemory();
    } else {
      this.saveLastRead();
    }
    this.stopIfStillRunning(values);
  }

  async failed(dev, err) {
    dev.online = false;
    if (this.memory.last?.target === this.target && this.memory.last.ok) {
      this.memory.last.ok = false;
      this.saveLastRead();
    }
    if (err.unsupported) {
      dev.unsupported = { kind: err.unsupported, serial: err.serial ?? dev.serial };
      dev.wait = Math.max(this.interval, TIMINGS.unsupportedRetry);
      dev.error = 'unsupported';
      this.logger.warn(`my-PV: unsupported device (${err.unsupported})`);
      return;
    }
    const reason = errorReason(err);
    dev.error = reason;
    dev.errorKind = err.kind;
    if (PAUSING.has(err.kind) && !this.ownCollision(err)) {
      await this.pause(err);
      this.logger.warn(`my-PV: ${reason}, pause`);
      return;
    }
    if (BLOCKING.has(err.kind)) {
      await this.blockFor(err.kind);
      this.logger.warn(`my-PV: ${err.kind}, reads stopped until a new try`);
      return;
    }
    // Never read again sooner than the interval.
    const wait = Math.max(
      this.interval,
      TIMINGS.backoff[Math.min(dev.failures, TIMINGS.backoff.length - 1)],
    );
    dev.failures += 1;
    dev.wait = wait;
    this.logger.warn(`my-PV: ${reason}; next try in ${Math.round(wait / 1000)} s`);
  }

  /**
   * A 429 of the local device just after one of our own writes (a stop goes
   * without waiting for the reads): the device was busy with us, read again at
   * the next interval, no pause.
   */
  ownCollision(err) {
    return (
      err.kind === ERROR_KINDS.RATE_LIMITED &&
      this.config.connection === 'local' &&
      (this.writing > 0 || this.now() - this.ownWriteAt < OWN_COLLISION)
    );
  }

  /**
   * A 429 or a 5xx: every path but "Stop the boost" waits, kept in /data for
   * this target. Retry-After, bounded to 1 min .. 6 h; without it, 1 min for
   * the local device (busy), 5 min for the cloud.
   */
  async pause(err) {
    const fallback = this.config.connection === 'local' ? TIMINGS.pauseMin : TIMINGS.pauseDefault;
    const wait = Math.min(
      TIMINGS.pauseMax,
      Math.max(TIMINGS.pauseMin, this.interval, err.retryAfter ?? fallback),
    );
    const previous = this.memory.pause?.target === this.target ? this.memory.pause.until : 0;
    const until = Math.max(previous, this.now() + wait);
    this.memory.pause = { target: this.target, until };
    await this.saveMemory();
  }

  /** Refused credentials (or a changed certificate): no read before the next try, kept in /data. */
  async blockFor(kind) {
    const target = this.target;
    if (!target) return;
    this.memory.block = { kind, target, until: this.now() + TIMINGS.blockedRetry };
    if (this.client) {
      this.client.authed = false;
    }
    await this.saveMemory();
  }

  // --- What the device gives ---------------------------------------------------

  /** Whether the values of the last read are current. */
  get live() {
    return Boolean(this.dev?.online === true && this.dev.values && this.dev.serial);
  }

  get platformId() {
    return this.dev?.serial ? platformIdOf(this.dev.serial) : undefined;
  }

  createdDevice(externalId) {
    return (this.gladys.devices ?? []).find((d) => d?.external_id === externalId);
  }

  /** Our created devices: [{ device, id }]. */
  ourDevices() {
    const list = [];
    for (const device of this.gladys.devices ?? []) {
      const id = parseDeviceId(device?.external_id);
      if (id && deviceIds(this.gladys, id).device === device.external_id) {
        list.push({ device, id });
      }
    }
    return list;
  }

  /** 'online', 'offline', 'other' (another device answers), or undefined while a first read runs. */
  standing(id) {
    if (this.live) {
      return id === this.platformId ? 'online' : 'other';
    }
    if (!this.dev || this.dev.online === false || this.paused || this.block) {
      return 'offline';
    }
    return undefined;
  }

  /** The roles of a device: those seen during this run, plus those the last read reports. */
  rolesFor(id) {
    const seen = this.seen.get(id) ?? new Set();
    if (id === this.platformId && this.dev?.values) {
      for (const role of reportedRoles(this.dev.values)) {
        seen.add(role);
      }
    }
    this.seen.set(id, seen);
    return seen;
  }

  // --- Gladys ----------------------------------------------------------------

  async publishAll() {
    await this.publishDevices();
    this.queueStates();
    await this.flush();
    await this.publishBadge();
    await this.updateStatus();
  }

  async flush() {
    await this.publisher
      .flush()
      .catch((err) => this.logger.warn(`Sending to Gladys failed: ${err.message}`));
  }

  /** The Discovery list: the device last identified (even unreachable now). */
  async publishDevices() {
    const dev = this.dev;
    // Also before the first read after a restart (the serial kept): the
    // features of the created device are sent again as they are.
    if (!dev?.serial || !dev.model) {
      return;
    }
    const id = platformIdOf(dev.serial);
    const device = buildDevice(
      this.gladys,
      {
        serial: dev.serial,
        model: dev.model,
        firmware: dev.firmware,
        connection: this.config.connection,
      },
      {
        roles: this.rolesFor(id),
        language: this.config.language,
        created: this.createdDevice(deviceIds(this.gladys, id).device),
      },
    );
    if (device.features.length === 0) {
      return;
    }
    const json = JSON.stringify([device]);
    if (json === this.published) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices([device]);
      this.published = json;
    } catch (err) {
      this.logger.warn(`Publishing the discovered devices failed: ${err.message}`);
    }
  }

  createdFeatures() {
    return new Set(
      (this.gladys.devices ?? []).flatMap((d) => (d.features ?? []).map((f) => f.external_id)),
    );
  }

  queueStates(created = this.createdFeatures()) {
    for (const { id } of this.ourDevices()) {
      const status = this.standing(id);
      if (status === undefined) {
        continue;
      }
      const states = deviceStates(
        deviceIds(this.gladys, id),
        status === 'online' ? this.dev.values : {},
        { status, language: this.config.language },
      );
      for (const { device_feature_external_id: featureId, ...value } of states) {
        if (created.has(featureId)) {
          this.publisher.push(featureId, value);
        }
      }
    }
  }

  async publishBadge() {
    const entries = [];
    const online =
      this.config.connection === 'cloud' ? DEVICE_TRANSPORTS.CLOUD : DEVICE_TRANSPORTS.LOCAL;
    for (const { device, id } of this.ourDevices()) {
      const status = this.standing(id);
      if (status === undefined) {
        continue;
      }
      entries.push({
        external_id: device.external_id,
        transport: status === 'online' ? online : DEVICE_TRANSPORTS.UNREACHABLE,
      });
    }
    const json = JSON.stringify(entries);
    if (entries.length === 0 || json === this.badge) {
      return;
    }
    try {
      await this.gladys.publishTransports(entries);
      this.badge = json;
    } catch (err) {
      this.logger.warn(`Transport badge failed: ${err.message}`);
    }
  }

  /** The connection status of the configuration screen. */
  async updateStatus() {
    const [connected, message] = this.status();
    await this.setStatus(connected, message);
  }

  withInvalid(message) {
    return this.config.invalid ? join([message, T.invalid(this.config.invalid)]) : message;
  }

  status() {
    const c = this.config;
    if (!this.client) {
      if (c.connection === 'cloud') {
        return [false, this.withInvalid(c.badToken ? T.badToken : T.noCloud)];
      }
      return [false, this.withInvalid(T.noHost)];
    }
    const dev = this.dev;
    const place = { connection: c.connection, label: this.client.label };
    const block = this.block;
    if (block) {
      return [false, T.blocked[block.kind](place, age(Math.max(0, block.until - this.now())))];
    }
    if (this.paused) {
      return [this.live, T.paused(age(this.memory.pause.until - this.now()))];
    }
    if (dev.online === false) {
      if (dev.unsupported) {
        return [
          false,
          dev.unsupported.kind === 'compmode'
            ? T.compmode(age(dev.wait))
            : T.unsupported(dev.unsupported.serial ?? '?', age(dev.wait)),
        ];
      }
      if (dev.errorKind === ERROR_KINDS.OFFLINE) {
        return [false, T.offline(age(dev.wait))];
      }
      return [false, T.unreachable(place, dev.error, age(dev.wait))];
    }
    if (!this.live) {
      if (dev.restored && dev.online === undefined) {
        // Restarted after a read that succeeded: shown connected until the next one.
        return [true, T.connected(dev.model.name, dev.serial, c.connection)];
      }
      return [false, T.connecting];
    }
    const notes = [];
    const created = this.ourDevices();
    if (created.length > 0 && !created.some((entry) => entry.id === this.platformId)) {
      notes.push(T.notes.otherDevice);
    }
    const target = dev.values.target;
    if (target !== undefined && target > Math.min(c.dhwCap, DHW_CAP.max)) {
      notes.push(T.notes.aboveCap(target, Math.min(c.dhwCap, DHW_CAP.max)));
    }
    return [true, T.connected(dev.model.name, dev.serial, c.connection, notes)];
  }

  /** A device was created (or updated): send its last values at once. */
  async deviceCreated(device) {
    this.badge = undefined;
    const created = this.createdFeatures();
    for (const f of device?.features ?? []) {
      created.add(f.external_id);
    }
    this.queueStates(created);
    await this.flush();
    await this.publishBadge();
    await this.updateStatus();
  }

  async deviceDeleted(device) {
    this.badge = undefined;
    if (typeof device?.external_id === 'string') {
      this.publisher.forget(device.external_id);
    }
  }

  /** The Discovery tab asks for a scan: the device of the last read, sent again. */
  async scan() {
    this.published = undefined;
    await this.publishDevices();
  }

  // --- Configuration buttons -----------------------------------------------------

  lastMessage() {
    return JSON.parse(this.lastStatus ?? '[false,null]')[1];
  }

  /** Reads the device now; once even during a refusal (a click). A 429 pause is waited out. */
  async testConnection() {
    if (!this.client) {
      return this.status()[1];
    }
    // Never sooner than the interval: the last state, and when the next read comes.
    if (this.now() < this.due) {
      const last = this.lastMessage();
      const next = T.test.notYet(age(this.due - this.now()));
      return last ? join([next, last]) : next;
    }
    if (this.dev.running) {
      await this.dev.running.catch(() => {});
    }
    await this.tick({ force: true });
    return this.lastMessage() ?? T.connecting;
  }

  /** "Trust the new certificate": forgets the pin of this device and reads it again. */
  async trustCertificate() {
    const target = this.target;
    // Only a certificate actually refused is forgotten: never a pin in use.
    if (!target || this.block?.kind !== ERROR_KINDS.TLS_CHANGED) {
      return T.trust.nothing;
    }
    delete this.memory.pins[target];
    this.memory.block = null;
    // A choice of the user, like new credentials: read now.
    this.memory.last = null;
    await this.saveMemory();
    this.logger.info('my-PV: the pinned certificate was forgotten by the user');
    if (this.dev) {
      await this.tick({ force: true });
    }
    return join([T.trust.done, this.lastMessage() ?? T.connecting]);
  }

  // --- The commands --------------------------------------------------------------

  refusal(text) {
    return new Error(word(text, this.config.language));
  }

  /**
   * The value of a command, checked strictly: a setpoint is a finite number
   * or a plain decimal text ('' and null are not 0), whole degrees, within
   * the ceiling; a button sends 1.
   */
  parseCommand(role, value) {
    if (role === F.BOOST_START || role === F.BOOST_STOP) {
      if (value === PRESSED || value === String(PRESSED)) {
        return { value: PRESSED };
      }
      throw this.refusal(ERRORS.badButton);
    }
    const number = numberOf(value);
    if (number === undefined) {
      throw this.refusal(ERRORS.badNumber);
    }
    if (!Number.isInteger(number)) {
      throw this.refusal(ERRORS.badStep);
    }
    const top = Math.min(this.config.dhwCap, DHW_CAP.max);
    if (number > DHW_CAP.max || number > this.config.dhwCap) {
      throw this.refusal(ERRORS.dhwCap(top));
    }
    if (number < SETPOINT.min) {
      throw this.refusal(ERRORS.outOfRange(SETPOINT.min, top));
    }
    return { value: number, word: number * 10 };
  }

  /** The option of a command, on the latest configuration ("Stop the boost" has none). */
  checkOption(role, wanted) {
    if (role === F.TARGET) {
      if (!this.config.allowSetpoint) {
        throw this.refusal(ERRORS.setpointDisabled);
      }
      // The ceiling may have been lowered since the command arrived.
      if (wanted.value > this.config.dhwCap || wanted.value > DHW_CAP.max) {
        throw this.refusal(ERRORS.dhwCap(Math.min(this.config.dhwCap, DHW_CAP.max)));
      }
    } else if (role === F.BOOST_START && !this.config.allowBoost) {
      throw this.refusal(ERRORS.boostDisabled);
    }
  }

  async setValue(_device, feature, value) {
    // The deadlines count from the arrival of the command, before any wait.
    const received = this.now();
    const target = parseFeatureId(feature?.external_id);
    if (!target || !COMMAND_ROLES.includes(target.role)) {
      throw this.refusal(ERRORS.readOnly);
    }
    const wanted = this.parseCommand(target.role, value);
    this.commandCount += 1;
    const seq = this.commandCount;
    if (target.role === F.BOOST_STOP) {
      return this.stopBoost(target, received, seq);
    }
    this.checkOption(target.role, wanted);
    if (this.inFlight) {
      throw this.refusal(ERRORS.stillRunning);
    }
    const entry = { role: target.role, seq, sent: false, promise: undefined };
    entry.promise = this.command(target, wanted, received, entry);
    this.inFlight = entry;
    try {
      return await entry.promise;
    } finally {
      if (this.inFlight === entry) {
        this.inFlight = undefined;
      }
    }
  }

  /**
   * The checks before sending, on the latest configuration: the option, the
   * ceiling, the device still the one read, no pause nor refusal, and no
   * "Stop the boost" since a start arrived.
   */
  checkBeforeSend(generation, { id, role }, wanted, entry) {
    this.checkOption(role, wanted);
    if (role === F.BOOST_START && this.lastStop > entry.seq) {
      throw this.refusal(ERRORS.stopMeanwhile);
    }
    // The boost heats up to the setpoint read just before: never above the
    // ceiling of now (it may have been lowered meanwhile).
    const cap = Math.min(this.config.dhwCap, DHW_CAP.max);
    if (role === F.BOOST_START && entry.boostTarget !== undefined && entry.boostTarget > cap) {
      throw this.refusal(ERRORS.boostAboveCap(entry.boostTarget, cap));
    }
    if (this.paused) {
      throw this.refusal(ERRORS.paused(age(this.memory.pause.until - this.now())));
    }
    if (this.block) {
      throw this.refusal(ERRORS.blocked);
    }
    if (generation !== this.generation || !this.live || id !== this.platformId) {
      throw this.refusal(ERRORS.unknownDevice);
    }
  }

  async command(target, wanted, received, entry) {
    const generation = this.generation;
    const sendBy = received + TIMINGS.commandSendBy;
    this.checkBeforeSend(generation, target, wanted, entry);
    const readBy = Math.min(this.now() + TIMINGS.commandReadMax, sendBy - TIMINGS.commandMinSend);
    if (readBy - this.now() < TIMINGS.commandMinRead) {
      throw this.refusal(ERRORS.tooSlow);
    }
    // The fresh read and the write hold the device together: no read of the
    // polling in between. Still waiting at readBy - minRead: refused unsent.
    let release;
    try {
      release = await this.gate.acquire({
        urgent: true,
        waitUntil: readBy - TIMINGS.commandMinRead,
      });
    } catch {
      throw this.refusal(ERRORS.tooSlow);
    }
    try {
      return await this.commandSession(target, wanted, {
        generation,
        received,
        sendBy,
        readBy,
        entry,
      });
    } finally {
      release();
    }
  }

  /** The reads of a command, just before acting (the gate is held). */
  async freshRead(role, readBy) {
    // One absolute deadline: a login or a new try inside never extends it.
    const setup = parseSetup(await this.client.readSetup({ answerBy: readBy }));
    if (this.now() > readBy) {
      throw Object.assign(new Error('late'), { kind: ERROR_KINDS.LATE });
    }
    let data = this.dev.data;
    if (role === F.BOOST_START) {
      data = parseData(await this.client.readData({ answerBy: readBy }), this.dev.model);
      if (this.now() > readBy) {
        throw Object.assign(new Error('late'), { kind: ERROR_KINDS.LATE });
      }
    }
    return { setup, data };
  }

  async commandSession(target, wanted, { generation, received, sendBy, readBy, entry }) {
    const { id, role } = target;
    const dev = this.dev;
    let fresh;
    try {
      fresh = await this.freshRead(role, readBy);
    } catch (err) {
      if (err.kind === ERROR_KINDS.LATE) {
        throw this.refusal(ERRORS.tooSlow);
      }
      await this.commandFailure(err);
      throw this.refusal(ERRORS.unknownState(errorReason(err)));
    }
    if (generation !== this.generation || this.dev !== dev || !this.live) {
      throw this.refusal(ERRORS.unknownDevice);
    }
    // Locally the settings carry the serial number: a command needs it, and
    // the one of the device (another device at the address is never driven).
    const serial = fresh.setup?.serial;
    if (!serial && this.config.connection === 'local') {
      throw this.refusal(ERRORS.noSerial);
    }
    if (serial && platformIdOf(serial) !== id) {
      throw this.refusal(ERRORS.unknownDevice);
    }
    let values;
    try {
      values = decode(dev.model, fresh.setup, fresh.data);
    } catch {
      throw this.refusal(ERRORS.unknownDevice);
    }
    dev.setup = fresh.setup;
    if (role === F.BOOST_START) {
      dev.data = fresh.data;
    }
    dev.values = values;
    this.observe(values);
    // Shown in the background: the ack never waits for Gladys.
    this.publishAll().catch((err) => this.logger.warn(`Publishing failed: ${err.message}`));

    const plan = this.plan(role, wanted, values, id);
    if (!plan) {
      return undefined;
    }
    entry.boostTarget = plan.boostTarget;
    // The options may have changed during the read: checked again.
    this.checkBeforeSend(generation, target, wanted, entry);
    if (this.now() > sendBy) {
      throw this.refusal(ERRORS.tooSlow);
    }
    this.logger.info(`my-PV ${role}: ${plan.key}=${plan.value}`);
    entry.sent = true;
    if (role === F.BOOST_START) {
      this.lastStartSent = Math.max(this.lastStartSent, entry.seq);
    }
    let result;
    this.writing += 1;
    try {
      result = await this.client.write(plan.key, plan.value, {
        startBy: sendBy,
        answerBy: received + TIMINGS.commandAnswerBy,
        // The very last check, right before each request leaves (tries included).
        beforeSend: () => this.checkBeforeSend(generation, target, wanted, entry),
      });
    } catch (err) {
      if (err.beforeSend) {
        entry.sent = false;
        throw err;
      }
      return this.writeFailed(err, { plan, entry });
    } finally {
      this.writing -= 1;
      this.ownWriteAt = this.now();
    }
    // Accepted (the settings echoed, or "ok"): the effect is checked by the reads after it.
    this.guard(id, plan);
    this.followUp();
    if (plan.kind === 'target' && result?.echo) {
      const echoed = integerOf(result.echo.ww1target);
      if (echoed !== undefined && echoed !== plan.value) {
        throw this.refusal(ERRORS.sentUnconfirmed('echo'));
      }
    }
    return undefined;
  }

  /** What to send, from the values just read; undefined when it is already so. */
  plan(role, wanted, values, id) {
    if (role === F.TARGET) {
      if (values.target === undefined) {
        throw this.refusal(ERRORS.missingValue);
      }
      const current = Math.round(values.target * 10);
      if (current === wanted.word && !this.guardActive(id, 'target')) {
        return undefined;
      }
      return { kind: 'target', key: WRITABLE.TARGET, value: wanted.word, from: current };
    }
    // Start the boost: only when the device has one now, and its setpoint is
    // under the ceiling (the boost heats up to it).
    if (values.devmode === undefined) {
      throw this.refusal(ERRORS.missingValue);
    }
    if (values.devmode !== 1 || !values.boostSupported) {
      throw this.refusal(ERRORS.boostUnavailable);
    }
    if (values.bstmode === undefined) {
      throw this.refusal(ERRORS.missingValue);
    }
    if (values.bstmode === 0) {
      throw this.refusal(ERRORS.boostUnavailable);
    }
    if (values.temps[0] === undefined || values.boostTarget === undefined) {
      throw this.refusal(ERRORS.missingValue);
    }
    const cap = Math.min(this.config.dhwCap, DHW_CAP.max);
    if (values.boostTarget > cap) {
      throw this.refusal(ERRORS.boostAboveCap(values.boostTarget, cap));
    }
    if (values.boostActive === 1 && !this.guardActive(id, 'boost')) {
      return undefined;
    }
    return {
      kind: 'boost',
      key: WRITABLE.BOOST,
      value: 1,
      from: values.boostActive,
      boostTarget: values.boostTarget,
    };
  }

  /** A failure of a read or a write of a command: the pause and the refusals apply to every path. */
  async commandFailure(err) {
    // A 429 the device gave because our own stop was at it: refused, no pause.
    if (PAUSING.has(err.kind) && !this.ownCollision(err)) {
      await this.pause(err);
      this.updateStatus().catch(() => {});
    } else if (BLOCKING.has(err.kind)) {
      await this.blockFor(err.kind);
      this.updateStatus().catch(() => {});
    }
  }

  /** A write that failed: never "not sent" once it may have reached the device. */
  async writeFailed(err, { plan, entry }) {
    const reason = errorReason(err);
    this.logger.warn(`my-PV ${plan.key} failed (${reason})`);
    if (notSent(err)) {
      entry.sent = false;
      throw this.refusal(err.kind === ERROR_KINDS.LATE ? ERRORS.tooSlow : ERRORS.notSent(reason));
    }
    if (this.refusesCredentials(err)) {
      // The login was refused: the write never left.
      entry.sent = false;
      await this.commandFailure(err);
      throw this.refusal(ERRORS.blocked);
    }
    if (err.kind === ERROR_KINDS.RATE_LIMITED) {
      // Not applied: still busy after the tries (local), or a rate limit of
      // the cloud, which pauses every path like a read.
      entry.sent = false;
      if (this.config.connection === 'cloud') {
        await this.pause(err);
        this.updateStatus().catch(() => {});
      }
      throw this.refusal(ERRORS.refused(reason));
    }
    if (err.kind === ERROR_KINDS.AUTH || (err.kind === ERROR_KINDS.HTTP && err.status < 500)) {
      // A refused write (a token without write access, a key refused): the
      // reads keep going.
      entry.sent = false;
      this.followUp();
      throw this.refusal(ERRORS.refused(reason));
    }
    // A 5xx, a silence, a cut connection, an answer that is not the expected
    // one: it may have reached the device.
    if (err.kind === ERROR_KINDS.SERVER) {
      await this.pause(err);
      this.updateStatus().catch(() => {});
    }
    this.guard(this.platformId, plan);
    this.followUp();
    throw this.refusal(ERRORS.sentUnconfirmed(reason));
  }

  /**
   * Only a refused login (a password `auth` 0), a device asking for a
   * password or a changed certificate stop the reads; a cloud token refused
   * on a read too (src/app.js failed). A 401/403 to a write never does.
   */
  refusesCredentials(err) {
    return (
      (err.kind === ERROR_KINDS.AUTH && err.login === true) ||
      err.kind === ERROR_KINDS.NEEDS_PASSWORD ||
      err.kind === ERROR_KINDS.TLS_CHANGED
    );
  }

  /**
   * "Stop the boost": never refused by an option, a command in flight nor a
   * pause (then one try, no retry). No fresh read: stopping is harmless.
   */
  async stopBoost({ id }, received, seq) {
    this.lastStop = Math.max(this.lastStop, seq);
    const known = this.dev?.serial ?? this.dev?.knownSerial;
    if (!this.client || !known || platformIdOf(known) !== id) {
      throw this.refusal(ERRORS.unknownDevice);
    }
    // Wanted for the time of a guard: a read that still shows the boost
    // (a start that landed late) sends it once more.
    this.stopWanted = { until: this.now() + TIMINGS.guard, resent: false };
    const running = this.inFlight?.role === F.BOOST_START ? this.inFlight : undefined;
    const plan = { kind: 'boost', key: WRITABLE.BOOST, value: 0, from: undefined };
    try {
      await this.sendStop(received);
    } finally {
      if (running) {
        this.stopAgain(running, seq);
      }
    }
    this.guard(id, plan);
    this.followUp();
    return undefined;
  }

  /**
   * One stop write. It never waits for the gate, but takes it when it is free
   * so that no read of the polling starts while it is at the device (which
   * would answer that read 429).
   */
  async writeStop({ startBy, answerBy }) {
    let release = this.gate.tryAcquire();
    this.writing += 1;
    try {
      return await this.client.write(WRITABLE.BOOST, 0, {
        startBy,
        answerBy,
        // During a pause: one try.
        retryBusy: !this.paused,
        // Before each try: the gate is taken as soon as it is free.
        beforeSend: () => {
          release ??= this.gate.tryAcquire();
        },
      });
    } finally {
      this.writing -= 1;
      this.ownWriteAt = this.now();
      release?.();
    }
  }

  async sendStop(received) {
    this.logger.info(`my-PV boost-stop: ${WRITABLE.BOOST}=0`);
    try {
      await this.writeStop({
        startBy: received + TIMINGS.commandSendBy,
        answerBy: received + TIMINGS.commandAnswerBy,
      });
    } catch (err) {
      const reason = errorReason(err);
      this.logger.warn(`my-PV boost-stop failed (${reason})`);
      // Classified on what happened to the request, whatever restarted meanwhile.
      if (notSent(err)) {
        throw this.refusal(err.kind === ERROR_KINDS.LATE ? ERRORS.tooSlow : ERRORS.notSent(reason));
      }
      if (this.refusesCredentials(err)) {
        // Never pushes a refusal in force further away.
        if (!this.block) {
          await this.commandFailure(err);
        }
        throw this.refusal(ERRORS.blocked);
      }
      if (err.kind === ERROR_KINDS.RATE_LIMITED) {
        if (this.config.connection === 'cloud') {
          await this.pause(err);
          this.updateStatus().catch(() => {});
        }
        this.followUp();
        throw this.refusal(ERRORS.refused(reason));
      }
      if (err.kind === ERROR_KINDS.AUTH || (err.kind === ERROR_KINDS.HTTP && err.status < 500)) {
        this.followUp();
        throw this.refusal(ERRORS.refused(reason));
      }
      if (err.kind === ERROR_KINDS.SERVER) {
        await this.pause(err);
        this.updateStatus().catch(() => {});
      }
      this.followUp();
      throw this.refusal(ERRORS.sentUnconfirmed(reason));
    }
  }

  /**
   * A stop that arrived while a start was in flight: once the start settles,
   * if it may have reached the device and no newer start left since, the
   * stop is sent once more, its 429 tried again within its own 3.5 s (one
   * try during a pause).
   */
  stopAgain(running, seq) {
    const generation = this.generation;
    running.promise
      .catch(() => {})
      .then(async () => {
        if (generation !== this.generation || !running.sent || this.lastStartSent > seq) {
          return;
        }
        if (this.lastStop > seq) {
          // A newer stop takes care of it.
          return;
        }
        this.logger.warn('my-PV: boost stop sent again after the start in flight');
        const now = this.now();
        await this.writeStop({
          startBy: now + TIMINGS.commandSendBy,
          answerBy: now + TIMINGS.commandAnswerBy,
        });
        this.followUp();
      })
      .catch((err) => this.logger.warn(`my-PV boost stop again failed (${errorReason(err)})`));
  }

  /**
   * A read that shows the boost running while a stop is wanted (within the
   * guard, no start sent after it): the stop is sent once more, logged.
   */
  stopIfStillRunning(values) {
    const wanted = this.stopWanted;
    if (!wanted || wanted.resent || this.now() >= wanted.until) {
      return;
    }
    if (values.boostActive !== 1 || this.lastStartSent > this.lastStop) {
      return;
    }
    wanted.resent = true;
    this.logger.warn('my-PV: the boost still runs after "Stop the boost": stop sent once more');
    const now = this.now();
    this.writeStop({
      startBy: now + TIMINGS.commandSendBy,
      answerBy: now + TIMINGS.commandAnswerBy,
    })
      .then(() => this.followUp())
      .catch((err) => this.logger.warn(`my-PV boost stop again failed (${errorReason(err)})`));
  }
  /** Reads after a command, spaced: its effect, then a check; the settings are read too. */
  followUp() {
    const dev = this.dev;
    const generation = this.generation;
    if (!dev) return;
    dev.setupDue = true;
    for (const delay of TIMINGS.followUps) {
      const handle = this.timers.setTimeout(() => {
        dev.followUps.delete(handle);
        if (generation === this.generation) {
          dev.setupDue = true;
          this.freshTick().catch(() => this.logger.error('my-PV refresh failed'));
        }
      }, delay);
      dev.followUps.add(handle);
    }
  }

  // --- Guards ----------------------------------------------------------------------

  /**
   * After a command, until a read shows it: a new command of the same kind is
   * always sent, never answered "already so" on a value that may not show the
   * previous one yet. The start value is kept: a read equal to it lifts
   * nothing until a move was seen.
   */
  guard(id, plan) {
    if (!id) return;
    this.guards.set(`${id}:${plan.kind}`, {
      from: plan.from,
      expected: plan.value,
      moved: plan.from === undefined,
      until: this.now() + TIMINGS.guard,
    });
  }

  guardActive(id, kind) {
    const key = `${id}:${kind}`;
    const guard = this.guards.get(key);
    if (guard && this.now() >= guard.until) {
      this.guards.delete(key);
      return false;
    }
    return Boolean(guard);
  }

  /** A read, through the guards: never lifted on an unknown value. */
  observe(values) {
    const id = this.platformId;
    for (const [kind, read] of Object.entries(WATCHED)) {
      if (!this.guardActive(id, kind)) {
        continue;
      }
      const value = read(values);
      if (value === undefined) {
        continue;
      }
      const guard = this.guards.get(`${id}:${kind}`);
      if (value !== guard.from) {
        guard.moved = true;
      }
      if (guard.moved && value === guard.expected) {
        this.guards.delete(`${id}:${kind}`);
      }
    }
  }
}
