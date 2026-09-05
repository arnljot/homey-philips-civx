// What does holding "1"+"2" (the manual's pairing gesture) actually transmit?
//
//   node tools/analyse_pairing.js
//
// The manual's learning procedure is: mains on, then within 10 s hold "1" and
// "2" for ~3 s until the receiver beeps twice. If that gesture sends a distinct
// frame carrying the remote's address, an app could learn a user's address from
// a single gesture — which is what a generic pairing flow needs, since the
// address is learned per unit and differs between fans.

const fs = require('fs');
const path = require('path');
const { CODES, ADDRESS } = require('../lib/codes');

function decode(file) {
  const v = fs.readFileSync(file, 'utf8').split('\n')
    .filter((l) => l.startsWith('RAW_Data:'))
    .flatMap((l) => l.split(':')[1].trim().split(/\s+/).map(Number));
  const frames = [];
  const gaps = [];
  let lastEnd = null;
  for (let i = 0; i < v.length - 1; i++) {
    if (!(v[i] >= 6300 && v[i] <= 9200 && v[i + 1] <= -800 && v[i + 1] >= -1600)) continue;
    let bits = '';
    let j = i + 2;
    for (; j < v.length - 1; j += 2) {
      const m = v[j]; const s = -v[j + 1];
      if (m <= 0 || s <= 0) break;
      const short = m < 520;
      if (short && !(s > 520)) break;
      if (!short && !(s < 520)) break;
      bits += short ? '0' : '1';
    }
    if (bits.length >= 8) {
      if (lastEnd !== null) {
        gaps.push(v.slice(lastEnd, i).reduce((a, b) => a + Math.abs(b), 0));
      }
      frames.push(bits.slice(0, 41));
      lastEnd = j;
    }
  }
  return { frames, gaps };
}

const file = path.join('captures', 'civx_hold_1_2.sub');
const { frames, gaps } = decode(file);
const uniq = [...new Set(frames)];

console.log(`${file}: ${frames.length} frames, ${uniq.length} distinct\n`);
for (const u of uniq) {
  console.log(`  bits    ${u}`);
  console.log(`  split   ${u.slice(0, 24)} | ${u.slice(24, 40)} | ${u.slice(40)}`);
  console.log(`  hex     0x${BigInt('0b' + u).toString(16).toUpperCase()}`);
  console.log(`  address matches the known remote: ${u.startsWith(ADDRESS)}`);
  const known = Object.entries(CODES).find(([, b]) => b === u);
  console.log(`  same as a known button: ${known ? known[0] : 'NO — this is a distinct code'}`);
}

console.log('\ncommand field vs the seven known buttons:');
const cmd = uniq[0].slice(24, 40);
for (const [name, bits] of Object.entries(CODES)) {
  let d = 0;
  for (let i = 0; i < 16; i++) if (bits.slice(24, 40)[i] !== cmd[i]) d++;
  console.log(`  ${name.padEnd(8)} ${bits.slice(24, 40)}  differs in ${d}/16 bits`);
}

if (gaps.length) {
  const ms = gaps.map((g) => g / 1000);
  ms.sort((a, b) => a - b);
  console.log(`\ninter-frame gaps: min ${ms[0].toFixed(1)}ms`
    + `  median ${ms[ms.length >> 1].toFixed(1)}ms  max ${ms[ms.length - 1].toFixed(1)}ms`);
  console.log(`total frames while held: ${frames.length}`);
}
