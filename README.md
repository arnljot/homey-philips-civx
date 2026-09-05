# Philips Civx RF — Homey Pro app

Drive a **Philips Civx** LED ceiling fan (DC motor, proprietary 433 MHz RF
remote) from a **Homey Pro** by replaying the remote's decoded RF codes over
Homey's built-in 433 MHz radio.

All 19 remote buttons are captured and verified by physical replay. The app
discovers your own fan's address during pairing, so it works on any unit, and
your original handset keeps working.

See **`CLAUDE.md`** for the working context, or **`docs/protocol.md`** for the
protocol spec.

## Layout

```
app.json                   Homey app manifest (signals, capabilities, driver, flow)
app.js                     app entry point
lib/codes.js               the 7 fan frames, plus the receiver's distortion model
lib/pairing.js             address-agnostic frame building, all 20 button ids
drivers/civx-fan/          the driver, the device, and the custom pairing views
locales/                   en + no strings, including the pairing flow
assets/                    app icon and images
CLAUDE.md                  agent context — read first

docs/protocol.md           full RF protocol spec
docs/codes.json            machine-readable codes + timing
captures/                  original Flipper Zero .sub recordings
local/img/                 local untracked folder to hold product photos, remote button map, function table
local/manuals/             local untracked folder to hold Philips installation manual, safety sheet, datasheet

tools/rxtest.js            offline tests for the driver and both device roles
tools/pairtest.js          offline tests for the pairing search
tools/check_codes.js       every capture against the frame structure and BUTTON_IDS
tools/check_views.js       pairing-view syntax, API misuse, and locale keys
tools/timing_stats.js      re-derive symbol timings from the captures
tools/decode_sub.py        re-decode new .sub captures
```

The remaining files in `tools/` are one-off analysis scripts kept for
reproducibility: fitting the receiver's distortion model, bounding the matching
tolerance, and measuring the address candidate sets.

## Install on your own Homey Pro

```sh
npm install -g homey     # Homey CLI
homey login              # interactive, opens a browser
homey app run            # run from your PC, live logs, nothing installed
homey app install        # install permanently onto the Homey
```

`homey app run` is the one to use while testing: it streams `this.log()` output
to your terminal and stops when you press Ctrl-C.

## Adding your fan

Every Civx learns its own remote, so each unit answers to a different 24-bit
address. Homey cannot simply read that address off the air — its receiver
distorts this remote's signal, and the distortion is many-to-one. What it can do
is narrow the possibilities and then ask you.

1. Switch the fan's light **off** with your remote, and stand where you can see
   it.
2. Hold **1** and **2** on the remote together, close to Homey, until the
   counter fills.
3. Homey switches the light on and off across batches of candidate addresses and
   asks after each one whether the light is on. About nine questions; roughly
   half the answers are "no", which is normal.
4. Both devices — the fan and the light — are offered together at the end.

If the lamp is dead or removed, the probe page offers to use the fan instead.
That path is slower, because the blades have to be given time to stop between
questions.

## Devices

Pairing adds **two** devices on one address, because a zone action reaches
devices by class: "turn all lights off" never reaches a device of class `fan`.

### Ceiling fan (class `fan`)

- **`onoff`** — Power. On re-sends the last speed used (or the speed chosen in
  settings). Off sends the remote's centre button.
- **Speed 1 - Speed 6** — six direct-select buttons mirroring the 1-6 ring on
  the remote. They behave as a radio group: the active speed stays highlighted,
  and turning the fan back on re-lights whichever speed it was last running at.
  Tapping one also turns the fan on.
- **Reverse**, **Sleep wind**, **Timer 1h / 3h / 6h** — momentary buttons. None
  of these has a readable state, so they light on press and clear again.

### Ceiling light (class `light`)

- **`onoff`** — Light on / off.
- **Warm white / Natural white / Day white** — the three fixed shades, as a
  radio group.
- **Brighter / Dimmer** — one brightness step per press.

There is deliberately **no dimmer slider**. The remote has only relative +/-
steps, there is no absolute-level command, and the lamp cannot be read back, so
a 0-100 % figure would be an invented number presented as a measurement.

## Settings (Device -> Advanced)

- **App version / Running since / Fan address** — read-only. The address is the
  one pairing found, so it can be checked rather than taken on trust.
- **Repetitions per press** (default 8) — the original remote sends 5. Raise it
  when the fan is far from the Homey and drops commands.
- **Signal timing variant** — `Capture-exact` reproduces the recording. Only
  switch to `Trailing pulse` if the fan does not react at all; see below.
- **Speed used when turned on** (default 3) — used only when Homey has no
  previous speed stored.
- **Follow the physical remote** (default on) — Homey listens on 433 MHz for the
  original remote and follows it.

## Flow cards

### Trigger: The physical remote was used

Fires when Homey overhears the original Philips remote. The fastest way to check
that 433 MHz reception is working. Only the fan device triggers it; reception
identifies the seven fan buttons only.

| Tag | Type | Values |
|---|---|---|
| `button` | string | `Power`, `Speed 1` … `Speed 6` |
| `speed` | number | `0` when the fan was switched off, otherwise `1`-`6` |

`Power` is the remote's centre button, which is a dedicated off — so `button` is
`Power` exactly when `speed` is `0`.

### Action: Set the fan speed

Selects a speed step and updates the tracked device state, exactly as tapping
the button would.

| Argument | Values |
|---|---|
| `speed` | `1`, `2`, `3`, `4`, `5`, `6` |

### Action: Send a remote button code

