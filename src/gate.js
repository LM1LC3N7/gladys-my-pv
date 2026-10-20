// -----------------------------------------------------------------------------
// One request at a time to the device, as py-mypv serializes them (its
// request lock): a my-PV device answers 429 to a request that arrives while
// another one runs. A command waiting for its turn goes before the reads of
// the polling ("writes always wait for their turn" in py-mypv), and gives up
// at its deadline (LATE: nothing was sent). "Stop the boost" does not use the
// gate: it never waits.
// -----------------------------------------------------------------------------

import { ERROR_KINDS, MyPvError } from './mypv/http.js';

export class Gate {
  constructor({ timers = globalThis, now = Date.now } = {}) {
    this.timers = timers;
    this.now = now;
    this.busy = false;
    this.waiting = [];
  }

  /** A release function (idempotent) once it is our turn. */
  acquire({ urgent = false, waitUntil } = {}) {
    if (!this.busy) {
      this.busy = true;
      return Promise.resolve(this.releaser());
    }
    return new Promise((resolve, reject) => {
      const entry = { urgent, resolve, timer: undefined };
      if (waitUntil !== undefined) {
        entry.timer = this.timers.setTimeout(
          () => {
            const index = this.waiting.indexOf(entry);
            if (index >= 0) {
              this.waiting.splice(index, 1);
              reject(new MyPvError(ERROR_KINDS.LATE, 'Device busy: not sent in time'));
            }
          },
          Math.max(0, waitUntil - this.now()),
        );
      }
      if (urgent) {
        const firstRead = this.waiting.findIndex((e) => !e.urgent);
        this.waiting.splice(firstRead === -1 ? this.waiting.length : firstRead, 0, entry);
      } else {
        this.waiting.push(entry);
      }
    });
  }

  releaser() {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const next = this.waiting.shift();
      if (!next) {
        this.busy = false;
        return;
      }
      if (next.timer) {
        this.timers.clearTimeout(next.timer);
      }
      next.resolve(this.releaser());
    };
  }

  /** Runs `fn` on its turn. */
  async run(fn, options) {
    const release = await this.acquire(options);
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
