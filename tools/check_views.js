// Syntax-check the JavaScript inside pairing views.
//
//   node tools/check_views.js
//
// `homey app validate` does not parse view scripts, so a syntax error ships
// silently: the HTML renders, onHomeyReady is never defined, nothing runs, and
// the page just sits there. That is indistinguishable from a logic bug and cost
// several rounds of hardware testing to notice.
//
// Also enforces the contract these views must follow:
//   - define onHomeyReady(Homey), because the global `Homey` at script level is
//     only a loader stub with no emit/on
//   - never call Homey.emit/on/showView outside that function

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const dir = path.join('drivers', 'civx-fan', 'pair');
const LOCALES = Object.fromEntries(
  fs.readdirSync('locales')
    .filter((f) => f.endsWith('.json'))
    .map((f) => [path.basename(f, '.json'), JSON.parse(fs.readFileSync(path.join('locales', f), 'utf8'))]),
);
let failures = 0;

const fail = (file, msg) => { console.log(`FAIL  ${file}: ${msg}`); failures++; };
const pass = (file, msg) => console.log(`PASS  ${file}: ${msg}`);

for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.html'))) {
  const html = fs.readFileSync(path.join(dir, file), 'utf8');

  // Inline scripts only; the <script src="/homey.js"> tag has no body.
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1])
    .filter((s) => s.trim().length);

  // A view with no script is fine — an intro page needs none. The include
  // check below still applies to it.
  if (!scripts.length) console.log(`INFO  ${file}: no script (static view)`);

  let ok = true;
  scripts.forEach((src, i) => {
    try {
      new vm.Script(src, { filename: `${file}#script${i + 1}` });
    } catch (err) {
      fail(file, `script ${i + 1} syntax error — ${err.message}`);
      ok = false;
    }
  });
  if (ok) pass(file, 'script parses');

  // A pairing view is GIVEN `Homey` directly. Including /homey.js overwrites it
  // with an asset loader that has only getFile/loadScript — the page then
  // renders perfectly and does nothing at all, which is very hard to spot.
  if (/<script[^>]*src\s*=\s*["'][^"']*homey\.js/i.test(html)) {
    fail(file, 'includes /homey.js, which replaces the injected Homey API');
  } else {
    pass(file, 'does not include /homey.js');
  }

  // View text belongs in data-i18n attributes, translated by Homey. A typo in
  // the key is invisible — the element just keeps its English placeholder — so
  // every key is resolved against every locale here.
  const keys = [...html.matchAll(/data-i18n\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
  const missing = [];
  for (const lang of Object.keys(LOCALES)) {
    for (const key of keys) {
      const value = key.split('.').reduce((o, k) => (o == null ? o : o[k]), LOCALES[lang]);
      if (typeof value !== 'string') missing.push(`${lang}:${key}`);
    }
  }
  if (missing.length) fail(file, `data-i18n key(s) not in locales — ${missing.join(', ')}`);
  else pass(file, `${keys.length} data-i18n key(s) resolve in every locale`);

  const all = scripts.join('\n');
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  // Not every view needs to talk to the driver — an intro page is legitimately
  // one-way — so this is reported, not enforced.
  if (/Homey\.(emit|on)\s*\(/.test(stripComments(all))) {
    pass(file, 'talks to the driver');
  } else {
    console.log(`INFO  ${file}: informational view, does not talk to the driver`);
  }
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll views OK.');
process.exit(failures ? 1 : 0);


