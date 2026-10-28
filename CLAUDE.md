# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration** for my-PV solar power diverters: a
Node.js service (Node 22+, ESM, no build step) that runs in its own sandboxed
Docker container and talks to Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. The my-PV logic is ported from py-mypv
(Apache-2.0, see `THIRD_PARTY_NOTICES.md`).

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npx github:GladysAssistant/integration-store .   # store admission checks
npm run cover                             # cover.png, 800x534, plain Node
```

The CI runs `format:check`, `lint` and `test` on Node 22 and 24, and builds the
Docker image.

## Architecture

```
index.js               SDK wiring only
src/handlers.js        the SDK handlers (shared with the end-to-end tests)
src/app.js             polling, Gladys publication, status, buttons, commands
src/config.js          DEFAULT_CONFIG (mirrors the manifest) + normalization
src/constants.js       APIs, feature roles, limits, timings
src/models.js          py-mypv models and rules, decoding (pure)
src/devices.js         the Gladys device and its states (pure)
src/gate.js            one request at a time to the device
src/mypv/http.js       the only network access (bounded, TLS pinning)
src/mypv/client.js     local (HTTP/HTTPS) and cloud clients
src/store.js           /data: pause, refusal, certificate pin, last serial
src/publisher.js       states within 300 per minute
src/i18n.js            runtime texts, English and French
test/fixtures/         fake my-PV device and cloud
```

## Rules

- **External ids are forever**: `my-pv:<serial in lower case>` and the feature
  roles of `FEATURES`. Never rename one. A republished device never loses a
  feature (`keepCreatedFeatures`).
- **Hot water**: the setpoint and the boost start stay off by default, behind
  their own option, capped by `DHW_CAP` (65 °C default, 65 °C max), checked on
  arrival, after the fresh read and in `beforeSend`. "Stop the boost" is never
  blocked (option, command in flight, pause). Never a `switch` nor a writable
  `binary`.
- **Commands** decide on settings read again just before, refuse a missing
  value, leave within 3.5 s or not at all, and are never announced "not sent"
  once they may have left ("sent, without confirmation").
- **Secrets**: the password, the token and the cookies never go in a log, a
  status, an error or `/data`. A secret field is "kept by Gladys in its
  database, never shown again": Gladys stores it in clear, so no text may
  claim otherwise (`test/encoding.test.js` checks it).
- **Errors**: refused credentials stop the reads (kept in `/data`, one new
  try an hour); 429/5xx pause every path but the stop (kept in `/data`, 1 min
  to 6 h); never read sooner than the interval.
- **Units** only from the core's `DEVICE_FEATURE_UNITS_BY_CATEGORY`.
- **Versions belong to the Release workflow**; `CHANGELOG.md` under
  `## [Unreleased]`.
- **User-facing text** is bilingual (English and French), kept in sync; files
  are UTF-8 without BOM (`test/encoding.test.js`).
- **Style**: Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network.
