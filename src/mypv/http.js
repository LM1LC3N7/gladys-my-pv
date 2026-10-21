// -----------------------------------------------------------------------------
// The only network access of the integration: one HTTP/1.1 request on
// node:http or node:https (no keep-alive, no redirect followed, bounded time
// and size). Resolves { status, headers, body } for any status; every
// transport failure becomes a MyPvError whose kind says whether the request
// may have reached the device:
//   - 'unreachable': nothing accepted the connection (TLS included): nothing
//     was sent, for sure;
//   - 'timeout': connected, then silent or cut: it may have been received.
//
// TLS:
//   - the cloud (api.my-pv.com): a certificate valid for the host name, as
//     any browser checks it;
//   - a device with a password: it serves a self-signed certificate (py-mypv
//     does not check it at all). Trust on first use instead: the SHA-256
//     fingerprint of the first certificate is pinned (kept in /data), and a
//     different one later is refused until the user trusts it again (button
//     "Trust the new certificate"). The handshake is checked BEFORE the
//     request is written: the password never reaches another device.
//
// A host name is resolved to IPv4 unicast addresses only; IPv4 literals are
// checked by the configuration (src/config.js, isUnicastIPv4).
// -----------------------------------------------------------------------------

import { lookup as dnsLookup } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { LIMITS } from '../constants.js';

export const ERROR_KINDS = Object.freeze({
  /** Nothing accepted the connection. Nothing was sent. */
  UNREACHABLE: 'unreachable',
  /** Connected, then silent or cut: the request may have been received. */
  TIMEOUT: 'timeout',
  /** An HTTP status that is not handled more precisely (`status` holds it). */
  HTTP: 'http',
  /** 429 (`retryAfter` in ms when given). */
  RATE_LIMITED: 'rate_limited',
  /** 5xx (`status`, `retryAfter`). */
  SERVER: 'server_error',
  /** Too large, not JSON, not the expected shape. */
  PROTOCOL: 'protocol',
  /** The password or the token was refused. */
  AUTH: 'auth',
  /** The device asks for HTTPS (a password is set on it): none configured. */
  NEEDS_PASSWORD: 'needs_password',
  /** The certificate of the device is not the one pinned. Nothing was sent. */
  TLS_CHANGED: 'certificate_changed',
  /** The cloud certificate does not validate. Nothing was sent. */
  TLS_UNTRUSTED: 'certificate_untrusted',
  /** The time a command was given ran out before its request: nothing was sent. */
  LATE: 'late',
  /** A write answered 200 without the expected confirmation: received, maybe applied. */
  UNCONFIRMED: 'unexpected_answer',
  /** The cloud says the device is offline. */
  OFFLINE: 'offline',
});

export class MyPvError extends Error {
  constructor(kind, message, details = {}) {
    super(message);
    this.name = 'MyPvError';
    this.kind = kind;
    for (const [key, value] of Object.entries(details)) {
      this[key] = value;
    }
  }
}

/** Whether a failure says for sure that nothing reached the device. */
export const notSent = (err) =>
  err?.notSent === true ||
  [
    ERROR_KINDS.UNREACHABLE,
    ERROR_KINDS.LATE,
    ERROR_KINDS.TLS_CHANGED,
    ERROR_KINDS.TLS_UNTRUSTED,
  ].includes(err?.kind);

/**
 * An IPv4 unicast address a device can have: not 0/8, 127/8 (loopback),
 * 224/4 multicast nor 240/4 (reserved, 255.255.255.255 included), nor an
 * address ending in .255 (the broadcast of a home /24).
 */
export function isUnicastIPv4(address) {
  if (net.isIP(address) !== 4) {
    return false;
  }
  const [a, , , d] = address.split('.').map(Number);
  return a !== 0 && a !== 127 && a < 224 && d !== 255;
}

/** A `lookup` for node:http: IPv4 only, unicast addresses only. */
export function unicastLookup(resolve = dnsLookup) {
  return (hostname, options, callback) => {
    resolve(hostname, { family: 4, all: true }, (err, addresses) => {
      if (err) {
        callback(err);
        return;
      }
      const usable = (addresses ?? []).filter((a) => isUnicastIPv4(a?.address));
      if (usable.length === 0) {
        callback(Object.assign(new Error('Not a unicast address'), { code: 'ENOTUNICAST' }));
        return;
      }
      if (options?.all) {
        callback(
          null,
          usable.map((a) => ({ address: a.address, family: 4 })),
        );
      } else {
        callback(null, usable[0].address, 4);
      }
    });
  };
}

const TLS_ERRORS = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_SIGNATURE_FAILURE',
]);

