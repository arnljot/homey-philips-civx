// Check that matching against the receiver's distorted codes cannot misfire.
//
//   node tools/verify_mangled_safety.js
//
// Homey's receiver cannot resolve this remote's PWM, but it distorts it
// DETERMINISTICALLY: a received bit is 1 only where the previous and current
// transmitted bits are both 0. Verified out-of-sample on 2026-09-04 — four
// buttons the model had never seen each produced an exact 41-bit match to a
// prediction recorded in advance.
//
// So instead of decoding correctly, match the distorted form. This checks the
// tolerance that can safely be used: distorted codes must stay far enough apart
// from each other, and from the real codes, that no frame is ever attributed to
// the wrong button.

const { CODES, FRAMES } = require('../lib/codes');

function mangle(bits) {
  let out = '';
  for (let i = 0; i < bits.length; i++) {
    const prev = i > 0 ? bits[i - 1] : 0;
    out += (prev === 0 && bits[i] === 0) ? '1' : '0';
  }
  return out;
}

const hamming = (a, b) => {
  let h = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) h++;
  return h;
};

const names = Object.keys(CODES);
const mangled = Object.fromEntries(names.map((n) => [n, mangle(FRAMES[n])]));

let minMangled = { d: Infinity, pair: '' };
for (let i = 0; i < names.length; i++) {
  for (let j = i + 1; j < names.length; j++) {
    const d = hamming(mangled[names[i]], mangled[names[j]]);
    if (d < minMangled.d) minMangled = { d, pair: `${names[i]} vs ${names[j]}` };
  }
}

let minCross = { d: Infinity, pair: '' };
for (const a of names) {
  for (const b of names) {
    const d = hamming(mangled[a], CODES[b]);
    if (d < minCross.d) minCross = { d, pair: `mangled ${a} vs real ${b}` };
  }
}

console.log(`distinct distorted codes      : ${new Set(Object.values(mangled)).size} of ${names.length}`);
console.log(`closest distorted pair        : ${minMangled.pair} -> ${minMangled.d} bits`);
console.log(`closest distorted-to-real pair: ${minCross.pair} -> ${minCross.d} bits`);

// Balls of radius r around each code are disjoint when the minimum separation
// is at least 2r+1.
const safe = Math.floor((minMangled.d - 1) / 2);
console.log(`\nmax collision-free tolerance for distorted matching: ${safe} bit(s)`);
console.log(`(needs separation >= 2r+1; separation is ${minMangled.d})`);

console.log('\nfalse-positive probability per random 41-bit frame:');
const C = (n, k) => { let r = 1; for (let i = 0; i < k; i++) r = r * (n - i) / (i + 1); return r; };
for (const r of [0, 1, 2]) {
  let ball = 0;
  for (let k = 0; k <= r; k++) ball += C(41, k);
  console.log(`  tolerance ${r}: ${(7 * ball / 2 ** 41).toExponential(2)}`);
}
