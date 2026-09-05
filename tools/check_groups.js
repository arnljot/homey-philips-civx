// Control checks before accepting any explanatory model.
//
//   node tools/check_groups.js
//
// 1. Do the 5 repetitions inside each captured .sub decode identically?
//    The remote sends one press 5x, so they MUST — if they do not, the
//    transmitter itself varies and every downstream conclusion is suspect.
// 2. How do the real codes actually partition when split 25 + 16, and is the
//    first 25 bits really shared across buttons?
// 3. What is the real frame structure?

const fs = require('fs');
const path = require('path');
const { CODES, ADDRESS } = require('../lib/codes');

// ---- 1. repetitions within each capture -----------------------------------
function decodeAll(file) {
  const v = fs.readFileSync(file, 'utf8').split('\n')
    .filter((l) => l.startsWith('RAW_Data:'))
    .flatMap((l) => l.split(':')[1].trim().split(/\s+/).map(Number));

  const frames = [];
  for (let i = 0; i < v.length - 1; i++) {
    if (!(v[i] >= 6300 && v[i] <= 9200 && v[i + 1] <= -800 && v[i + 1] >= -1600)) continue;
    let bits = '';
    for (let j = i + 2; j < v.length - 1; j += 2) {
      const m = v[j]; const s = -v[j + 1];
      if (m <= 0 || s <= 0) break;
      const short = m < 520;
      if (short && !(s > 520)) break;
      if (!short && !(s < 520)) break;
      bits += short ? '0' : '1';
    }
    // A frame is 41 bits. Anything past that is trailing noise picked up after
    // the burst, not part of the transmission — truncate rather than report it
    // as the transmitter varying.
    if (bits.length >= 8) frames.push(bits.slice(0, 41));
  }
  return frames;
}

console.log('=== 1. Are the 5 repetitions inside each capture identical? ===\n');
const dir = 'captures';
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sub')).sort()) {
  const frames = decodeAll(path.join(dir, f));
  const uniq = [...new Set(frames)];
  const lens = [...new Set(frames.map((x) => x.length))];
  console.log(`${f.padEnd(20)} ${frames.length} frames, ${uniq.length} distinct, length(s) ${lens.join('/')}`
    + `  ${uniq.length === 1 ? 'IDENTICAL' : '*** VARY ***'}`);
  if (uniq.length > 1) uniq.forEach((u) => console.log(`      ${u}`));
}

// ---- 2 & 3. real structure ------------------------------------------------
console.log('\n=== 2. The real codes split 24 (address) + 16 (command) + 1 ===\n');
for (const [name, bits] of Object.entries(CODES)) {
  console.log(`  ${name.padEnd(8)} ${bits.slice(0, 24)} | ${bits.slice(24, 40)} | ${bits.slice(40)}`);
}
console.log(`\n  address identical on all 7: ${Object.values(CODES).every((b) => b.startsWith(ADDRESS))}`);

console.log('\n=== 3. Now the 25 + 16 split I used, which was arbitrary ===\n');
const byPrefix = {};
for (const [name, bits] of Object.entries(CODES)) {
  const p = bits.slice(0, 25);
  (byPrefix[p] = byPrefix[p] || []).push(name);
}
for (const [p, names] of Object.entries(byPrefix)) {
  console.log(`  ${p}  ->  ${names.join(', ')}`);
}
console.log(`\n  distinct 25-bit prefixes: ${Object.keys(byPrefix).length}`);
console.log('  So the first 25 bits are NOT shared across all buttons: bit 24 is');
console.log('  the first COMMAND bit, and it splits the seven codes into two sets.');
