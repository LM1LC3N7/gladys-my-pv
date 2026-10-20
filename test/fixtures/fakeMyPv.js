// -----------------------------------------------------------------------------
// A fake my-PV device (local API, HTTP or HTTPS with a password) and a fake
// my-PV cloud, behind the transport the integration is given. The answers are
// shaped like py-mypv reads them (made up, never captured from a real
// device). Writes change the device like it is expected to and answer the
// settings. Records every request. No network. Delays use setTimeout, so the
// mocked clock drives them.
// -----------------------------------------------------------------------------

import { CLOUD_HOST } from '../../src/constants.js';
import { ERROR_KINDS, MyPvError } from '../../src/mypv/http.js';

export const HOST = '192.168.1.80';
export const SERIAL = '2001001234567890';
export const TOKEN = 'tok-1234567890abcdef';
export const PASSWORD = 'p@ss word&=1';
export const FINGERPRINT = Array.from({ length: 32 }, () => 'AB').join(':');
export const OTHER_FINGERPRINT = Array.from({ length: 32 }, () => 'CD').join(':');
export const NOW = Date.UTC(2026, 9, 20, 18, 0, 0);

/** An AC•THOR heating the tank, boost mode on, boost setpoint 55 °C. */
export function acThor(over = {}) {
  return {
    identity: { sn: SERIAL, fwversion: 'a0021300', device: 'AC-THOR' },
    setup: {
      devmode: 1,
      bstmode: 1,
      ww1target: 500,
      ww1boost: 550,
      mainmode: 1,
      serialno: SERIAL,
      fwversion: 'a0021300',
    },
    data: {
      power_act: 1200,
      surplus: -350,
      temp1: 482,
      temp2: 0,
      temp_ps: 351,
      soc: 64,
      screen_mode_flag: 1,
      boostactive: 0,
      fwversion: 'a0021300',
    },
    ...over,
  };
}

