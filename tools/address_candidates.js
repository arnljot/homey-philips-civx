// How many addresses are consistent with one received frame?
//
//   node tools/address_candidates.js
//
// Learning a user's address without bricking their handset means recovering the
// 24 address bits from what Homey receives. Earlier I counted preimages over the
// whole 41-bit frame (thousands) and concluded it was hopeless — but that
// treated the command bits as unknown too.
//
// If the 16-bit command is the same on every unit (only the address is learned
// per fan), then pressing a KNOWN button means bits 24..40 are known, and only
// the address is in question. The distortion still constrains it:
//
//   received 1 at i  ->  b[i-1] = 0 AND b[i] = 0
//   received 0 at i  ->  NOT(b[i-1] = 0 AND b[i] = 0)
//
// Bit 24 couples the last address bit to the first (known) command bit, so
// different buttons constrain bit 23 differently — pressing more than one
// button can therefore narrow the set.

const { CODES } = require('../lib/codes');

const distort = (bits) => bits
  .map((b, i) => (((i > 0 ? bits[i - 1] : 0) === 0 && b === 0) ? '1' : '0')).join('');

/**
 * Addresses consistent with the frames received for a set of known buttons.
 * @param {string[]} buttons names of buttons the user pressed
 * @returns {string[]} candidate 24-bit addresses
 */
function candidates(buttons) {
  const obs = Object.fromEntries(
    buttons.map((n) => [n, distort(CODES[n].split('').map(Number))]),
  );

  // DP over the 24 address bits; state is the previous bit's value.
  let ways = new Map([[0, ['']]]);
  for (let i = 0; i < 24; i++) {
    const next = new Map([[0, []], [1, []]]);
    for (const [prev, prefixes] of ways) {
      for (const cur of [0, 1]) {
        const produced = (prev === 0 && cur === 0) ? '1' : '0';
        // Every button must agree here — the address field is common to all.
        if (buttons.every((n) => obs[n][i] === produced)) {
          for (const p of prefixes) next.get(cur).push(p + cur);
        }
      }
    }
    ways = next;
  }

  // Bit 24 is the first COMMAND bit and is known per button, so it constrains
  // the final address bit differently for each button pressed.
  const out = [];
  for (const [lastBit, prefixes] of ways) {
    const ok = buttons.every((n) => {
      const cmd0 = Number(CODES[n][24]);
      const produced = (lastBit === 0 && cmd0 === 0) ? '1' : '0';
      return obs[n][24] === produced;
    });
    if (ok) out.push(...prefixes);
  }
  return out;
}

const TRUE_ADDRESS = CODES.speed_1.slice(0, 24);
console.log(`true address: ${TRUE_ADDRESS}\n`);

const trials = [
  ['speed_1'],
  ['speed_3'],
  ['speed_1', 'speed_3'],
  ['speed_1', 'speed_3', 'off'],
  ['speed_1', 'speed_2', 'speed_3', 'speed_4', 'speed_5', 'speed_6', 'off'],
];
for (const t of trials) {
  const c = candidates(t);
  const hit = c.includes(TRUE_ADDRESS);
  console.log(`  buttons ${t.join('+').padEnd(46)} -> ${String(c.length).padStart(6)} candidates`
    + `   contains truth: ${hit}`);
}

console.log('\nA candidate list is only useful if it is short enough to walk');
console.log('through by transmitting each one and asking "did the fan react?".');

// Our address might be unusually lucky. Sample the whole space to find out what
// a stranger's fan would actually cost to identify.
function candidatesFor(address, buttonCmd) {
  const frame = (address + buttonCmd).split('').map(Number);
  const obs = distort(frame);
  let ways = new Map([[0, 1]]);
  for (let i = 0; i < 24; i++) {
    const next = new Map([[0, 0], [1, 0]]);
    for (const [prev, n] of ways) {
      for (const cur of [0, 1]) {
        const produced = (prev === 0 && cur === 0) ? '1' : '0';
        if (obs[i] === produced) next.set(cur, next.get(cur) + n);
      }
    }
    ways = next;
  }
  const cmd0 = Number(buttonCmd[0]);
  let total = 0;
  for (const [lastBit, n] of ways) {
    const produced = (lastBit === 0 && cmd0 === 0) ? '1' : '0';
    if (obs[24] === produced) total += n;
  }
  return total;
}

const CMD = CODES.speed_1.slice(24);
const counts = [];
let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
for (let t = 0; t < 4000; t++) {
  const addr = Array.from({ length: 24 }, () => (rnd() < 0.5 ? '0' : '1')).join('');
  counts.push(candidatesFor(addr, CMD));
}
counts.sort((a, b) => a - b);
const pct = (p) => counts[Math.floor((counts.length - 1) * p)];
console.log('\nCandidate-set size over 4000 random addresses (one Speed 1 press):');
console.log(`  min ${counts[0]}   median ${pct(0.5)}   90th ${pct(0.9)}`
  + `   99th ${pct(0.99)}   max ${counts[counts.length - 1]}`);
const worst = counts[counts.length - 1];
console.log(`\nBinary search over the worst case needs ~${Math.ceil(Math.log2(worst))} yes/no answers.`);
