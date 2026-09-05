// Does the address-discovery algorithm find the real address?
//
//   node tools/verify_pairing.js
//
// The runtime code no longer hardcodes an address — it has to derive each fan's
// from what Homey receives. This checks that it does, using the reference
// remote as ground truth: take the genuine hold-"1"+"2" capture, put it through
// the receiver's known distortion, and confirm the true address comes back in
// the candidate list.
//
// Ground truth (this remote only; nothing in the runtime may depend on it):
//   001010111100110100001101  = 0x2BCD0D

const fs = require('fs');
const path = require('path');
const {
  COMMANDS, PROBE_BUTTON, frameFor, candidateAddresses, modalFrame, distort,
} = require('../lib/pairing');

const TRUE_ADDRESS = '001010111100110100001101';

/** Decode every frame in a .sub capture. */
function decodeCapture(file) {
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
    if (bits.length >= 41) frames.push(bits.slice(0, 41));
  }
  return frames;
}

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `\n      ${detail}` : ''}`);
  if (!ok) failures++;
};

// --- 1. the capture is what we think it is --------------------------------
const transmitted = decodeCapture(path.join('captures', 'civx_hold_1_2.sub'));
const uniq = [...new Set(transmitted)];
check('hold 1+2 capture decodes to a single frame',
  uniq.length === 1, `${transmitted.length} frames, ${uniq.length} distinct`);
check('its command is the pairing command',
  uniq[0].slice(24, 40) === COMMANDS.pairing, uniq[0].slice(24, 40));
check('its address is the reference remote',
  uniq[0].slice(0, 24) === TRUE_ADDRESS, uniq[0].slice(0, 24));

// --- 2. what Homey would receive, and what we derive from it ---------------
const received = distort(uniq[0].split('').map(Number));
console.log(`\n  transmitted ${uniq[0]}`);
console.log(`  received    ${received}   (after the receiver's distortion)\n`);

const cands = candidateAddresses(received, 'pairing');
check('true address is among the candidates', cands.includes(TRUE_ADDRESS),
  `${cands.length} candidates, truth at index ${cands.indexOf(TRUE_ADDRESS)}`);

// --- 3. it must survive realistic reception noise --------------------------
// Real bursts arrive corrupted; the modal frame is what pairing would use.
const burst = [];
for (let i = 0; i < 55; i++) {
  const noisy = received.split('');
  if (i % 3 !== 0) {                      // two thirds of frames carry errors
    for (let k = 0; k < 1 + (i % 3); k++) {
      const p = (i * 7 + k * 13) % 41;
      noisy[p] = noisy[p] === '1' ? '0' : '1';
    }
  }
  burst.push(noisy.join(''));
}
const modal = modalFrame(burst);
check('modal frame of a noisy burst recovers the clean one',
  modal.bits === received, `${modal.count} of ${modal.total} frames agreed`);
check('candidates from the modal frame still contain the truth',
  candidateAddresses(modal.bits, 'pairing').includes(TRUE_ADDRESS));

// --- 4. frames rebuilt from a discovered address match the originals -------
const { CODES } = require('../lib/codes');
let rebuiltOk = true;
for (const name of Object.keys(CODES)) {
  if (frameFor(TRUE_ADDRESS, name).join('') !== CODES[name]) rebuiltOk = false;
}
check('all 7 buttons rebuild exactly from address + command', rebuiltOk);

// --- 5. the probe must be gentle ------------------------------------------
check('probe button is the lowest speed, not the highest',
  PROBE_BUTTON === 'speed_1', PROBE_BUTTON);

console.log(`\n  candidates to walk: ${cands.length}`
  + `  (~${(cands.length * 0.052).toFixed(1)}s of probing at 1 frame each)`);
console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
