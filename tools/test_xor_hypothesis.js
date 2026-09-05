// Test the proposed frame structure:
//
//   address(24) + data(8) + (data XOR 0xEB)(8) + '0'
//
//   node tools/test_xor_hypothesis.js
//
// If it holds, the 16-bit "command" is really an 8-bit button id plus an 8-bit
// redundancy check derived ONLY from that id — which would mean the command
// carries nothing address-derived, and is therefore portable between units.
// That is exactly the assumption the pairing design rests on, so this is worth
// testing carefully rather than accepting.

const { COMMANDS } = require('../lib/pairing');

const b2n = (s) => parseInt(s, 2);
const hex = (n) => `0x${n.toString(16).toUpperCase().padStart(2, '0')}`;

console.log('=== the hypothesis, per button ===\n');
console.log('  button      data      check     data^0xEB   holds');
let allHold = true;
for (const [name, cmd] of Object.entries(COMMANDS)) {
  const data = b2n(cmd.slice(0, 8));
  const check = b2n(cmd.slice(8, 16));
  const expect = data ^ 0xEB;
  const ok = check === expect;
  if (!ok) allHold = false;
  console.log(`  ${name.padEnd(10)} ${cmd.slice(0, 8)} ${cmd.slice(8, 16)}`
    + `  ${hex(data)}^0xEB=${hex(expect)}  ${ok ? 'YES' : `NO (got ${hex(check)})`}`);
}
console.log(`\nholds for all ${Object.keys(COMMANDS).length} known buttons: ${allHold}`);

// Is 0xEB the only constant that works? If several do, the evidence is weaker.
const working = [];
for (let k = 0; k < 256; k++) {
  if (Object.values(COMMANDS).every((c) => b2n(c.slice(8, 16)) === (b2n(c.slice(0, 8)) ^ k))) {
    working.push(k);
  }
}
console.log(`\nconstants that satisfy all buttons: ${working.map(hex).join(', ') || 'none'}`);
console.log(`(a random constant would fit one button with p=1/256; fitting all`
  + ` ${Object.keys(COMMANDS).length} by chance is ~${(256 ** -(Object.keys(COMMANDS).length - 1)).toExponential(1)})`);

// What are the button ids, and do they look like anything?
console.log('\n=== the 8-bit button ids ===\n');
const ids = Object.entries(COMMANDS)
  .map(([n, c]) => ({ n, d: b2n(c.slice(0, 8)) }))
  .sort((a, b) => a.d - b.d);
for (const { n, d } of ids) {
  console.log(`  ${hex(d)}  ${d.toString(2).padStart(8, '0')}  ${d.toString().padStart(3)}  ${n}`);
}

const popcount = (n) => n.toString(2).split('').filter((c) => c === '1').length;
console.log('\n  popcount of each id: '
  + ids.map(({ d }) => popcount(d)).join(', '));
console.log('  (a constant popcount would suggest a one-hot/weighted encoding)');