const answer = (status, body = '', headers = {}) => ({
  status,
  headers,
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The writes a device understands: the setting changes, a boost start/stop changes the data. */
function apply(device, key, value) {
  if (device.applies === false) return;
  if (key === 'bststrt') {
    device.data.boostactive = value;
    device.data.screen_mode_flag = value ? 2 : 1;
  } else {
    device.setup[key] = value;
  }
}

/**
 * `device`: see acThor(). The test may set on it: `password` (HTTPS and a
 * login), `fingerprint`, `down`, `silent`, `readDelay`, `writeDelay`,
 * `status` ({ path: HTTP status }), `headers` (of those answers), `busy`
 * (number of 429 answers to writes), `applies` (false: a write changes
 * nothing), `writeBody` (raw answer of a write), `redirect` (HTTP redirects
 * to HTTPS), `writeSilent`.
 * `cloud`: { token, online, device } for api.my-pv.com.
 */
export function fakeMyPv({ device = acThor(), cloud } = {}) {
  const server = {
    device,
    cloud,
    /** { protocol, host, port, path, method, headers, body } */
    requests: [],
    sessions: 0,
    paths: () => server.requests.map((r) => `${r.method} ${r.path}`),
    writes: () =>
      server.requests
        .filter(
          (r) =>
            (r.path.startsWith('/setup.jsn') && (r.path.includes('?') || r.method === 'POST')) ||
            r.method === 'PUT',
        )
        .map((r) => (r.method === 'PUT' ? r.body : (r.path.split('?')[1] ?? r.body))),
    async transport(options) {
      const { protocol, host, path, method, headers = {}, body, timeoutMs, trust } = options;
      server.requests.push({ protocol, host, port: options.port, path, method, headers, body });
      if (host === CLOUD_HOST) {
        return server.cloudAnswer(options);
      }
      const d = server.device;
      if (host !== HOST || d.down) {
        throw new MyPvError(ERROR_KINDS.UNREACHABLE, 'Unreachable: ECONNREFUSED');
      }
      if (protocol === 'https') {
        if (!d.password) {
          throw new MyPvError(ERROR_KINDS.UNREACHABLE, 'Unreachable: ECONNREFUSED');
        }
        const fingerprint = d.fingerprint ?? FINGERPRINT;
        if (trust?.pin && trust.pin !== fingerprint) {
          throw new MyPvError(ERROR_KINDS.TLS_CHANGED, 'The certificate of the device changed');
        }
        if (!trust?.pin) {
          trust?.onPin?.(fingerprint);
        }
      } else if (d.password || d.redirect) {
        return answer(302, '', { location: `https://${HOST}${path}` });
      }
      const isWrite =
        (path.startsWith('/setup.jsn') && path.includes('?')) ||
        (path === '/setup.jsn' && method === 'POST');
      const delay = isWrite ? d.writeDelay : d.readDelay;
      if (d.silent || (isWrite && d.writeSilent) || (delay ?? 0) >= timeoutMs) {
        await wait(timeoutMs);
        throw new MyPvError(ERROR_KINDS.TIMEOUT, 'Connected but silent: timeout');
      }
      if (delay) {
        await wait(delay);
      }
      const bare = path.split('?')[0];
      if (d.status?.[bare]) {
        return answer(d.status[bare], 'error', d.headers ?? {});
      }
      if (bare === '/auth.jsn' && method === 'POST') {
        const pw = new URLSearchParams(body).get('pw');
        if (pw === d.password) {
          server.sessions += 1;
          d.session = `s${server.sessions}`;
          return answer(200, { auth: 1 }, { 'set-cookie': [`sid=${d.session}; Path=/; HttpOnly`] });
        }
        return answer(200, { auth: 0 });
      }
      if (d.password && headers.Cookie !== `sid=${d.session}`) {
        return answer(401, { msg: 'unauthorized' });
      }
      if (bare === '/mypv_dev.jsn') return answer(200, d.identity);
      if (bare === '/data.jsn') return answer(200, d.body ?? d.data);
      if (bare === '/setup.jsn' && !isWrite) return answer(200, d.setup);
      if (isWrite) {
        if (d.busy > 0) {
          d.busy -= 1;
          return answer(429, 'busy');
        }
        const pair = method === 'POST' ? body : path.split('?')[1];
        const [key, value] = pair.split('=');
        apply(d, decodeURIComponent(key), Number(value));
        return answer(200, d.writeBody ?? d.setup);
      }
      return answer(404, 'Not found');
    },
    async cloudAnswer({ path, method, headers = {}, body, timeoutMs }) {
      const c = server.cloud;
      if (!c || c.down) {
        throw new MyPvError(ERROR_KINDS.UNREACHABLE, 'Unreachable: ENOTFOUND');
      }
      if (c.silent) {
        await wait(timeoutMs);
        throw new MyPvError(ERROR_KINDS.TIMEOUT, 'Connected but silent: timeout');
      }
      if (c.status) {
        return answer(c.status, { msg: 'error' }, c.headers ?? {});
      }
      if (headers.Authorization !== `Bearer ${c.token}`) {
        return answer(401, { msg: 'Unauthenticated.' });
      }
      const base = `/api/v1/device/${SERIAL}`;
      const d = c.device;
      if (path === `${base}/isOnline`) return answer(200, { isOnline: c.online !== false });
      if (path === `${base}/setup` && method === 'GET') return answer(200, { setup: d.setup });
      if (path === `${base}/data`) return answer(200, d.data);
      if (path === `${base}/data/soc`) {
        return c.socDown ? answer(500, 'x') : answer(200, { percentage: 71, ts: 'now' });
      }
      if (path === `${base}/setup` && method === 'PUT') {
        const pairs = Object.entries(JSON.parse(body));
        for (const [key, value] of pairs) apply(d, key, value);
        // The JSON string "ok".
        return answer(200, JSON.stringify(c.writeBody ?? 'ok'));
      }
      return answer(404, { msg: 'not found' });
    },
  };
  return server;
}

export const settle = async (rounds = 20) => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};
