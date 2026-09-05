# CLAUDE.md — Philips Civx RF

Context file for Claude Code. Read this first.

## What this project is
A Homey Pro app that drives a **Philips Civx** ceiling fan with integrated LED
over its 433 MHz RF remote protocol, so the unit can be controlled from a
smart-home hub instead of only the proprietary handset.

The protocol was reverse-engineered from Flipper Zero captures and verified by
physical replay. This repository is the app.

## The product
**Philips Civx Fan Ceiling Light** — Signify article **10057403**, EAN
**8721103103192**. 32 W fan + 24 W LED, DC motor, six fan speeds, two airflow
directions, LED dimmable to 10% with three white shades (3000 / 4300 / 6500 K),
"SceneSwitch", RF (non line-of-sight) remote.

Signify's datasheet copy is shared with the Philips **Velyx**, so that name
appears in the same document. This app was developed against the Civx.

## Reference material
The installation manual and datasheet are not in the repository — download them
from Signify and put them in `local/`, which is git-ignored:

- `local/manuals/` — installation manual (p. 3 has the button layout in frame
  J2, p. 11 the "Transmitter Function" table and the radio spec)
- `local/img/` — product photos and dimensions

Radio spec, from p. 11: band "433 Hz" (sic — 433.92 MHz), **maximum transmitted
power <10 dBm**, conformity declared with Directive 2014/53/EU.

## The remote — all 19 buttons

```
      [LIGHT ON]     (LED)     [LIGHT OFF]
                  3
             2   ( ⏻ )   4
             1           5
                  6
        [ WW ]   [ NW ]   [ DW ]
        [ ⇄        ☾ ]      [ + ]
        [ 1H  3H  6H ]      [ - ]
```

| Button | Manual's name | Long press | Code |
|---|---|---|---|
| 1..6 | Fan Speed (1/2/3/4/5/6) | — | `speed_1`..`speed_6` |
| ⏻ centre | Fan Off | — | `off` |
| LIGHT ON | Light ON | — | `light_on` |
| LIGHT OFF | Light OFF | — | `light_off` |
| WW | Warm white | colour temperature "−" | `white_ww` |
| NW | Natural white | — | `white_nw` |
| DW | Day white | colour temperature "+" | `white_dw` |
| ⇄ | Forward/Reverse | — | `reverse` |
| ☾ | Sleep Wind | — | `sleep_wind` |
| + | Light brightness "+" | — | `dim_up` |
| − | Light brightness "−" | — | `dim_down` |
| 1H / 3H / 6H | Fan Timer (1hr, 3hr, 6hr) | — | `timer_1h/3h/6h` |

"Sleep Wind" is only named, never described, in the manual.

**The centre button is a dedicated OFF, not a toggle.** Confirmed on hardware,
matching the manual's "Fan Off" label: pressing it on a stopped fan leaves it
stopped. Homey's own power switch looks like a toggle only because switching it
on sends a **speed** code instead.

**Releasing "1"+"2" starts the fan.** The remote does that itself. It matters
during pairing: the fan is usually spinning by the time probing begins.

## Hard facts (do not re-derive)
- Carrier **433.92 MHz**, modulation **OOK/ASK** (Flipper preset Ook650Async)
- Frame **41 bits**, PWM, one mark+space pair per bit, sent **5x** per press
- Sync: **7370 us on / 1090 us off**
- Bit 0: **340 us on / 720 us off** (short mark, long space)
- Bit 1: **720 us on / 330 us off** (long mark, short space)
- Bits 0..23: **address**, learned per unit, identical across that unit's buttons
- Bits 24..31: 8-bit button id. Bits 32..39: id XOR **0xEB**. Bit 40: always 0
- Fixed code — not rolling, not encrypted — so plain replay works

The redundancy check has **no address term**, which is why button ids are
expected to be the same on every unit. See "Command portability" below.

