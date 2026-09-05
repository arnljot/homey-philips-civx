// Fit a context-dependent bit mapping from transmitted -> received.
//
//   node tools/fit_context.js
//
// A memoryless distortion cannot explain the observations: if each bit were
// mangled independently the output would be the input, its inverse, or a
// constant, and it is none of those. So the receiver's classification of each
// symbol depends on its neighbours — which is what an OOK slicer with a
// drifting threshold does, since the measured width of a pulse depends on the
// charge left by the preceding one.
//
// This tabulates candidate context models against the observed decodes and
// reports which (if any) is self-consistent. A consistent, invertible model can
// be undone in software: receive the mangled 41 bits, recover the true ones.

const { FRAMES } = require('../lib/codes');

// Dominant decodes observed over the air, 2026-09-04.
const OBSERVED = {
  speed_2: '11000000000100000111000000000000100110000',
  speed_5: '11000000000100000111000000111110000000001',
  off: '11000000000100000111000001100111000000001',
};

const MODELS = {
  'prev,cur': (b, i) => `${i > 0 ? b[i - 1] : 'x'}${b[i]}`,
  'cur,next': (b, i) => `${b[i]}${i < b.length - 1 ? b[i + 1] : 'x'}`,
  'prev,cur,next': (b, i) => `${i > 0 ? b[i - 1] : 'x'}${b[i]}${i < b.length - 1 ? b[i + 1] : 'x'}`,
  'cur only (memoryless)': (b, i) => `${b[i]}`,
};

for (const [name, ctx] of Object.entries(MODELS)) {
  const table = new Map();      // context -> Set of observed outputs
  for (const [button, obs] of Object.entries(OBSERVED)) {
    const bits = FRAMES[button];
    for (let i = 0; i < 41; i++) {
      const key = ctx(bits, i);
      if (!table.has(key)) table.set(key, new Map());
      const outs = table.get(key);
      outs.set(obs[i], (outs.get(obs[i]) || 0) + 1);
    }
  }

  let ambiguous = 0;
  let total = 0;
  const rows = [];
  for (const [key, outs] of [...table.entries()].sort()) {
    const counts = [...outs.entries()].sort((a, b) => b[1] - a[1]);
    const n = counts.reduce((s, [, c]) => s + c, 0);
    const majority = counts[0][1];
    total += n;
    ambiguous += n - majority;
    rows.push(`    ${key.padEnd(5)} -> ${counts.map(([o, c]) => `${o}:${c}`).join('  ')}`
      + `   (${((majority / n) * 100).toFixed(0)}% consistent)`);
  }

  const consistency = ((total - ambiguous) / total) * 100;
  console.log(`\n=== model: ${name} ===   overall consistency ${consistency.toFixed(1)}%`);
  rows.forEach((r) => console.log(r));
}

console.log('\nA model is usable only at ~100%: every context must map to one output,');
console.log('otherwise the same input produces different bits and cannot be inverted.');
