// Does intersecting the candidate sets from two different buttons narrow the
// address? It does not — and this file exists so nobody spends an afternoon
// finding that out again.
//
//   node tools/intersect_test.js
//
// The idea is tempting: ask the user for a second button during pairing, derive
// candidates from both, and keep only the addresses consistent with each. But
// the address bits are IDENTICAL on every press, so the distortion leaves
// exactly the same ambiguity behind both times. 189 intersect 189 = 189.

const { DISTORTED } = require('../lib/codes');
const { candidateAddresses, BUTTON_IDS } = require('../lib/pairing');

const sets = {};
for (const [name, received] of Object.entries(DISTORTED)) {
  if (!BUTTON_IDS[name]) { console.log(`skip ${name} (no id)`); continue; }
  const candidates = candidateAddresses(received, name);
  sets[name] = new Set(candidates);
  console.log(`${name.padEnd(10)} -> ${candidates.length} candidates`);
}

console.log('\npairwise intersections:');
const keys = Object.keys(sets);
let narrowed = 0;
for (let i = 0; i < keys.length; i++) {
  for (let j = i + 1; j < keys.length; j++) {
    const a = sets[keys[i]];
    const b = sets[keys[j]];
    const inter = [...a].filter((x) => b.has(x));
    const smaller = Math.min(a.size, b.size);
    if (inter.length < smaller) narrowed++;
    console.log(`${`${keys[i]} x ${keys[j]}`.padEnd(26)}-> ${inter.length}`
      + (inter.length <= 3 ? `  ${inter.join(' ')}` : ''));
  }
}

console.log(narrowed
  ? `\n${narrowed} pair(s) DID narrow — the assumption in CLAUDE.md no longer holds.`
  : '\nNo pair narrows anything: every button carries the same ambiguity.');
process.exit(0);