## The codes
Captured from one reference remote, whose address is
`001010111100110100001101` (0x2BCD0D). That address is a fixture for tests and
for the fallback in `device.js`; nothing in the pairing path may depend on it.

| Button | Full 41-bit code | Hex |
|---|---|---|
| Speed 1 | `00101011110011010000110101000001101010100` | `0x579A1A8354` |
| Speed 2 | `00101011110011010000110110101101010001100` | `0x579A1B5A8C` |
| Speed 3 | `00101011110011010000110110011110011101010` | `0x579A1B3CEA` |
| Speed 4 | `00101011110011010000110100100011110010000` | `0x579A1A4790` |
| Speed 5 | `00101011110011010000110110000000011010110` | `0x579A1B00D6` |
| Speed 6 | `00101011110011010000110110001101011001100` | `0x579A1B1ACC` |
| OFF | `00101011110011010000110100010011111110000` | `0x579A1A27F0` |
| Light ON | `00101011110011010000110101111110100101010` | `0x579A1AFD2A` |
| Light OFF | `00101011110011010000110110111100010101110` | `0x579A1B78AE` |
| Warm white | `00101011110011010000110101101111100001000` | `0x579A1ADF08` |
| Natural white | `00101011110011010000110101100110100011010` | `0x579A1ACD1A` |
| Day white | `00101011110011010000110110000101011011100` | `0x579A1B0ADC` |
| Brightness + | `00101011110011010000110101110011100110000` | `0x579A1AE730` |
| Brightness − | `00101011110011010000110100101001110000100` | `0x579A1A5384` |
| Forward/Reverse | `00101011110011010000110101010000101110110` | `0x579A1AA176` |
| Sleep Wind | `00101011110011010000110100110010110110010` | `0x579A1A65B2` |
| Fan timer 1h | `00101011110011010000110100011101111101100` | `0x579A1A3BEC` |
| Fan timer 3h | `00101011110011010000110100011000111100110` | `0x579A1A31E6` |
| Fan timer 6h | `00101011110011010000110100010111111111000` | `0x579A1A2FF8` |
| Pairing hold | `00101011110011010000110101100010100010010` | `0x579A1AC512` |

Button ids: speed 1-6 = 0x41 0xAD 0x9E 0x23 0x80 0x8D, off 0x13, pairing 0x62,
light on/off 0x7E/0xBC, WW/NW/DW 0x6F/0x66/0x85, dim +/- 0x73/0x29,
reverse 0x50, sleep wind 0x32, timers 1h/3h/6h 0x1D/0x18/0x17.

`node tools/check_codes.js` checks every frame against the structure and against
`BUTTON_IDS`, requires all ids to be distinct, and fails if any id in the code
has no capture behind it. Machine-readable copies in `docs/codes.json`; full
spec in `docs/protocol.md`.

## Pairing — finding an unknown fan's address
Every Civx learns its remote, so the address differs per unit and cannot be
hardcoded. The app discovers it.

**A received frame cannot be read directly.** Homey does not decode this remote,
it distorts it (see RX below), and that distortion is many-to-one: a single
received frame has thousands of possible originals, and every button produces an
identical distorted address field, so capturing more buttons adds nothing.

```
node tools/invertibility.js
  speed_4             ->    567 possible originals
  pairing (hold 1+2)  ->  3,276 possible originals
  speed_3             -> 32,130 possible originals
```

**What works is narrowing, then asking.** With the button known, only the 24
address bits are unknown, and the distortion still constrains them: the
reference remote yields **189** candidates, median across the space ~65. A
halving search over that list — transmit to half, ask the user whether the lamp
changed — identifies the fan in 8-9 questions.

The user holds "1"+"2", which streams the pairing frame continuously (~55 frames
per hold against 5 for a press), so the modal received frame is trustworthy.

### Settled on hardware
1. **Address discovery works.** The modal frame from a hold is stable and
   identical to the frame predicted from `captures/civx_hold_1_2.sub`.
