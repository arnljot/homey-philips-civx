// Re-derive the symbol timings from the Flipper captures, showing exactly which
// part of each recording was used.
//
//   node tools/timing_stats.js captures
//
// The Flipper recordings contain dead time and receiver noise before and after
// the button press (record was started by hand, then the button pressed, then
// stop). This locates the burst by its 7370us sync and measures ONLY the frames
// inside it, so that leading/trailing silence cannot bias the numbers.

const fs = require('fs');
const path = require('path');

const dir = process.argv[2] || 'captures';

function load(file) {
  return fs.readFileSync(file, 'utf8').split('\n')
    .filter((l) => l.startsWith('RAW_Data:'))
    .flatMap((l) => l.split(':')[1].trim().split(/\s+/).map(Number));
}

function stats(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return { n: a.length, min: s[0], med: s[s.length >> 1], max: s[s.length - 1] };
}

const agg = { syncMark: [], syncSpace: [], shortMark: [], longMark: [], shortSpace: [], longSpace: [] };

for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sub')).sort()) {
  const v = load(path.join(dir, file));

  // Locate every sync: a 6300-9200us mark followed by an 800-1600us space.
  const syncs = [];
  for (let i = 0; i < v.length - 1; i++) {
    if (v[i] >= 6300 && v[i] <= 9200 && v[i + 1] <= -800 && v[i + 1] >= -1600) syncs.push(i);
  }
  if (!syncs.length) { console.log(`${file}: no sync found`); continue; }

  const first = syncs[0];
  const last = syncs[syncs.length - 1];
  // Time from the start of the recording to the first sync, in ms.
  const lead = v.slice(0, first).reduce((s, x) => s + Math.abs(x), 0) / 1000;
  const tail = v.slice(last + 2 + 82).reduce((s, x) => s + Math.abs(x), 0) / 1000;

  let bits = 0;
  for (const s of syncs) {
    agg.syncMark.push(v[s]);
    agg.syncSpace.push(-v[s + 1]);
    for (let j = s + 2; j < s + 2 + 82 && j < v.length - 1; j += 2) {
      const m = v[j]; const sp = -v[j + 1];
      if (m <= 0 || sp <= 0) break;
      if (m < 520) { agg.shortMark.push(m); agg.longSpace.push(sp); } else { agg.longMark.push(m); agg.shortSpace.push(sp); }
      bits++;
    }
  }
  console.log(
    `${file.padEnd(20)} frames=${syncs.length} bits=${bits}`
    + `  dead-time before=${lead.toFixed(0)}ms after=${tail.toFixed(0)}ms`
    + `  burst=${((v.slice(first, last + 2 + 82).reduce((s, x) => s + Math.abs(x), 0)) / 1000).toFixed(0)}ms`,
  );
}

console.log('\nSymbol timings measured INSIDE the bursts only (us):');
for (const [k, a] of Object.entries(agg)) {
  const s = stats(a);
  if (s) console.log(`  ${k.padEnd(11)} n=${String(s.n).padStart(4)}  min=${s.min}  median=${s.med}  max=${s.max}`);
}

const p0 = stats(agg.shortMark).med + stats(agg.longSpace).med;
const p1 = stats(agg.longMark).med + stats(agg.shortSpace).med;
console.log(`\nBit period: 0 -> ${p0}us, 1 -> ${p1}us  (difference ${Math.abs(p0 - p1)}us)`);
console.log(`Duty cycle: 0 -> ${(stats(agg.shortMark).med / p0 * 100).toFixed(1)}%, `
  + `1 -> ${(stats(agg.longMark).med / p1 * 100).toFixed(1)}%`);
