// Work out what Homey's receiver does to this remote's pulses.
//
//   node tools/solve_distortion.js
//
// We know exactly what the remote transmits (measured from the Flipper
// captures) and exactly what Homey decodes it into (observed over the air).
// Homey's decoder is a simple window classifier: for each mark/space pair it
// tests word0 then word1, each with a +/-`sensitivity` tolerance, and ends the
// frame when neither matches. So if we assume the receiver distorts every pulse
// by some function, we can simulate the classifier and search for the
// distortion that reproduces the observed output.
//
// Find that, and the fix is simply to declare `words` at the DISTORTED timings
// so Homey classifies them correctly.

const { FRAMES } = require('../lib/codes');

// What the remote actually transmits (medians from tools/timing_stats.js).
const TX = { 0: [339, 722], 1: [729, 328] };

// What the app currently declares, and the tolerance the decoding used.
const W0 = [339, 722];
const W1 = [729, 328];
const SENS = 0.5;

// Observed dominant decodes, over the air, 2026-09-04.
const OBSERVED = {
  speed_2: '11000000000100000111000000000000100110000',
  speed_5: '11000000000100000111000000111110000000001',
  off: '11000000000100000111000001100111000000001',
};

const within = (v, target, sens) => v >= target * (1 - sens) && v <= target * (1 + sens);

/** Homey's classifier: word0 first, then word1, else end of frame. */
function classify(mark, space, w0, w1, sens) {
  if (within(mark, w0[0], sens) && within(space, w0[1], sens)) return 0;
  if (within(mark, w1[0], sens) && within(space, w1[1], sens)) return 1;
  return null;
}

/**
 * Simulate reception of `bits` through a distortion, then decode.
 * @param {number[]} bits transmitted bits
 * @param {(v:number)=>number} fMark distortion applied to every mark
 * @param {(v:number)=>number} fSpace distortion applied to every space
 */
function simulate(bits, fMark, fSpace) {
  let out = '';
  for (const b of bits) {
    const [m, s] = TX[b];
    const w = classify(fMark(m), fSpace(s), W0, W1, SENS);
    if (w === null) break;      // decoder ends the frame here
    out += String(w);
  }
  return out;
}

function hamming(a, b) {
  if (a.length !== b.length) return Infinity;
  let h = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) h++;
  return h;
}

// Search an affine distortion: mark' = a*mark + b, and the space absorbs the
// complement so the bit period stays constant (what a slicer threshold shift
// does physically).
let results = [];
for (let a = 0.4; a <= 2.0; a += 0.02) {
  for (let b = -400; b <= 400; b += 5) {
    const fMark = (m) => m * a + b;
    const fSpace = (s, m) => s;  // placeholder, replaced below
    // Period-preserving: whatever the mark gains, the space loses.
    const score = Object.entries(OBSERVED).reduce((acc, [name, obs]) => {
      const bits = FRAMES[name];
      let out = '';
      for (const bit of bits) {
        const [m, s] = TX[bit];
        const m2 = m * a + b;
        const s2 = (m + s) - m2;               // constant period
        const w = classify(m2, s2, W0, W1, SENS);
        if (w === null) break;
        out += String(w);
      }
      return acc + (out.length === 41 ? hamming(out, obs) : 100 + (41 - out.length));
    }, 0);
    results.push({ a: +a.toFixed(2), b, score });
  }
}
results.sort((x, y) => x.score - y.score);

console.log('Best affine mark distortions (mark\' = a*mark + b, period preserved)');
console.log('total mismatch across speed_2, speed_5 and off  (0 = perfect model)\n');
for (const r of results.slice(0, 12)) {
  console.log(`  a=${String(r.a).padStart(5)}  b=${String(r.b).padStart(5)}us  score=${r.score}`);
}

const best = results[0];
console.log(`\nBest model: mark' = ${best.a} * mark + ${best.b}us`);
console.log(`  bit 0 mark ${TX[0][0]}us -> ${Math.round(TX[0][0] * best.a + best.b)}us`);
console.log(`  bit 1 mark ${TX[1][0]}us -> ${Math.round(TX[1][0] * best.a + best.b)}us`);

console.log('\nPer-button check with that model:');
for (const [name, obs] of Object.entries(OBSERVED)) {
  let out = '';
  for (const bit of FRAMES[name]) {
    const [m, s] = TX[bit];
    const m2 = m * best.a + best.b;
    const s2 = (m + s) - m2;
    const w = classify(m2, s2, W0, W1, SENS);
    if (w === null) break;
    out += String(w);
  }
  console.log(`  ${name.padEnd(8)} simulated ${out || '(no frame)'}`);
  console.log(`  ${''.padEnd(8)} observed  ${obs}`);
  console.log(`  ${''.padEnd(8)} mismatch  ${hamming(out, obs)} of 41\n`);
}
