// Can a received frame be turned back into the transmitted one?
//
//   node tools/invertibility.js
//
// This decides whether a generic pairing flow is possible at all. Learning an
// unknown user's remote means recovering the TRUE bits of their address from
// what Homey receives. But Homey does not decode this remote — it applies a
// deterministic distortion (a bit reads 1 only where the previous and current
// transmitted bits are both 0), and that map is many-to-one:
//
//   received 1 at i  ->  pins b[i-1]=0 AND b[i]=0
//   received 0 at i  ->  only says NOT(b[i-1]=0 AND b[i]=0)
//
// The second case leaves real freedom. This counts, exactly, how many distinct
// transmitted frames produce each observed frame — by dynamic programming over
// the bit positions, so no enumeration of 2^41 is needed.

const { CODES, FRAMES } = require('../lib/codes');

function distort(bits) {
  let out = '';
  for (let i = 0; i < bits.length; i++) {
    const prev = i > 0 ? bits[i - 1] : 0;
    out += (prev === 0 && bits[i] === 0) ? '1' : '0';
  }
  return out;
}

/** Number of 41-bit inputs whose distortion equals `obs`. */
function preimageCount(obs) {
  // state = value of b[i]; start with the virtual b[-1] = 0
  let ways = { 0: 1n };            // b[-1] = 0
  for (let i = 0; i < obs.length; i++) {
    const next = { 0: 0n, 1: 0n };
    for (const prevStr of Object.keys(ways)) {
      const prev = Number(prevStr);
      for (const cur of [0, 1]) {
        const produced = (prev === 0 && cur === 0) ? '1' : '0';
        if (produced === obs[i]) next[cur] += ways[prevStr];
      }
    }
    ways = next;
  }
  return ways[0] + ways[1];
}

const PAIRING = '00101011110011010000110101100010100010010';

console.log('How many transmitted frames could produce each received frame?\n');
const rows = [...Object.entries(CODES), ['pairing (hold 1+2)', PAIRING]];
for (const [name, bits] of rows) {
  const obs = distort(bits.split('').map(Number));
  const n = preimageCount(obs);
  const ones = obs.split('').filter((c) => c === '1').length;
  console.log(`  ${name.padEnd(20)} received has ${String(ones).padStart(2)} ones`
    + `  ->  ${n.toLocaleString('en-US')} possible originals`);
}

console.log('\nOnly a count of 1 would let an unknown remote be read back exactly.');
console.log('The address is 24 of those 41 bits, so the ambiguity applies to it too.');

// Would capturing several different buttons help? They share the address, and
// the distortion of bit i depends only on bits i-1 and i — so every button
// yields an identical distorted address field. No extra information.
const addrDistorted = new Set(
  Object.values(CODES).map((b) => distort(b.split('').map(Number)).slice(0, 24)),
);
console.log(`\nDistinct distorted address fields across all 7 buttons: ${addrDistorted.size}`);
console.log('If that is 1, capturing more buttons adds nothing about the address.');