2. **One repetition is enough** to drive the fan, so a 189-address sweep costs
   about ten seconds of air time.
3. **Address matching is EXACT.** Probes to addresses one bit from the real one
   — genuine members of the candidate list — did nothing at all. Candidate
   walking cannot false-positive.
4. **The frame structure is confirmed**, so any of the 256 ids can be built.

### Probing uses the LAMP, not the fan
- A lamp changes state within the frame. Blades coast for seconds, so a
  fan-based question asked too early gets "no" for a fan that did react — which
  sends a halving search down the wrong branch with no way back.
- Nothing mechanical moves in a fan the app has not identified yet.
- The medium is TOGGLED (on, off, on, ...), so each question costs ONE batch
  rather than a probe plus an undo: 192 frames for 189 candidates, not 368.
- Questions ask about a STATE ("is the light on now?"), not an event, because
  the change may happen halfway through a batch where nobody is watching.

`PROBE_BUTTONS_FAN` is the fallback for a unit whose lamp is dead; the view
offers it as "the light does not work". It uses the LOWEST speed: a badly
mounted fan spun up hard could shake itself loose.

### Constraints that bound the design
- **Linear scanning is not an option.** A single address has a 1/189 chance, so
  walking one at a time averages ~95 tries. Group testing is what makes 8-9
  questions possible.
- **Intersecting two buttons' candidate sets gains nothing**
  (`tools/intersect_test.js`): the address bits are identical on every press, so
  both sets carry the same ambiguity. 189 ∩ 189 = 189.
- **No warm-up sweep.** Forcing every candidate to a known state before the
  first question costs a full extra pass over the air for something one press of
  the user's own remote does instantly, and ten silent seconds reads as a hang.
- **Trust the modal frame only if it dominates.** Deciding on the first twelve
  frames that arrive, and accepting any modal that yields a non-empty candidate
  list, produces a list without the fan in it — indistinguishable from a dead
  transmitter: nothing reacts, every answer is "no", the search fails.

### Rejected: making the fan learn Homey
The manual's own procedure (mains off/on, then hold "1"+"2" within 10 s) would
let the app pair itself as the transmitter, after which its own hardcoded
address would work on any fan with no reception needed. **Not done, and not to
be revisited**: it is unknown whether the receiver keeps more than one
transmitter, so it could leave the owner's handset dead. Discovering the user's
address instead leaves their remote untouched.

The same procedure is why the address is a *learned* pairing: re-running it on
the reference unit would change the address and invalidate `docs/codes.json`.

## RX: works, but not by decoding correctly
Homey Pro cannot decode this remote. It receives it, smears the 32%/69% PWM
toward 50% and produces the wrong bits — but **deterministically**, so the app
recognises the DISTORTED form of each code instead. Confirmed on hardware:
pressing 3, 2, 1, off tracked exactly, in order.

### The transform
A received bit is `1` **only where the previous AND current transmitted bits are
both 0**; otherwise `0`. See `distort()` in `lib/codes.js`.

Physically: after a `0` bit a short mark is stretched and a long mark shrunk,
with spaces moving the opposite way — a slicer whose threshold has not recovered
from the previous symbol. Because it depends on the PREVIOUS symbol, no static
`words` definition can compensate, and every memoryless model failed.

### How it was established
Fitted on `speed_2`, `speed_5`, `off`, then verified **out-of-sample**: the
predicted distorted forms of `speed_1`, `speed_3`, `speed_4` and `speed_6` were
written down before any data was taken, and each produced an exact 41-bit match
off the air. Chance of one such hit is ~5e-13.

The first "verification" was circular — fitted and tested on the same three
sequences. **Never accept a model tested on its own training data.**

### Matching rules — the numbers bound the risk, do not loosen them
- Real codes: tolerance **4** bits. Within 4 bits of any of the 7 codes lies
  ~790k of 2^41 frames, so a random frame lands there with p ~3.6e-7.
