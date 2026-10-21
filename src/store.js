// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container), bounded when read back:
//   - the end of a 429/5xx pause (never more than 6 h away), so a restart
//     never asks a device or the cloud that asked to slow down before its time;
//   - a refusal (password or token refused, a device asking for a password,
//     a certificate that changed), for the target it applies to, with the time
//     of the next try (never more than 1 h away): a restart never loops on
//     refused credentials;
//   - the certificate fingerprint pinned per device address (trust on first use);
//   - the serial number last read per target (the device of the "Stop the
//     boost" button, the status and the Discovery before the first read
//     after a restart);
//   - when the last read of the target started (no read sooner than the
//     interval, whatever restarts or clicks).
// Never a password, a token nor a cookie. The file is readable by the
// container user only (0600).
// -----------------------------------------------------------------------------

import { readFile, rename, writeFile } from 'node:fs/promises';
import { TIMINGS } from './constants.js';

export const STATE_FILE = '/data/my-pv-state.json';

export const BLOCK_KINDS = ['auth', 'needs_password', 'certificate_changed'];

export function fileStore(path = STATE_FILE) {
  // One write at a time: two saves never share the temporary file.
  let chain = Promise.resolve();
  return {
    async load() {
      try {
        return JSON.parse(await readFile(path, 'utf8'));
      } catch {
        return null;
      }
    },
    save(data) {
      const text = JSON.stringify(data);
      const write = chain.then(async () => {
        const temporary = `${path}.tmp`;
        await writeFile(temporary, text, { mode: 0o600 });
        await rename(temporary, path);
      });
      chain = write.catch(() => {});
      return write;
    },
  };
}

/** For the tests: the same JSON round trip as the file. */
export function memoryStore(initial = null) {
  return {
    data: initial === null ? null : JSON.parse(JSON.stringify(initial)),
    saves: 0,
    async load() {
      return this.data === null ? null : JSON.parse(JSON.stringify(this.data));
    },
    async save(data) {
      this.data = JSON.parse(JSON.stringify(data));
      this.saves += 1;
    },
  };
}

const TARGET = /^(local:[0-9a-z.-]{1,253}:\d{1,5}|cloud:[0-9a-z]{6,32})$/;
const FINGERPRINT = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;
const SERIAL = /^[0-9A-Za-z]{6,32}$/;

/** A map of own keys, the 8 newest entries (the last ones written), keys and values checked. */
function mapOf(raw, keyPattern, valuePattern) {
  const out = Object.create(null);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return out;
  }
  const valid = Object.entries(raw).filter(
    ([key, value]) => keyPattern.test(key) && typeof value === 'string' && valuePattern.test(value),
  );
  for (const [key, value] of valid.slice(-8)) {
    out[key] = value;
  }
  return out;
}

/**
 * Sets one entry of such a map as the newest one (moved last), so the
 * current target is never the one dropped past 8 entries.
 */
export function setNewest(map, key, value) {
  delete map[key];
  map[key] = value;
}

/**
 * The persisted state, repaired and bounded:
 * `{ pause: { target, until } | null, block: { kind, target, until } | null,
 *    last: { target, at, ok } | null, pins: { [target]: fingerprint },
 *    serials: { [target]: serial } }`. `last`: the start of the last read
 * of a target (never in the future), so that no restart, save or button reads
 * sooner than the interval; `ok`: it succeeded (the status and the Discovery
 * are shown from the serial kept, before the next read).
 */
export function normalizeMemory(raw, now) {
  const object = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const pause = object.pause;
  const until = pause?.until;
  const block = object.block;
  const last = object.last;
  return {
    pause:
      Number.isFinite(until) &&
      until > now &&
      typeof pause.target === 'string' &&
      TARGET.test(pause.target)
        ? { target: pause.target, until: Math.min(until, now + TIMINGS.pauseMax) }
        : null,
    last:
      last &&
      typeof last === 'object' &&
      typeof last.target === 'string' &&
      TARGET.test(last.target) &&
      Number.isFinite(last.at)
        ? { target: last.target, at: Math.min(last.at, now), ok: last.ok === true }
        : null,
    block:
      block &&
      typeof block === 'object' &&
      BLOCK_KINDS.includes(block.kind) &&
      typeof block.target === 'string' &&
      TARGET.test(block.target) &&
      Number.isFinite(block.until)
        ? {
            kind: block.kind,
            target: block.target,
            until: Math.min(Math.max(block.until, now), now + TIMINGS.blockedRetry),
          }
        : null,
    pins: mapOf(Object.hasOwn(object, 'pins') ? object.pins : undefined, TARGET, FINGERPRINT),
    serials: mapOf(Object.hasOwn(object, 'serials') ? object.serials : undefined, TARGET, SERIAL),
  };
}
