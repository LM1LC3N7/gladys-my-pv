# gladys-my-pv

A [Gladys Assistant](https://gladysassistant.com) external integration for
**my-PV** solar power diverters: AC•THOR, AC•THOR i, AC•THOR 9s, AC ELWA 2,
SOL•THOR and HEA•THOR IoT. Local first (the HTTP API of the device, with its
password over HTTPS when it has one); the my-PV cloud API is optional.

Unofficial, not affiliated with my-PV. **Never tested with a real device.**

- Read: status, heating power, solar power and voltage (SOL•THOR), meter
  power ("surplus"), temperatures 1 to 4, device temperature, hot water
  charge, heating enabled, boost running, hot water and boost setpoints.
- Commands, off by default: the hot water setpoint and "Start the boost",
  capped (65 °C by default, never above 65 °C; a boost is refused while the
  boost setpoint of the device is above the ceiling). "Stop the boost" is
  always allowed, even during a 429 pause.
- Errors: refused credentials stop the reads (kept in `/data`, a new try an
  hour later at most); 429/5xx pause every path but the stop (kept in
  `/data`); the device certificate is pinned on first use; the password and
  the token never appear in a log, a status nor `/data`.

User guide: [English](docs/en.md), [français](docs/fr.md).

## Credits

The protocol and the model rules are ported from
[py-mypv](https://github.com/my-pv/py-mypv) 0.0.14, the official library of
my-PV GmbH (Apache-2.0), used by Home Assistant. See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Development

Node.js 22 or later.

```bash
npm install
npm run format:check
npm run lint
npm test
npm audit --omit=dev
npx --yes github:GladysAssistant/integration-store .   # store admission checks
npm run cover                                          # regenerates cover.png
```

The tests run against the fake Gladys of the SDK and a fake my-PV device
(`test/fixtures/fakeMyPv.js`); they never touch the network. Versions are set
by the Release workflow (Actions → Release); `CHANGELOG.md` keeps the changes
under `## [Unreleased]`. Project rules: [CLAUDE.md](CLAUDE.md); decisions and
what is left: [TODO.md](TODO.md).

## License

Apache-2.0, see [LICENSE](LICENSE).
