// Verify the receiver's transform and check the mangled codes stay distinct.
//
//   node tools/verify_transform.js
//
// Fitted from observed decodes (tools/fit_context.js): Homey reports a 1 only
// when the PREVIOUS transmitted bit was 0 and the current one is 0. Physically
// that is a slicer measuring each mark against the previous symbol's space
// before its threshold has recovered — which is why every memoryless distortion
// model failed to explain the data.
//
// If applying this transform to our seven known codes reproduces what was
// observed, and the seven results stay far apart from each other, then RX can
// be made to work by matching against the MANGLED codes instead of trying to
// decode correctly.

const { CODES, FRAMES } = require('../lib/codes');

/** Apply the receiver's observed transform to a transmitted bit sequence. */
function mangle(bits) {
  let out = '';
  for (let i = 0; i < bits.length; i++) {
    const prev = i > 0 ? bits[i - 1] : 0;   // 'x0' behaved as '00'
    out += (prev === 0 && bits[i] === 0) ? '1' : '0';
  }
  return out;
}

const OBSERVED = {
  speed_2: '11000000000100000111000000000000100110000',
  speed_5: '11000000000100000111000000111110000000001',
  off: '11000000000100000111000001100111000000001',
};

const hamming = (a, b) => {
  let h = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) h++;
  return h;
};

console.log('=== predicted vs observed ===\n');
let worst = 0;
for (const [name, obs] of Object.entries(OBSERVED)) {
  const pred = mangle(FRAMES[name]);
  const d = hamming(pred, obs);
  worst = Math.max(worst, d);
  console.log(`${name}`);
  console.log(`  predicted ${pred}`);
  console.log(`  observed  ${obs}`);
  console.log(`  mismatch  ${d} of 41\n`);
}
console.log(`worst mismatch: ${worst} of 41\n`);

console.log('=== mangled codes for all 7 buttons ===\n');
const mangled = {};
for (const name of Object.keys(CODES)) {
  mangled[name] = mangle(FRAMES[name]);
  console.log(`  ${name.padEnd(8)} ${mangled[name]}`);
}

console.log('\n=== pairwise distance between mangled codes ===');
console.log('(they must stay far apart, or two buttons become indistinguishable)\n');
const names = Object.keys(mangled);
let minPair = { d: Infinity, a: '', b: '' };
for (let i = 0; i < names.length; i++) {
  for (let j = i + 1; j < names.length; j++) {
    const d = hamming(mangled[names[i]], mangled[names[j]]);
    if (d < minPair.d) minPair = { d, a: names[i], b: names[j] };
  }
}
console.log(`  closest pair: ${minPair.a} vs ${minPair.b} -> ${minPair.d} bits apart`);

// How much of the payload survives? If the transform maps many codes onto few
// outputs it destroys information regardless of how we match.
const unique = new Set(Object.values(mangled));
console.log(`  distinct mangled codes: ${unique.size} of ${names.length}`);
console.log(`\nUsable if the closest pair is comfortably above the observed noise`);
console.log(`(worst mismatch above), so a received frame cannot be attributed to`);
console.log(`the wrong button.`);