- Distorted codes: tolerance **1** bit. They are only **3** bits apart at their
  closest (`speed_2` vs `speed_6`), and disjoint balls need `2r+1 <= 3`. False
  positive ~1.3e-10 per random frame.
- Distorted codes sit **22** bits from the real ones, so the two matchers cannot
  cross-contaminate.
- Most frames in a burst are too corrupted to identify and are **rejected, not
  guessed**. Only the clean ones count; 4-8 per burst match exactly.
- **Only the 7 fan buttons are matched.** Adding the light codes drops the
  closest distorted pair from 3 bits to 2 (`speed_3` vs `light_off`), below what
  tolerance 1 needs. Checked by `node tools/check_light_codes.js`.

### Signal definition — do NOT "tidy" these
- **No `sof`.** Homey never accepts the 7370us sync mark as a preamble; every
  sof-based variant decoded nothing at all, under every other parameter.
- **No `agc`.** Tested: it validates but has no effect on reception.
- **`sensitivity` 0.5.** Counter-intuitive, but the only setting that yields
  full-length frames off the air. Tighter values decode nothing.
- **`minimalLength`/`maximalLength` 4/250.** Setting them to the real frame
  length of 41 silently discards everything.

### Validator limits (from homey-lib, do not re-derive)
- `interval` 5..32767 us; all `sof`/`eof`/`words` timings 5..32767 us
- `sensitivity` 0.0..0.5; `repetitions` 1..255
- Homey's convention wants `sof.length + eof.length` **odd**, so the
  transmission ends on a mark. The capture ends each frame on a space, so the
  default variant uses `eof: []` for exactness; `philips_civx_fan_eof` adds
  `eof: [340]` as the convention-following fallback.
- The app.json schema does **not** validate signal bodies — only the runtime does.

### Confirming the remote is really the source
The house was long suspected of chatty 433 neighbours. It is not: with the
remote untouched the rate is **zero** (10+ consecutive idle windows). Frames
beginning `110000000001...` are this remote distorted, not thermostats — an
error that stood for two days. Controls that discriminate:
1. **Idle baseline** — untouched remote must give zero frames.
2. **Press rate** — one press decodes as exactly 5 frames per enabled signal.
3. **The captures** — `node tools/check_groups.js` confirms the transmitter
   sends 5 byte-identical frames, so ALL variance is receiver-side.

## Implementation
- `app.json` -> `signals.433` — `philips_civx_fan` (TX), `philips_civx_fan_eof`
  (TX fallback), `civx_ctl` (RX). The TX frame shape was diffed against
  `captures/civx_fan_3.sub`: 84 timing elements, mean error 13.5 us, bits match.
- `lib/codes.js` — the 7 fan frames as tx word-index arrays, plus the distortion
  model and the matchers used for RX.
- `lib/pairing.js` — address-agnostic frame building, all 20 button ids, and
  `candidateAddresses()`.
- `drivers/civx-fan/driver.js` — RX listening and the `onPair` session.
- `drivers/civx-fan/device.js` — both device roles.
- Transmit API (SDK v3): `this.homey.rf.getSignal433(id).tx(frame, {repetitions})`,
  requiring the `homey:wireless:433` permission.

**One address, TWO devices.** The unit is one piece of hardware but two things
to a smart home, and zone actions key off the device CLASS — "all lights off"
never reaches a device of class `fan`. Pairing returns both from a single
search: `civx-<address>` (role `fan`) and `civx-<address>-light` (role `light`),
preselected, so it stays one confirmation.

A driver manifest can only declare one class, so `device.js` calls
`setClass('light')` in `onInit` for the light role, guarded by a `typeof` check
— losing the class is not worth failing `onInit` over. Capability lists and the
`onoff` listener come from `_role()`; a device with no `role` in its data is a
fan, which keeps earlier devices working. The light ignores `onRemoteButton`.

