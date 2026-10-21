# TODO

## Decisions

- **Version 0.1.0 set by hand** in `package.json`, `package-lock.json`, the
  manifest and the `docker_image` tag (`ghcr.io/lm1lc3n7/gladys-my-pv:0.1.0`):
  the first Release (patch) gives 0.1.1.
- **Reference**: py-mypv 0.0.14 (Apache-2.0, my-PV GmbH, the official library,
  used by Home Assistant), license read in its `LICENSE.md`. A young library
  (0.0.x): its model files and rules were ported as they are, nothing more is
  guessed. Credited in `THIRD_PARTY_NOTICES.md` (shipped in the image).
- **Local first**: `connection` defaults to `local`; the cloud is an option for
  a device not on the network. Same device external id in both
  (`my-pv:<serial in lower case>`).
- **Two options, both off**: `allow_setpoint` and `allow_boost`. Hot water
  ceiling 55 °C by default, 40 to 60 °C, never above 60 °C (`DHW_CAP`), checked
  on arrival, after the fresh read and in `beforeSend`. The slider stops at
  60 °C; whole degrees only.
- **The boost heats up to `ww1boost`**, set on the device: a start is refused
  while `ww1boost` (read just before) is above the ceiling, rather than
  writing `ww1boost` (one more setting written, kept read only in v1).
- **"Stop the boost" is protective**: no option, no gate (it never waits for a
  read or a command), not refused by a 429/5xx pause (one try, no 429 retry
  then), withdraws a start not sent yet (`lastStop` > its number), sent again
  once when a start that may have left settles. No fresh read: stopping is
  harmless. Refused only when the device was never identified (or another
  serial was last seen at the address).
- **Buttons, never switches** (`button/push`); boost running and heating
  enabled are read-only `unknown/binary`; devmode (device on/off) is read only
  in v1: turning it on would be a sensitive command for little use.
- **429 on a write**: locally the device is busy, not applied: tried again
  every 250 ms, 10 tries at most, never after the deadline (py-mypv), no
  pause. Through the cloud it is a rate limit: one try, and the pause (as
  py-mypv, which never retries there). A 429 or a 5xx on a read pauses
  (1 min to 6 h, `/data`, tied to its target; 1 min without Retry-After
  locally), except a local 429 right after one of our own writes.
- **Never sooner than the interval** (review 1, I3): the start of the last read
  per target is kept in `/data`; restarts, saves and the button wait for it.
  New credentials, a new address, "Trust the new certificate" read at once;
  the two reads after a command (5 and 20 s) are the only exception.
- **Identity**: `/mypv_dev.jsn` at every local poll, the `serialno` of the
  settings compared at each read and required by a command (local).
- **"Stop the boost"** takes the gate when it is free (never waits); sent again
  once if a read shows the boost running within the 90 s guard.
- **`/data` read once per process** (later saves are not awaited).
- **Credentials refused** (password, token, a device asking for HTTPS without a
  password, a certificate that changed): reads stopped, kept in `/data` for
  that target only (`local:<host>:<port>` / `cloud:<serial>`), a new try an
  hour later at most; a new password or token clears it at once; "Test the
  connection" tries once (a click, never a loop) once the interval passed.
  Only a refused login (`auth` 0) means a wrong password: a 401 after an
  accepted login or a 401/403 to a write is a refused request. The password and token are
  never written in `/data` (not even a hash).
- **TLS**: py-mypv does not check the self-signed certificate of the device;
  here it is pinned on first use (fingerprint in `/data`), handshake checked
  before the request is written. The cloud certificate must be valid.
- **Units**: only those of `DEVICE_FEATURE_UNITS_BY_CATEGORY`. The meter power
  ("surplus", sign undocumented) and the HEA•THOR `power_grid` are
  `unknown/decimal`, the unit in the name. The hot water charge is
  `water-heater/remaining-hot-water` (%). No energy index: the device gives
  none, so the guard of gladys-p1-monitor is not needed.
- **Polling**: 30 s locally, 60 s at least through the cloud; the settings and
  the identification on every 6th poll (py-mypv), after a failure and after
  a command.
- **Validator**: `npx --yes github:GladysAssistant/integration-store .` cannot
  be run by the development agent (sandbox): to run in the real terminal
  before publishing.

## Later

- Electrical values (voltages and currents per phase, frequency), the Wi-Fi
  signal, the latest firmware available: in the py-mypv files, not shown yet.
- Writing the boost setpoint (`ww1boost`, capped like `ww1target`), device
  on/off (`devmode`, off protective, on behind an option), the maximum power.
- Discovery of the device on the network (py-mypv has none; my-PV devices
  answer a UDP broadcast): to look at.
- Test with a real device and a real cloud account; check the sign of
  `surplus` and the meaning of `power_grid` on the HEA•THOR.
