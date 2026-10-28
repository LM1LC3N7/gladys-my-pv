# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [0.1.3] - 2026-10-28

### Changed

- Hot water ceiling raised to 65 °C (default 65 °C), device limits still apply.

## [0.1.2] - 2026-10-23

## [0.1.1] - 2026-10-21

### Added

- my-PV solar power diverters (AC•THOR, AC•THOR i, AC•THOR 9s, AC ELWA 2,
  SOL•THOR, HEA•THOR IoT), ported from py-mypv 0.0.14 (Apache-2.0, my-PV
  GmbH): local first, through the HTTP API of the device, or HTTPS with its
  password (a login, its cookie, one new login on a 401); the my-PV cloud API
  (serial number and token) as an option.
- One device keyed by the serial number (the same locally and through the
  cloud) with the status, heating power, solar power and voltage, meter power,
  temperatures 1 to 4, device temperature, hot water charge, heating enabled,
  boost running, and the hot water and boost setpoints. A republished device
  never loses a feature.
- Hot water setpoint and "Start the boost", both off by default behind their
  own option, capped (55 °C by default, configurable from 40 to 60 °C, never
  above 60 °C); a boost is refused while the boost setpoint of the device is
  above the ceiling. Decided on the settings read again just before, the
  options checked again right before the request leaves, sent within 3.5 s
  or refused unsent, "sent, without confirmation" when it may have reached the
  device, then read again 5 and 20 s later.
- "Stop the boost", always allowed: never refused by an option, a command in
  flight nor a 429/5xx pause (then one try); it withdraws a start not sent yet
  and is sent again once a start in flight settles.
- One request at a time to the device, commands before the reads; a write
  tried again while the device answers 429 (every 250 ms, within its
  deadline), as py-mypv.
- Refused password or token: reads stopped, kept in `/data`, a new try an hour
  later at most, at once with new credentials or "Test the connection". 429
  and 5xx: a pause of 1 min to 6 h (Retry-After), kept in `/data`.
- The self-signed certificate of the device pinned on first use: the password
  is never sent to another certificate; "Trust the new certificate" button.
- Status and Discovery sent again at every reconnection to Gladys; transport
  badge (local, cloud or unreachable).
- Documentation in English and French; `LICENSE` and `THIRD_PARTY_NOTICES.md`
  shipped in the image.

### Fixed

- Local HTTPS: the request now goes through the TLS connection whose
  certificate was checked; it went on a second, plain connection, so the
  password left in clear text and the mode never worked (gent: false
  made node ignore the pinned socket). Tested on a TLS server on the loopback.
- Cloud: a 429 to a command is never sent again and pauses every path (only
  the local device's 429 means "busy").
- A 401/403 to a write no longer stops the reads as "credentials refused";
  only a refused login, a device asking for a password or a changed
  certificate do, and "Stop the boost" never pushes that refusal further.
- Never a read sooner than the interval after the last one, even after a
  restart, a save or "Test the connection" (kept in /data); new
  credentials or a new address read at once.
- "Stop the boost" after a start that lands late: sent again with its own
  429 tries, and once more if a read still shows the boost within 90 s; it
  holds the gate when free, and a 429 it causes never pauses the
  integration (1 min without Retry-After locally).
- One absolute deadline for the login, the request and its new try: an ack
  never comes after the 5 s of Gladys.
- The boost ceiling checked again right before every try; the setpoints
  read outside 5 to 95 °C (py-mypv) are missing; the identity read at every
  local poll and needed by a command; the pause tied to its target; the 8
  newest certificate pins kept; IPv4 literals must be device addresses;
  /data read once per process; the device shown after a restart during a
  pause;
  pm audit fix (dev dependencies).

[Unreleased]: https://github.com/LM1LC3N7/gladys-my-pv/compare/v0.1.3...HEAD
[0.1.3]: https://github.com/LM1LC3N7/gladys-my-pv/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/LM1LC3N7/gladys-my-pv/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/LM1LC3N7/gladys-my-pv/releases/tag/v0.1.1
