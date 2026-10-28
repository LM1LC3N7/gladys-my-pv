# my-PV

Shows your my-PV solar power diverter in Gladys: AC•THOR, AC•THOR i,
AC•THOR 9s, AC ELWA 2, SOL•THOR, HEA•THOR IoT (Viessmann, Greenheiss and
Tuxhorn versions included). The logic is ported from
[py-mypv](https://github.com/my-pv/py-mypv), the official library of my-PV
(Apache-2.0), used by Home Assistant.

Unofficial integration, not affiliated with my-PV. **Never tested with a real
device**: the answers were rebuilt from py-mypv. Your feedback is welcome.

## What you get

One device per diverter, with, depending on what your model gives:

- the status (standby, heating, boost, heating finished, error, block…);
- the heating power (W); the solar power and voltage (SOL•THOR);
- the meter power ("surplus", in W, as the device gives it: my-PV does not
  document its sign);
- temperatures 1 to 4 (sensor 1 is the tank one) and the device temperature;
- the hot water charge (%);
- heating enabled, boost running (read only);
- the hot water setpoint and the boost setpoint;
- the "Start the boost" and "Stop the boost" buttons.

There is no energy index: the device gives none.

## Connection: local first

1. Give the device a fixed IP address in your router.
2. In the configuration of the integration, leave **Connection** on "Local"
   and enter the **IP address**.
3. If the web interface of the device asks for a password (recent firmware,
   HTTPS), enter it in **Password of the device**. It is kept by Gladys in its
   database, never shown again, and sent only to your device. The device shows
   a self-signed certificate: at the first connection the integration keeps
   its fingerprint, then refuses any other certificate (the password is then
   not sent). If you replace or reset the device, use the **Trust the new
   certificate** button.
4. Save, then add the device from the **Discovery** tab.

Without a password the local API has no protection at all: keep the device
on a trusted network.

### The my-PV cloud (optional)

Only if the device is not on your network: choose "my-PV cloud", enter the
**serial number** (shown on live.my-pv.com) and a **token** created in your
my-PV account. The token is kept by Gladys in its database, never shown
again, sent only to api.my-pv.com and never written in the logs. Through the
cloud the device is read once a minute at most. The device keeps the same id
locally and through the cloud: switching keeps its history.

## Hot water commands (off by default)

Scalding risk: hot water is **capped at 65 °C by default** (from 40 to 65 °C,
**never more than 65 °C**, whatever is typed).

- **Allow the hot water setpoint**: Gladys may change the setpoint (whole
  degrees, from 10 °C to the ceiling).
- **Allow starting the boost**: Gladys may start a manual boost (heating from
  the grid up to the boost setpoint set on the device). It is refused when
  that boost setpoint is above the ceiling, when the boost mode is off on the
  device, when the device is off or has no sensor 1, or in space heating mode
  (AC•THOR).
- **Stop the boost** is always allowed, without option, even while the device
  asks to slow down (then one try). It withdraws a start not sent yet, and is
  sent once more when a start was in flight, or when a read still shows the
  boost running (within 90 s).

Locally, a command needs the settings of the device to give its serial number
(`serialno`): if your firmware does not, the commands are refused with a
message that says so (please report it, with the firmware version).

Each command reads the settings again just before acting, checks the options
and the ceiling again right before sending, leaves within 3.5 s or is refused
unsent. A command that may have reached the device without a clear answer is
"sent, without confirmation", then the device is read again 5 and 20 s later.
One setpoint or start at a time.

The buttons and the setpoint are never switches: a "turn everything off" of a
voice assistant or a scene never reaches them.

The legionella programme of the device (which may heat higher) is not
controlled by Gladys: set it on the device.

## Errors and limits

- Password or token refused: the reads stop (kept in /data), a new try once
  an hour at most, at once when you change the password or the token, or with
  **Test the connection**. A refused command (401/403 to a write) never stops
  the reads.
- 429 or a server error: reads and commands paused (Retry-After, 1 min to
  6 h, 1 min without Retry-After locally, kept in /data), except "Stop the
  boost". Through the cloud, a 429 to a command is never sent again and
  pauses too.
- Never a read sooner than the interval, even after a restart, a save or a
  click on **Test the connection** (only a new address, password or token
  reads at once).
- Device unreachable: a new try after 30 s to 5 min, never sooner than the
  interval.
- An AC ELWA 2 in an AC ELWA-E compatibility mode is not supported (as in
  py-mypv).

## Troubleshooting

**Test the connection** reads the device and shows its state (or, before the
interval, the last state and when the next read comes). The logs of the
integration never hold a password, a token nor a cookie.
