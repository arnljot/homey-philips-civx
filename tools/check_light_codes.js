// Why the RX matcher tracks the seven fan buttons only.
//
//   node tools/check_light_codes.js
//
// Reception is matched against the receiver's DISTORTED rendering of each code
// with a 1-bit tolerance, which is only safe while the distorted codes stay at
// least 3 bits apart (disjoint balls need 2r+1 <= 3). This measures that
// distance for the fan set as shipped, and again with the light codes added.

const { DISTORTED, distort } = require('../lib/codes');
const { BUTTON_IDS, CHECK_XOR } = require('../lib/pairing');

const REFERENCE_ADDRESS = '001010111100110100001101';
const TOLERANCE = 1;

const frameFor = (id) => {
  const byte = (n) => (n & 0xFF).toString(2).padStart(8, '0');
  return `${REFERENCE_ADDRESS}${byte(id)}${byte(id ^ CHECK_XOR)}0`;
};

const ham = (a, b) => [...a].reduce((s, c, i) => s + (c !== b[i] ? 1 : 0), 0);

function closest(set) {
  const keys = Object.keys(set);
  let best = { distance: Infinity, pair: '' };
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const d = ham(set[keys[i]], set[keys[j]]);
      if (d < best.distance) best = { distance: d, pair: `${keys[i]} vs ${keys[j]}` };
    }
  }
  return best;
}

const shipped = closest(DISTORTED);
console.log(`fan buttons only     : closest pair ${shipped.distance} bits (${shipped.pair})`);

const withLights = { ...DISTORTED };
for (const name of ['light_on', 'light_off']) {
  withLights[name] = distort(frameFor(BUTTON_IDS[name]).split('').map(Number));
}
const extended = closest(withLights);
console.log(`with the lights added: closest pair ${extended.distance} bits (${extended.pair})`);

const need = 2 * TOLERANCE + 1;
console.log(`\ntolerance ${TOLERANCE} needs >= ${need} bits between codes`);

let bad = 0;
if (shipped.distance < need) {
  console.log(`BAD  the shipped matcher is unsafe: ${shipped.distance} < ${need}`);
  bad++;
} else {
  console.log(`OK   shipped matcher is safe (${shipped.distance} >= ${need})`);
}
if (extended.distance >= need) {
  console.log('BAD  the lights would now be safe to add — this file documents the'
    + ' opposite, so either the codes or the tolerance changed. Re-check'
    + ' lib/codes.js before widening the matcher.');
  bad++;
} else {
  console.log(`OK   adding the lights would break it (${extended.distance} < ${need}),`
    + ' which is why RX tracks the fan buttons only');
}

process.exit(bad ? 1 : 0);