**Brightness is relative, so there is no `dim` slider.** The remote has only
+/- steps, there is no absolute-level command, and the lamp cannot be read back.
A 0-100% figure would be invented. Two step buttons are the honest mapping.

## Homey gotchas (learned the hard way)
**Changing `drivers[].capabilities` does NOT affect already-paired devices.**
Homey freezes a device's capability list at pairing time, so every capability
change must ALSO be applied in `device.js onInit` via `addCapability()` /
`removeCapability()`. See `_migrateCapabilities()`. Symptom when forgotten: the
new capabilities simply do not appear.

**`addCapability()` APPENDS — it cannot insert.** A migrated device therefore
ends up with capabilities in the order they happened to be added, and Homey
presents a device from that order, so one added late can fail to surface —
`civx_speed` held the right value yet never appeared as the tile status
indicator. `_migrateCapabilities()` enforces ORDER, not just membership: it
finds the first index that differs, removes the tail, and re-adds in declared
order. Covered by "migration repairs capability order" in `tools/rxtest.js`.

**There is no app-side API for the tile status indicator.** Neither homey-lib
nor the SDK typings contain the word "indicator" — it is a per-device user
setting. An app controls only which capabilities exist, and in what order.

**Enums can only render as a scroller.** The allowed `uiComponent` values are
`thermostat, media, toggle, slider, ternary, button, color, picker, sensor,
battery`. An enum gets `picker`, a scroll wheel. For direct-select choices use
several boolean capabilities with `uiComponent: "button"`.

**A `sensor` uiComponent lands on the "meters" page.** That is where the
read-only `civx_speed` indicator sits.

**Buttons are stateless unless the capability is BOTH `setable` and `getable`.**
The standard `button` capability hardcodes `getable: false`, so sub-capabilities
like `button.speed1` can never show which one is selected. A radio-group look
needs **custom** boolean capabilities with `getable: true, setable: true,
uiComponent: "button"`, driven so exactly one is true.

**Homey writes a capability's own value AFTER its listener resolves**, which
overwrites anything painted from inside that listener. Symptom: selecting a new
speed left the previous one lit too. `_setState()` repaints again after
`REPAINT_DELAY_MS`, landing after Homey's write. Momentary buttons clear
themselves on the same tick, so tests asserting on them must wait past that
delay — see `settleRepaint()` in `tools/rxtest.js`.

**A capability write is an IPC round trip** clients are notified about. Writing
only changed values took a press from up to 16 writes down to 2-3.

### Pairing views
**A custom pairing view is GIVEN `Homey` directly — never include `/homey.js`.**
Including it replaces the real API with an asset loader that has only
`getFile/loadScript`, and the page then renders perfectly while doing nothing.
`tools/check_views.js` fails the build if it reappears.

**`list_devices` and `add_devices` are two halves of ONE template.** Declaring
`list_devices` alone leaves the chosen device with nowhere to commit: the pair
session ends, the window closes, and Homey offers the device outside the app's
flow. It needs `navigation: { next: "add_devices" }` and an `add_devices` view
beside it. `Homey.createDevice()` from a custom view was tried first and left
the page stuck. Guarded by a check in `tools/pairtest.js`.

**Homey's device list hides anything already paired**, so handing it only known
devices renders "no new devices have been found" — the opposite of what
happened. The driver checks first and says so instead.

**View text belongs in `data-i18n`, not in the view's JavaScript.** Strings
built in script ship English to every language. For text that changes at
runtime, put all variants in the markup as hidden `data-i18n` spans and read
their `textContent` back. Only interpolated strings are built driver-side, since
`data-i18n` cannot substitute — and `Homey.__()` does not interpolate in a pair
session either. `tools/check_views.js` resolves every key against every locale.

**`Homey.showNextButton()` does not exist** in a pairing view on this firmware;
calling it printed a red TypeError. The Continue button comes from the view's
`navigation` entry in app.json.

