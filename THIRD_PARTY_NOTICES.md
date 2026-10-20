# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). It
contains logic ported to JavaScript from the project below. The ported parts
were rewritten, not copied; the changes are described below.

## py-mypv (my-PV)

<https://github.com/my-pv/py-mypv> (package `my-PV` on PyPI, version 0.0.14,
the official library of my-PV GmbH, used by Home Assistant's my-PV
integration), by my-PV GmbH, Austria. Apache License 2.0 (`LICENSE.md` of the
repository; the repository has no `NOTICE` file). The full text of the
license is the one in `LICENSE` of this repository. Its notice, as it heads
every source file:

```
Copyright 2026 my-PV GmbH, Austria.

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```

Its `README.md` reads "Copyright 2026 my-PV GmbH".

Ported in `src/constants.js`, `src/models.js` and `src/mypv/client.js`
(`my_pv/connection.py`, `my_pv/__init__.py`, `my_pv/configs/*.json`): the
local API (`/mypv_dev.jsn`, `/setup.jsn`, `/data.jsn`, writes as
`/setup.jsn?key=value` over HTTP or a POST body over HTTPS), the login of the
HTTPS firmware (`POST /auth.jsn` `pw=…`, `{"auth": 1}`) and its one new login
on a 401; the cloud API (`api.my-pv.com/api/v1/device/<sn>/isOnline`,
`/setup`, `/data`, `/data/soc`, `PUT /setup` answered `"ok"`, a bearer
token); the models by the first 6 digits of the serial number and their
heating power keys; the keys, dividers and units of the configuration files
(temperatures in tenths of °C, `ww1target` and `ww1boost` in tenths, the
solar voltage in mV); the status texts (`screen_mode_flag`); the rules that
hide or remove settings (a temperature read 0 is missing, no boost without
temperature sensor 1 nor on an AC•THOR in main mode 5 or 6, device mode off
and boost mode off, AC ELWA 2 compatibility modes not supported); the manual
boost command (`bststrt`); the settings read on every 6th poll; one request
at a time, writes before reads, and a write tried again while the device
answers 429 (every 250 ms, 10 tries at most).

Changed: the HTTP client is our own (`src/mypv/http.js`: bounded time and
size, no redirect followed, unicast addresses only); the self-signed
certificate of the device is pinned on first use instead of not being checked
at all, so the password never reaches another device; a write is never tried
again after its deadline, and only on 429; a refused login is not retried
until an hour later (or a new password); a 429 or a 5xx pauses the reads
(kept across restarts); only the keys shown are read; values out of a
plausible range are missing; the hot water setpoint is capped (55 °C by
default, 60 °C at most), the boost is refused while the boost setpoint of the
device is above that ceiling, and each command reads the settings again right
before writing; the firmware update, factory reset, reboot, legionella and
network settings of py-mypv are not ported.
