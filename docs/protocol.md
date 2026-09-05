# Philips Civx RF protocol

The 433 MHz remote protocol of the **Philips Civx Fan Ceiling Light** (Signify
article 10057403), reverse-engineered from Flipper Zero captures and verified by
physical replay against the fan.

Machine-readable form: [`codes.json`](codes.json), which is derived from the
captures in `captures/` rather than transcribed.

## Radio

| | |
|---|---|
| Carrier | **433.92 MHz** |
| Modulation | **OOK / ASK**, no carrier during a space |
| Flipper preset | `FuriHalSubGhzPresetOok650Async` |
| Coding | PWM — one mark + one space per bit, constant bit period |
| Transmit power (remote) | `<10 dBm`, per the manual's radio spec |
| Direction | **One-way.** The fan has a receiver only and never reports back. |

The code is **fixed** — not rolling, not encrypted — so a recorded frame replays
successfully any number of times.

## Symbol timings

| Element | Mark (carrier on) | Space (off) |
|---|---|---|
| Sync | 7370 µs | 1090 µs |
| Bit `0` | 340 µs | 720 µs |
| Bit `1` | 720 µs | 330 µs |

Both bit periods are ~1.06 ms, so the two symbols differ in duty cycle (32% vs
69%), not in length. Measured jitter on the real remote is wide — short marks
came out anywhere between 299 and 375 µs — so a decoder should split on mark
length around 530 µs rather than match exact values.

Re-derive these from the captures with `node tools/timing_stats.js captures`,
which measures only inside the bursts.

## Frame

One press transmits a sync mark followed by **41 bits**, and repeats the whole
thing **5 times** back to back.

```
[sync] [ address 24 bits ][ id 8 ][ check 8 ][0]
        bits 0..23         24..31   32..39    40
```

| Field | Bits | Meaning |
|---|---|---|
| Address | 0–23 | Identifies the transmitter. **Learned per unit.** |
| Button id | 24–31 | Which button was pressed. Same on every unit. |
| Check | 32–39 | `id XOR 0xEB` |
| Trailer | 40 | Always `0` |

`0xEB` is the only constant in 0..255 that satisfies the check across all
captured buttons; the chance of a wrong constant fitting is ~1.4e-17
(`node tools/test_xor_hypothesis.js`).

**The check carries no address term.** That is the structural reason to expect
button ids to be identical on every Civx: a protocol wanting per-unit commands
would fold the address into the check. It has not been tested against a second
remote — see "Portability" below.

## Address

The address is a *learned* pairing, not a serial number. The manual's own
procedure re-teaches it: switch the fan's mains on, and **within 10 seconds**
hold **1 + 2** together for about 3 seconds. The receiver beeps twice when it
has learned the transmitter.

The reference remote used for these captures answers to:

```
001010111100110100001101   0x2BCD0D
```

Every code in `codes.json` carries that address. An application must discover
the user's own — replaying these frames verbatim drives only this one fan.

Holding **1 + 2** also transmits a dedicated frame of its own (id `0x62`) and
streams it continuously while held: about 55 frames per hold, against 5 for a
normal press.

## Button ids

All 19 buttons on the handset, plus the pairing hold.

| Id | Button | Id | Button |
|---|---|---|---|
| `0x41` | Speed 1 | `0x7E` | Light ON |
| `0xAD` | Speed 2 | `0xBC` | Light OFF |
| `0x9E` | Speed 3 | `0x6F` | Warm white (3000 K) |
| `0x23` | Speed 4 | `0x66` | Natural white (4300 K) |
| `0x80` | Speed 5 | `0x85` | Day white (6500 K) |
| `0x8D` | Speed 6 | `0x73` | Brightness + |
| `0x13` | Fan off (centre) | `0x29` | Brightness − |
| `0x62` | Pairing (hold 1 + 2) | `0x50` | Forward/Reverse |
| | | `0x32` | Sleep Wind |
| | | `0x1D` `0x18` `0x17` | Fan timer 1h / 3h / 6h |

The centre button is a **dedicated off**, not a toggle: pressing it on a stopped
fan leaves it stopped. Releasing the 1 + 2 hold starts the fan — the remote does
that itself.

Brightness is **relative only**. There is no absolute-level command, so a
controller cannot set a percentage, and with no return channel it cannot read
one either.

## Building a frame

```
frame = address(24) + id(8) + (id XOR 0xEB)(8) + "0"
```

Transmit the sync mark, then each bit as its mark/space pair, and repeat. One
frame is about 52 ms on air (7.4 ms sync + 41 bits at ~1.06 ms).

The original remote sends 5 repetitions. **One is enough** for a fan in range —
measured on hardware — so repetitions buy margin, not correctness.

Address matching in the receiver is **exact**: frames sent to addresses one bit
away from the real one moved the fan not at all.

## Decoding a capture

```sh
python tools/decode_sub.py captures            # every .sub in a directory
python tools/decode_sub.py captures/civx_ww.sub
```

Recording with a manual start and stop leaves unrelated noise before and after
the burst, so the decoder keys off the sync mark rather than the start of the
file, and reports the frame that repeats. A capture whose repetitions disagree
is flagged rather than trusted.

`node tools/check_codes.js` then checks every decoded frame against the
structure above and against the ids the app transmits.

## Receiving it

Reception is harder than transmission, and worth knowing about before trying:

- A long sync mark is **not** usable as a preamble on every receiver. Homey Pro
  rejects the 7370 µs mark outright, and only decodes with no start-of-frame
  defined at all.
- Homey Pro cannot resolve the 32%/69% duty cycles. It smears them toward 50%
  and produces the wrong bits — but **deterministically**: a received bit is `1`
  only where the previous *and* current transmitted bits are both `0`.

That transform is many-to-one, so a received frame cannot be inverted to a
unique original. With the button known it still constrains the address heavily,
which is what makes address discovery possible without a clean decode. The model
and the numbers are in the project's `CLAUDE.md`.

## Portability

Button ids are expected to be the same on every Civx, because the check byte
derives from the id alone. **This has never been tested against a second
remote.** Anything built on it should fail cleanly if the assumption is wrong —
in this project, no candidate address drives the fan and pairing simply does not
succeed.

## Safety

The Civx is a **DC-motor** fan: its mains supply must stay undimmed. This
protocol carries commands only; it never touches the fan's power line.

Speed 6 is strong. Driving an unfamiliar or poorly mounted fan at full speed
risks shaking the mount loose — use the lowest speed when probing.