**A pair handler MUST return promptly.** Homey serialises pair-session messages,
so anything emitted from inside a still-running handler is queued behind it and
never reaches the view. Long work is detached onto the next tick; a session that
is abandoned mid-probe keeps transmitting unless it is cancelled explicitly.

## Tests
- `node tools/rxtest.js .` — 54 offline checks, no hardware. Stubs the `homey`
  module and drives the real driver and device classes: burst de-dup, the
  dedicated-off semantics, bit-error tolerance, self-echo muting, foreign 433
  traffic, the `track_remote` opt-out, capability migration and ordering, the
  deferred repaint, both device roles, and the send_raw_code Flow action with
  its state-tracking checkbox.
- `node tools/pairtest.js .` — 22 checks against a simulated fan that reacts
  only to its exact address: listening, candidate derivation, the halving
  search, air-time budget, weak-modal rejection, and the device handover.
- `node tools/check_codes.js` — every captured frame against the structure and
  against `BUTTON_IDS`.
- `node tools/check_views.js` — pair-view script syntax, the `/homey.js` ban,
  and every `data-i18n` key against every locale.
- `node tools/timing_stats.js captures` — re-derives the symbol timings from the
  captures, measuring only inside the bursts.
- `homey app validate --level publish`

## Method notes
**Prefer user-paced tests over timed sequences whenever attribution matters.**
Two automatic probe sequences were run early and both were worthless: once the
fan is moving, a false trigger on step 1 and a correct one on step 3 look
identical to an observer, and a camera feed adds its own lag. The test only
became sound when the user drove it one button at a time.

**Command portability is structural, not measured.** The redundancy check has no
address term, which is why button ids should work on any unit — but this has
never been tried against a second remote. Everything is built to fail cleanly if
it is wrong: no candidate address drives the fan, and pairing does not succeed.

**`0xEB` is the ONLY constant in 0..255** that satisfies `command = id . (id ^ k)`
across the captured buttons; chance of a wrong constant fitting is ~1.4e-17
(`node tools/test_xor_hypothesis.js`).

**A frame is ~52 ms on air** (7.4 ms sync + 41 bits at ~1.05 ms). That is what
makes a 95-address sweep take about five seconds.

## Status
- [x] Capture + decode, verified by physical replay
- [x] All 19 remote buttons captured
- [x] Homey app validates at `publish` level and installs
- [x] **Range test PASSED** — Homey Pro stays in the basement technical room and
      reaches the fan in the 2nd-floor bedroom ceiling, diagonally across the
      house through a timber floor separation. No repeater needed.
- [x] RX tracking of the original remote, confirmed on hardware
- [x] Guided pairing for an unknown fan, confirmed on hardware

## Licence
GPL-3.0-or-later; full text in `LICENSE`. The app's own source carries an SPDX
identifier at the top of each file; `tools/` and everything else in the tree are
covered by the root `LICENSE`. Keep `package.json`'s `license` field in step if
this ever changes.

Note that `app.json` has no licence field — the Homey manifest schema does not
define one, so the declaration lives in `package.json` and `LICENSE` only.
## Gotchas
- Civx is a **DC-motor** fan: its mains supply must stay **undimmed**. This app
  sends RF codes; it never dims the fan's power line.
- RF is **one-way**: the app cannot read fan state. Homey shows what it last
  sent, corrected when it overhears the remote.
- Keep `local/` and `*.pdf` in `.homeyignore`. With the PDFs bundled the archive
  was 60 MB and `homey app install` died on a 300 s upload timeout; without them
  it is ~250 KB.
- Re-decoding new captures: `python tools/decode_sub.py captures/`.
- The **Repetitions per press** device setting (default 8, remote sends 5) and
  the **Send a remote button code** Flow action exist for range testing: the
  Flow action fires a code without changing device state, so it can be looped.
- Naming history: earlier drafts said "pergola", then "Olas". It is **Civx**.
  The working directory name still carries the old label; nothing else does.