Transmits any one of the 19 codes. This is the card for buttons with no tile of
their own, and for range testing.

| Argument | Values | Default |
|---|---|---|
| `button` | see the table below | — |
| `update_state` | checkbox | ticked |

**`update_state`** decides whether Homey also tracks what the button does.
Ticked, the tiles stay in step: a speed code moves the speed group, `off` stops
the fan, `light_on` / `light_off` and the three white shades move the light
device. Untick it to transmit without touching state, which is what range
testing wants — repeating a code twenty times should not rewrite the UI twenty
times.

Tracking follows the **button**, not the device the card sits on. Both halves of
the unit answer to the same address, so a `light_on` sent from the fan device
updates the light device's tile. Buttons with nothing readable to track — the
timers, reverse, sleep wind and the brightness steps — are simply transmitted,
ticked or not.

| Value | Remote button | Value | Remote button |
|---|---|---|---|
| `speed_1` | Fan speed 1 | `light_on` | LIGHT ON |
| `speed_2` | Fan speed 2 | `light_off` | LIGHT OFF |
| `speed_3` | Fan speed 3 | `white_ww` | WW, warm white 3000 K |
| `speed_4` | Fan speed 4 | `white_nw` | NW, natural white 4300 K |
| `speed_5` | Fan speed 5 | `white_dw` | DW, day white 6500 K |
| `speed_6` | Fan speed 6 | `dim_up` | Brightness + |
| `off` | ⏻ centre, Fan Off | `dim_down` | Brightness − |
| `reverse` | ⇄ Forward/Reverse | `timer_1h` | Fan timer 1H |
| `sleep_wind` | ☾ Sleep Wind | `timer_3h` | Fan timer 3H |
| | | `timer_6h` | Fan timer 6H |

The card is offered on both devices, and every code carries the same address, so
it does not matter which one you pick — a `light_on` sent from the fan device
reaches the same lamp.

## How it works

`app.json` defines a 433 MHz signal whose frame shape matches the captured
remote exactly:

| Element | Mark (on) | Space (off) |
|---|---|---|
| `sof` (sync) | 7370 us | 1090 us |
| `words[0]` (bit 0) | 340 us | 720 us |
| `words[1]` (bit 1) | 720 us | 330 us |

Each button is a 41-bit frame — 24-bit address, 8-bit button id, that id XOR
`0xEB`, and a trailing zero — transmitted as an array of word indexes via
`this.homey.rf.getSignal433(...).tx(frame, { repetitions })`. Synthesising a
frame from this definition and diffing it against `captures/civx_fan_3.sub`
gives a mean timing error of 13.5 us, well inside the jitter the real remote
itself exhibits (short marks measured 299-375 us).

The redundancy check carries no address term, which is why the button ids are
the same on every unit: capturing them once covers every owner.

## Tests

```sh
node tools/rxtest.js .       # 54 checks, no hardware
node tools/pairtest.js .     # 22 checks against a simulated fan
node tools/check_codes.js    # captures vs. the frame structure
node tools/check_views.js    # pairing views and locale keys
homey app validate --level publish
```

## Range

Verified working: Homey Pro in the basement technical room reaches the fan in a
2nd-floor bedroom ceiling, diagonally across the house through a timber floor
separation. No repeater needed. For reference, the original remote is rated
`<10 dBm`.

## Licence

**GPL-3.0-or-later.** Full text in [`LICENSE`](LICENSE).

    Copyright (C) 2026 Arnljot Arntsen

    This program is free software: you can redistribute it and/or modify it
    under the terms of the GNU General Public License as published by the Free
    Software Foundation, either version 3 of the License, or (at your option)
    any later version.

    This program is distributed in the hope that it will be useful, but WITHOUT
    ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
    FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for
    more details.

    You should have received a copy of the GNU General Public License along
    with this program. If not, see <https://www.gnu.org/licenses/>.

The captures in `captures/` are recordings of a signal transmitted by a Philips
remote; the protocol they document is a fact about the hardware, not a work of
authorship. Philips and Civx are trademarks of Signify, which has nothing to do
with this project.

## Known limits

- **State is inferred, never measured.** The fan never reports back. Homey knows
  what it transmitted, and what it overheard the remote transmit — it cannot see
  the fan being switched off at the wall.
- **Only fan buttons are tracked.** Reception identifies the seven fan codes.
  The light codes are deliberately excluded: adding them would put two distorted
  codes within 2 bits of each other, below the margin the matcher needs to stay
  unambiguous. So the light device shows what Homey last sent, and does not
  follow the handset.
- **Individual presses can be missed.** Homey's receiver cannot actually decode
  this remote; it distorts the signal, deterministically, and the app matches
  the distorted form. Most frames in a burst come off the air too corrupted to
  identify and are rejected rather than guessed at, so a press registers only if
  one of its repetitions arrives cleanly. In testing that was reliable at
  several metres, but it is not guaranteed. Turn tracking off per device with
  **Follow the physical remote**; the mechanism is documented under
  "RX: works, but not by decoding correctly" in `CLAUDE.md`.
- **The centre button is a dedicated Fan Off**, exactly as the manual says —
  pressing it on a stopped fan leaves it stopped.
- **Homey Pro only.** Homey Bridge / Homey Cloud have no 433 MHz transmitter.
- The two signal variants exist because Homey's own RF convention wants a
  transmission to end on a mark (`sof.length + eof.length` odd), while the
  captured remote ends each frame on a space. `Capture-exact` follows the
  recording; `Trailing pulse` follows Homey's convention. Capture-exact is the
  default because it is what was proven to work.