/**
 * @param {object} options
 * @param {'http'|'https'} options.protocol
 * @param {string} options.host
 * @param {number} options.port
 * @param {string} options.path
 * @param {'GET'|'POST'|'PUT'} [options.method]
 * @param {Record<string, string>} [options.headers]
 * @param {string} [options.body]
 * @param {number} options.timeoutMs the whole exchange
 * @param {'verify'|{ pin: string | undefined, onPin: (fingerprint: string) => void }} [options.trust]
 *   https only: 'verify' (a valid certificate), or trust on first use with a pin.
 * @returns {Promise<{ status: number, headers: object, body: string }>}
 */
export function request({
  protocol,
  host,
  port,
  path,
  method = 'GET',
  headers = {},
  body,
  timeoutMs,
  trust = 'verify',
}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let connected = false;
    let req;
    let socket;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        req?.destroy();
        socket?.destroy();
        reject(error);
      } else {
        // Connection: close: the pinned TLS socket is never kept either.
        socket?.destroy();
        resolve(value);
      }
    };
    const failure = (err) => {
      const code = String(err?.code ?? '');
      if (TLS_ERRORS.has(code)) {
        return new MyPvError(ERROR_KINDS.TLS_UNTRUSTED, `Certificate refused (${code})`);
      }
      return connected
        ? new MyPvError(ERROR_KINDS.TIMEOUT, `Connection lost: ${code || 'error'}`)
        : new MyPvError(ERROR_KINDS.UNREACHABLE, `Unreachable: ${code || 'error'}`);
    };
    // A plain (ref'd) timer: the exchange keeps the process alive until it ends.
    const timer = setTimeout(() => {
      finish(
        connected
          ? new MyPvError(ERROR_KINDS.TIMEOUT, 'Connected but silent: timeout')
          : new MyPvError(ERROR_KINDS.UNREACHABLE, 'Unreachable: timeout'),
      );
    }, timeoutMs);

    const send = (createConnection) => {
      const payload = body === undefined ? undefined : Buffer.from(body, 'utf8');
      const options = {
        method,
        host,
        port,
        path,
        headers: {
          Connection: 'close',
          Accept: 'application/json, text/plain, */*',
          ...headers,
          ...(payload ? { 'Content-Length': String(payload.length) } : {}),
        },
      };
      let lib = protocol === 'https' ? https : http;
      if (createConnection) {
        // The pinned TLS socket. Never with gent: false: node then ignores
        // createConnection and opens a second, plain TCP connection (the
        // password would leave in clear text).
        lib = http;
        options.createConnection = createConnection;
      } else if (protocol === 'https') {
        options.agent = false;
        options.servername = net.isIP(host) ? undefined : host;
        options.rejectUnauthorized = true;
        options.lookup = unicastLookupOr(host);
      } else {
        options.agent = false;
        options.lookup = unicastLookupOr(host);
      }
      req = lib.request(options, (res) => {
        connected = true;
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > LIMITS.responseBytes) {
            finish(new MyPvError(ERROR_KINDS.PROTOCOL, 'Answer too large'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () =>
          finish(null, {
            status: res.statusCode ?? 0,
            headers: res.headers ?? {},
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
        res.on('error', (err) => finish(failure(err)));
      });
      req.on('socket', (s) => {
        if (createConnection || !s.connecting) {
          connected = true;
          return;
        }
        s.once(lib === https ? 'secureConnect' : 'connect', () => {
          connected = true;
        });
      });
      req.on('error', (err) => finish(failure(err)));
      req.end(payload);
    };
    const safeSend = (createConnection) => {
      try {
        send(createConnection);
      } catch (err) {
        // A header node refuses (an invisible character): a failure, nothing sent.
        finish(new MyPvError(ERROR_KINDS.UNREACHABLE, `Not sent: ${err.code ?? 'error'}`));
      }
    };

    if (protocol !== 'https' || trust === 'verify') {
      safeSend();
      return;
    }
    // Trust on first use: handshake first, check the fingerprint, then write.
    socket = tls.connect({
      host,
      port,
      servername: net.isIP(host) ? undefined : host,
      rejectUnauthorized: false,
      lookup: unicastLookupOr(host),
    });
    socket.once('error', (err) => finish(failure(err)));
    socket.once('secureConnect', () => {
      const fingerprint = String(socket.getPeerCertificate()?.fingerprint256 ?? '').toUpperCase();
      if (!fingerprint) {
        finish(new MyPvError(ERROR_KINDS.TLS_CHANGED, 'No certificate'));
        return;
      }
      const pin = trust.pin ? String(trust.pin).toUpperCase() : undefined;
      if (pin && pin !== fingerprint) {
        finish(new MyPvError(ERROR_KINDS.TLS_CHANGED, 'The certificate of the device changed'));
        return;
      }
      if (!pin) {
        trust.onPin?.(fingerprint);
      }
      safeSend(() => socket);
    });
  });
}

const lookup = unicastLookup();
/** The unicast lookup for a host name; none needed for an IP literal. */
const unicastLookupOr = (host) => (net.isIP(host) ? undefined : lookup);
