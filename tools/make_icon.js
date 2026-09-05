// Generate the app/driver icon from the fan's measured geometry.
//
//   node tools/make_icon.js
//
// Proportions derived from the top-down render in
// `local/img/10057403 civx dimentions.webp`, measured rather than eyeballed:
//
//   hub outer radius      0.141 x blade tip radius
//   blade half-width      grows linearly, 0.081 -> 0.129 x tip radius
//   lamp disc             ~0.10 x tip radius, with a ring around it
//
// The blade sides are straight from root to the rounded tip, and taper inward
// toward the centre, matching the product. Kept deliberately simple: this is
// read at 75x75 px, and detail derived from pixel graphics would be invented.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// --- geometry, in a 100 x 100 box -----------------------------------------
const C = 50;            // centre
const TIP = 44;          // blade tip radius
// Measured hub/tip is 0.141. Enlarged ~20% here on purpose: at 75x75 the ring
// and the gap around the lamp are each about a pixel wide, and the three
// circles are the feature that distinguishes this fan from a generic propeller.
// Legibility at icon sizes beats strict fidelity.
const HUB = TIP * 0.170; // outer edge of the hub body
const RING = TIP * 0.133; // inner edge of the ring around the lamp
const LAMP = TIP * 0.096; // the lamp itself
const ROOT = HUB * 0.90;  // blades start just inside the hub so they merge
const W0 = TIP * 0.081;  // blade half-width at the root
const W1 = TIP * 0.129;  // blade half-width at the tip
const CAP = W1;          // the rounded end is a semicircle of that half-width
const ANGLES = [-150, -30, 90];

const r2 = (n) => Math.round(n * 100) / 100;

/** One blade, pointing along +x from the centre, as an SVG path. */
function bladePath() {
  const straight = TIP - CAP;
  return `M ${r2(C + ROOT)} ${r2(C - W0)}`
    + ` L ${r2(C + straight)} ${r2(C - W1)}`
    + ` A ${r2(CAP)} ${r2(CAP)} 0 0 1 ${r2(C + straight)} ${r2(C + W1)}`
    + ` L ${r2(C + ROOT)} ${r2(C + W0)} Z`;
}

/** Circle as a two-arc subpath, so several can share one even-odd path. */
const circle = (r) => `M ${r2(C - r)} ${C} a ${r2(r)} ${r2(r)} 0 1 0 ${r2(2 * r)} 0`
  + ` a ${r2(r)} ${r2(r)} 0 1 0 ${r2(-2 * r)} 0`;

// Even-odd across three nested circles gives: filled ring, gap, filled lamp —
// which is how a flat silhouette can show "a lamp with a ring around it".
const hubPath = `${circle(HUB)} ${circle(RING)} ${circle(LAMP)}`;

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
  <title>Philips Civx ceiling fan</title>
  <g fill="#000000">
${ANGLES.map((a) => `    <path d="${bladePath()}" transform="rotate(${a} ${C} ${C})"/>`).join('\n')}
    <path d="${hubPath}" fill-rule="evenodd"/>
  </g>
</svg>
`;

// --- rasteriser: same geometry, so PNGs cannot drift from the SVG ----------
function inBlade(x, y, angleDeg) {
  const t = (-angleDeg * Math.PI) / 180;
  const dx = x - C;
  const dy = y - C;
  const u = dx * Math.cos(t) - dy * Math.sin(t);
  const v = dx * Math.sin(t) + dy * Math.cos(t);
  const straight = TIP - CAP;
  if (u < ROOT) return false;
  if (u <= straight) {
    const half = W0 + ((W1 - W0) * (u - ROOT)) / (straight - ROOT);
    return Math.abs(v) <= half;
  }
  return (u - straight) ** 2 + v ** 2 <= CAP * CAP;
}

function isInk(x, y) {
  const r = Math.hypot(x - C, y - C);
  if (r <= LAMP) return true;              // lamp
  if (r <= RING) return false;             // gap between lamp and ring
  if (r <= HUB) return true;               // ring / hub body
  return ANGLES.some((a) => inBlade(x, y, a));
}

// --- PNG writer ------------------------------------------------------------
function crc32(buf) {
  let c; const t = [];
  for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  let crc = 0xFFFFFFFF;
  for (const b of buf) crc = t[(crc ^ b) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, c]);
}
function png(w, h, pix) {
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 3)] = 0;
    for (let x = 0; x < w; x++) {
      const [r, g, b] = pix(x, y);
      const o = y * (1 + w * 3) + 1 + x * 3;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const BG1 = [0x0B, 0x2E, 0x59]; const BG2 = [0x12, 0x6E, 0xC4]; const FG = [0xFF, 0xFF, 0xFF];
const mix = (a, b, t) => [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t));

function render(w, h, scale) {
  const cx = w / 2; const cy = h / 2;
  const S = (Math.min(w, h) * scale) / 100;   // px per icon unit
  return png(w, h, (x, y) => {
    const base = mix(BG1, BG2, (x / w) * 0.55 + (y / h) * 0.45);
    let acc = 0;
    for (const dx of [0.25, 0.75]) {
      for (const dy of [0.25, 0.75]) {
        if (isInk((x + dx - cx) / S + C, (y + dy - cy) / S + C)) acc++;
      }
    }
    const a = acc / 4;
    return a ? mix(base, FG, a) : base;
  });
}

const root = process.argv[2] || '.';
fs.writeFileSync(path.join(root, 'assets/icon.svg'), svg);
fs.writeFileSync(path.join(root, 'drivers/civx-fan/assets/icon.svg'), svg);

const out = [
  // App images are wide (10:7); scaling to the short side leaves the fan
  // looking lost, so these run tighter than the square driver images.
  ['assets/images/small.png', 250, 175, 0.95],
  ['assets/images/large.png', 500, 350, 0.95],
  ['assets/images/xlarge.png', 1000, 700, 0.95],
  ['drivers/civx-fan/assets/images/small.png', 75, 75, 0.92],
  ['drivers/civx-fan/assets/images/large.png', 500, 500, 0.92],
  ['drivers/civx-fan/assets/images/xlarge.png', 1000, 1000, 0.92],
];
for (const [p, w, h, s] of out) {
  fs.writeFileSync(path.join(root, p), render(w, h, s));
  console.log(`wrote ${p}  ${w}x${h}`);
}
console.log('wrote assets/icon.svg and drivers/civx-fan/assets/icon.svg');
console.log(`\ngeometry: tip ${TIP}, hub ${r2(HUB)}, ring ${r2(RING)}, lamp ${r2(LAMP)},`
  + ` blade half-width ${r2(W0)} -> ${r2(W1)}`);

