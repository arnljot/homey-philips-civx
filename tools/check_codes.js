// Check every captured button against the confirmed frame structure and against
// the ids the app actually transmits.
//
//   node tools/check_codes.js
//
//   address(24) + id(8) + id^0xEB(8) + '0'
//
// A capture that does not satisfy this was mis-decoded, and an id that does not
// match BUTTON_IDS means the app sends something other than what was recorded —
// a wrong id is a command sent to somebody's ceiling fan.

const { CHECK_XOR, BUTTON_IDS } = require('../lib/pairing');

const REFERENCE_ADDRESS = '001010111100110100001101';

// Decoded from captures/ by `python tools/decode_sub.py captures`.
const CAPTURED = {
  speed_1: '00101011110011010000110101000001101010100',
  speed_2: '00101011110011010000110110101101010001100',
  speed_3: '00101011110011010000110110011110011101010',
  speed_4: '00101011110011010000110100100011110010000',
  speed_5: '00101011110011010000110110000000011010110',
  speed_6: '00101011110011010000110110001101011001100',
  off: '00101011110011010000110100010011111110000',
  pairing: '00101011110011010000110101100010100010010',
  light_on: '00101011110011010000110101111110100101010',
  light_off: '00101011110011010000110110111100010101110',
  white_ww: '00101011110011010000110101101111100001000',
  white_nw: '00101011110011010000110101100110100011010',
  white_dw: '00101011110011010000110110000101011011100',
  dim_up: '00101011110011010000110101110011100110000',
  dim_down: '00101011110011010000110100101001110000100',
  reverse: '00101011110011010000110101010000101110110',
  sleep_wind: '00101011110011010000110100110010110110010',
  timer_1h: '00101011110011010000110100011101111101100',
  timer_3h: '00101011110011010000110100011000111100110',
  timer_6h: '00101011110011010000110100010111111111000',
};

let bad = 0;
const fail = (msg) => { console.log(`BAD  ${msg}`); bad++; };
const hex = (n) => `0x${n.toString(16).toUpperCase().padStart(2, '0')}`;

for (const [name, bits] of Object.entries(CAPTURED)) {
  const address = bits.slice(0, 24);
  const id = parseInt(bits.slice(24, 32), 2);
  const check = parseInt(bits.slice(32, 40), 2);

  const problems = [];
  if (bits.length !== 41) problems.push(`length ${bits.length}`);
  if (address !== REFERENCE_ADDRESS) problems.push('address mismatch');
  if ((id ^ CHECK_XOR) !== check) problems.push(`check ${hex(check)} != ${hex(id ^ CHECK_XOR)}`);
  if (bits[40] !== '0') problems.push('trailer not 0');
  if (BUTTON_IDS[name] !== id) {
    problems.push(`BUTTON_IDS.${name} is ${hex(BUTTON_IDS[name])}, capture says ${hex(id)}`);
  }

  if (problems.length) fail(`${name}: ${problems.join('; ')}`);
  else console.log(`OK   ${name.padEnd(11)} id=${hex(id)} check=${hex(check)}`);
}

// Two buttons sharing an id would mean one of them is unreachable.
const seen = new Map();
for (const [name, id] of Object.entries(BUTTON_IDS)) {
  if (seen.has(id)) fail(`collision: ${name} and ${seen.get(id)} share id ${hex(id)}`);
  seen.set(id, name);
}

// Every id the app can transmit must come from a capture, not from a guess.
for (const name of Object.keys(BUTTON_IDS)) {
  if (!CAPTURED[name]) fail(`BUTTON_IDS.${name} has no capture behind it`);
}

console.log(bad
  ? `\n${bad} PROBLEM(S)`
  : `\nAll ${Object.keys(CAPTURED).length} codes fit the structure, match BUTTON_IDS, and are distinct.`);
process.exit(bad ? 1 : 0);
