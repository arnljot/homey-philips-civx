// Out-of-sample scoring of the receiver-transform model.
//
//   node tools/score_predictions.js
//
// The model was fitted on speed_2, speed_5 and off, then tested on the same
// three — circular, so its apparent accuracy meant nothing. These observations
// are from buttons the model never saw. Predictions were recorded before the
// data arrived.
//
// Each observed payload is scored against ALL seven predicted codes, so a match
// only counts if it is unambiguously closer to one than to the others.

const { CODES, FRAMES } = require('../lib/codes');

/** The fitted transform: a 1 only when the previous and current bits are both 0. */
function mangle(bits) {
  let out = '';
  for (let i = 0; i < bits.length; i++) {
    const prev = i > 0 ? bits[i - 1] : 0;
    out += (prev === 0 && bits[i] === 0) ? '1' : '0';
  }
  return out;
}

const predicted = {};
for (const name of Object.keys(CODES)) predicted[name] = mangle(FRAMES[name]);

// Observed 2026-09-04, two bursts, buttons not yet disclosed.
const BURSTS = {
  'burst 1 (12:43:47)': [
    ['x6', '11000000000100000111000000011100000000111'],
    ['x4', '11000000000100001111000000011100000000100'],
    ['x4', '11000000000100000111000000011110000000001'],
  ],
  'burst 2 (12:44:01)': [
    ['x10', '11000000000100000111000000100001100000000'],
    ['x10', '11000000000100000111000000100000000000011'],
    ['x6', '11000000000100000111000000100000100000000'],
  ],
  'burst 3 (12:44:16)': [
    ['x10', '11000000000100000111000001001110000100001'],
    ['x4', '11000000000100000111000000100000100000000'],
    ['x4', '11000000000100000111000001001111000100000'],
  ],
  'burst 4 (12:44:29)': [
    ['x10', '11000000000100000111000000110000100010000'],
    ['x8', '11000000000100000111000001001100000100111'],
    ['x2', '11000000000100000111000001001111000100000'],
  ],
  'burst 5 (12:44:44)': [
    ['x8', '11000000000100000111000000110001100010001'],
    ['x4', '11000000000100000111000000110000000010001'],
    ['x4', '11000000000100000111000011100100000000111'],
  ],
};

const hamming = (a, b) => {
  let h = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) h++;
  return h;
};

for (const [label, rows] of Object.entries(BURSTS)) {
  console.log(`\n=== ${label} ===`);
  for (const [count, obs] of rows) {
    const scored = Object.entries(predicted)
      .map(([name, p]) => ({ name, d: hamming(obs, p) }))
      .sort((a, b) => a.d - b.d);
    const best = scored[0];
    const runnerUp = scored[1];
    const margin = runnerUp.d - best.d;
    console.log(`\n  ${count}  ${obs}`);
    console.log(`      best: ${best.name} d=${best.d}   runner-up: ${runnerUp.name} d=${runnerUp.d}`
      + `   margin=${margin}`);
    console.log(`      all: ${scored.map((s) => `${s.name}=${s.d}`).join('  ')}`);
  }
}

console.log('\n\n=== predictions on record (fitted WITHOUT these buttons) ===');
for (const [n, p] of Object.entries(predicted)) console.log(`  ${n.padEnd(8)} ${p}`);
