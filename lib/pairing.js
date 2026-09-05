// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

/**
 * Address-agnostic frame building and address discovery.
 *
 * A Civx fan learns a transmitter's 24-bit address, so every unit has its own
 * and the app must discover it. The 16-bit command per button is address-free
 * and hardcoded here. If that ever turns out to be wrong, no candidate address
 * will drive the fan and pairing fails rather than misfires.
 *
 * The reference remote's address, for tests and documentation only — nothing in
 * the runtime path may depend on it: 001010111100110100001101 = 0x2BCD0D
 */

const { distort } = require('./codes');

const ADDRESS_BITS = 24;
const COMMAND_BITS = 16;
const FRAME_BITS = 41;

/**
 * command = id . (id ^ 0xEB). The check has no address term, which is why
 * commands are portable between fans — the assumption pairing rests on.
 * `node tools/test_xor_hypothesis.js`.
 */
const CHECK_XOR = 0xEB;

/**
 * All 19 buttons, plus the frame the "1"+"2" pairing hold emits. Identical on
 * every unit; `node tools/check_codes.js` checks each against its capture.
 */
const BUTTON_IDS = {
  speed_1: 0x41,
  speed_2: 0xAD,
  speed_3: 0x9E,
  speed_4: 0x23,
  speed_5: 0x80,
  speed_6: 0x8D,
  off: 0x13,
  light_on: 0x7E,
  light_off: 0xBC,
  white_ww: 0x6F,          // warm white, 3000 K
  white_nw: 0x66,          // natural white, 4300 K
  white_dw: 0x85,          // day white, 6500 K
  dim_up: 0x73,
  dim_down: 0x29,
  reverse: 0x50,           // forward/reverse airflow
  sleep_wind: 0x32,        // the moon button; named but never described
  timer_1h: 0x1D,
  timer_3h: 0x18,
  timer_6h: 0x17,
  // Streams continuously while "1"+"2" are held: ~55 frames per hold against 5
  // for a press, which is what makes the modal received frame trustworthy.
  pairing: 0x62,
};

const byte2bits = (n) => (n & 0xFF).toString(2).padStart(8, '0');

/** The 16-bit command field for an 8-bit button id. */
const commandForId = (id) => byte2bits(id) + byte2bits(id ^ CHECK_XOR);

/** The per-button command fields, without any address. */
const COMMANDS = Object.fromEntries(
  Object.entries(BUTTON_IDS).map(([name, id]) => [name, commandForId(id)]),
);

/**
 * Does a 41-bit frame satisfy the protocol's own check? A random frame passes
 * with p = 1/256, so this rejects most mis-decodes.
 * @param {string} bits 41-bit string
 */
function isWellFormed(bits) {
  if (!/^[01]{41}$/.test(bits)) return false;
  const data = parseInt(bits.slice(24, 32), 2);
  const check = parseInt(bits.slice(32, 40), 2);
  return check === (data ^ CHECK_XOR) && bits[40] === '0';
}

/**
 * Build a transmittable frame for a button on a given fan.
 * @param {string} address 24-bit address string
 * @param {string} button key of COMMANDS
 * @returns {number[]} 41 word indexes, ready for Signal#tx
 */
function frameFor(address, button) {
  const command = COMMANDS[button];
  if (!command) throw new Error(`Unknown button: ${button}`);
  if (!/^[01]{24}$/.test(address)) throw new Error(`Invalid address: ${address}`);
  return `${address}${command}0`.split('').map(Number);
}

/**
 * Every address consistent with one received frame.
 *
 * The receiver's distortion is many-to-one, so a frame cannot be inverted —
 * but with the button known, only the 24 address bits are unknown and the
 * distortion constrains them heavily. Walk the address bit by bit, keeping
 * every prefix that could have produced what was received.
 *
 * Bit 24 couples the last address bit to the first command bit, so buttons
 * whose command starts with `0` pin one extra bit; the others do not.
 *
 * @param {string} received 41-bit string as Homey reported it
 * @param {string} button which button was pressed
 * @returns {string[]} candidate addresses, in ascending bit order
 */
function candidateAddresses(received, button) {
  const command = COMMANDS[button];
  if (!command) throw new Error(`Unknown button: ${button}`);
  if (!/^[01]{41}$/.test(received)) throw new Error('Received frame must be 41 bits');

  // state: value of the previous bit -> list of prefixes reaching it
  let ways = new Map([[0, ['']]]);
  for (let i = 0; i < ADDRESS_BITS; i++) {
    const next = new Map([[0, []], [1, []]]);
    for (const [prev, prefixes] of ways) {
      for (const cur of [0, 1]) {
        const produced = (prev === 0 && cur === 0) ? '1' : '0';
        if (received[i] === produced) {
          const bucket = next.get(cur);
          for (const p of prefixes) bucket.push(p + cur);
        }
      }
    }
    ways = next;
  }

  const out = [];
  const firstCommandBit = Number(command[0]);
  for (const [lastBit, prefixes] of ways) {
    const produced = (lastBit === 0 && firstCommandBit === 0) ? '1' : '0';
    if (received[ADDRESS_BITS] === produced) out.push(...prefixes);
  }
  return out;
}

/**
 * The frame to trust from a burst of noisy receptions: the most repeated one.
 * Callers must check `count` against `total` — a modal frame seen twice out of
 * twelve is noise, and pairing against it yields a list without the fan in it.
 * @param {string[]} frames 41-bit strings
 * @returns {{bits: string, count: number, total: number}|null}
 */
function modalFrame(frames) {
  const valid = frames.filter((f) => /^[01]{41}$/.test(f));
  if (!valid.length) return null;
  const tally = new Map();
  for (const f of valid) tally.set(f, (tally.get(f) || 0) + 1);
  const [bits, count] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
  return { bits, count, total: valid.length };
}

/**
 * The buttons pairing probes candidate addresses with: the LED, because a lamp
 * changes state instantly and nothing mechanical moves in a fan the app has not
 * identified yet. The fan fallback is for a unit whose lamp is dead, and is
 * deliberately the LOWEST speed. See "Pairing probes the LAMP" in CLAUDE.md.
 */
const PROBE_BUTTONS = { on: 'light_on', off: 'light_off' };
const PROBE_BUTTONS_FAN = { on: 'speed_1', off: 'off' };
const PROBE_BUTTON = 'speed_1';

/**
 * Build a frame for any 8-bit button id, captured or not: the command is fully
 * determined by the id.
 * @param {string} address 24-bit address
 * @param {number} id 0..255
 */
function frameForId(address, id) {
  if (!/^[01]{24}$/.test(address)) throw new Error(`Invalid address: ${address}`);
  if (!Number.isInteger(id) || id < 0 || id > 255) throw new Error(`Invalid id: ${id}`);
  return `${address}${commandForId(id)}0`.split('').map(Number);
}

module.exports = {
  COMMANDS,
  BUTTON_IDS,
  CHECK_XOR,
  ADDRESS_BITS,
  COMMAND_BITS,
  FRAME_BITS,
  PROBE_BUTTON,
  PROBE_BUTTONS,
  PROBE_BUTTONS_FAN,
  commandForId,
  isWellFormed,
  frameFor,
  frameForId,
  candidateAddresses,
  modalFrame,
  distort,
};




