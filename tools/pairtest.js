// Offline test of the guided pairing flow.
//
//   node tools/pairtest.js .
//
// Drives the REAL driver's onPair() against a stubbed Homey and a simulated
// fan, so the binary search can be checked without anyone standing under a
// ceiling fan answering questions.
//
// The simulated fan is deliberately strict, matching what was measured on
// hardware: it reacts ONLY to its exact address. Addresses one bit wrong moved
// the real fan not at all.

const Module = require('module');
const path = require('path');

const ROOT = path.resolve(process.argv[2] || '.');

class Base {
  log(...a) { if (process.env.VERBOSE) console.log('   [log]', ...a); }
  error(...a) { console.log('   [err]', ...a); }
}
const FAKE_HOMEY = { App: class extends Base {}, Driver: class extends Base {}, Device: class extends Base {} };
const orig = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'homey') return FAKE_HOMEY;
  return orig.call(this, req, ...rest);
};

const Driver = require(path.join(ROOT, 'drivers/civx-fan/driver.js'));
const { FRAMES } = require(path.join(ROOT, 'lib/codes.js'));
const {
  distort, candidateAddresses, frameForId, BUTTON_IDS,
} = require(path.join(ROOT, 'lib/pairing.js'));

const TRUE_ADDRESS = '001010111100110100001101';

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `\n      ${detail}` : ''}`);
  if (!ok) failures++;
};

function makeDriver(fan) {
  const dr = new Driver();
  let payloadHandler = null;
  Object.assign(dr, {
    homey: {
      rf: {
        getSignal433: () => ({
          on: (ev, fn) => { if (ev === 'payload') payloadHandler = fn; },
          enableRX: async () => {},
          tx: async (frame) => fan.receive(frame.join('')),
        }),
      },
      setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 1)),
      setInterval: (fn, ms) => setInterval(fn, Math.min(ms, 1)),
      clearInterval: (t) => clearInterval(t),
      __: (key, vars) => `${key}${vars ? ` ${JSON.stringify(vars)}` : ''}`,
    },
    getDevices: () => [],
  });
  dr._fire = (bits) => payloadHandler(bits.split('').map(Number), true);
  return dr;
}

/** A fan that obeys exactly one address, as measured on hardware. */
function makeFan(address) {
  return {
    address,
    speed: 0,
    light: false,
    commands: [],
    receive(bits) {
      this.commands.push(bits);
      if (bits.slice(0, 24) !== this.address) return;   // exact match only
      const id = parseInt(bits.slice(24, 32), 2);
      if (id === BUTTON_IDS.off) this.speed = 0;
      else if (id === BUTTON_IDS.speed_1) this.speed = 1;
      else if (id === BUTTON_IDS.light_on) this.light = true;
      else if (id === BUTTON_IDS.light_off) this.light = false;
    },
  };
}

/**
 * A pairing session.
 *
 * The driver both pushes (session.emit -> Homey.on in the view) and answers
 * polls (Homey.emit -> handler return value). Push is the responsive path; the
 * poll handlers are a fallback that costs nothing and keeps the flow working if
 * a push is ever missed. This records pushes so both can be asserted.
 */
function makeSession(log) {
  const handlers = {};
  return {
    handlers,
    setHandler(name, fn) { handlers[name] = fn; },
    async emit(event, data) { log.push({ event, data }); return undefined; },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Drive the probe exactly as the view does: poll for state, answer when asked
 * by looking at the simulated fan, and stop on a terminal phase.
 *
 * The answer is what an honest user gives: the question names the change that
 * should have happened ("did the light come on?"), so it is answered against
 * the thing's state now, not against whether anything moved at all.
 */
async function runProbe(handlers, fan, medium = 'light', budgetMs = 20000) {
  await handlers.probe_start({ medium });
  const deadline = Date.now() + budgetMs;
  let asks = 0;
  let lastRound = -1;
  while (Date.now() < deadline) {
    const s = await handlers.probe_poll();
    if (['found', 'failed', 'exists'].includes(s.phase)) return { ...s, asks };
    if (s.phase === 'ask' && s.round !== lastRound) {
      lastRound = s.round;
      asks += 1;
      const on = medium === 'fan' ? fan.speed > 0 : fan.light;
      await handlers.probe_answer({ reacted: s.expect === 'on' ? on : !on });
    }
    await sleep(5);
  }
  return { phase: 'timeout', asks };
}

(async () => {
  const fan = makeFan(TRUE_ADDRESS);
  const driver = makeDriver(fan);
  await driver.onInit();

  const log = [];
  const session = makeSession(log);
  await driver.onPair(session);

  // --- listening -----------------------------------------------------------
  const received = distort(`${TRUE_ADDRESS}${'0110001010001001'}0`.split('').map(Number));
  await session.handlers.listen_start();
  for (let i = 0; i < 30; i++) {
    driver._fire(received);
    await sleep(2);
  }

  let listen = { phase: 'listening' };
  const listenDeadline = Date.now() + 5000;
  while (Date.now() < listenDeadline && listen.phase === 'listening') {
    listen = await session.handlers.listen_poll();
    await sleep(5);
  }

  check('listening produced a candidate set', listen.phase === 'done',
    `phase=${listen.phase}, ${listen.candidates} candidates`);
  check('candidate set matches the algorithm',
    listen.candidates === candidateAddresses(received, 'pairing').length);
  // Push is the responsive path: the view should be told, not have to discover.
  check('driver pushed listen progress to the view',
    log.some((l) => l.event === 'listen_progress'));
  check('driver pushed listen completion to the view',
    log.some((l) => l.event === 'listen_done'),
    log.map((l) => l.event).join(', '));

  // --- the binary search ---------------------------------------------------
  fan.commands.length = 0;
  const result = await runProbe(session.handlers, fan, 'light');

  check('pairing identified an address', result.phase === 'found',
    result.phase === 'found' ? result.address : `phase=${result.phase}`);
  check('it identified the CORRECT address', result.address === TRUE_ADDRESS,
    result.address ? `got ${result.address}` : '');
  check('search finished in a reasonable number of questions', result.asks <= 10,
    `${result.asks} questions`);
  check('the fan was never made to move', fan.speed === 0, `speed ${fan.speed}`);
  check('the light was left off', fan.light === false);
  check('driver pushed the probe questions too',
    log.some((l) => l.event === 'probe_ask') && log.some((l) => l.event === 'probe_found'));

  // Every transmission must be a well-formed frame for a real button.
  const ok = fan.commands.every((c) => /^[01]{41}$/.test(c)
    && [BUTTON_IDS.light_on, BUTTON_IDS.light_off].includes(parseInt(c.slice(24, 32), 2)));
  check('only the light was ever transmitted to', ok,
    `${fan.commands.length} frames sent`);

  // One batch per question, not a probe plus an undo: the whole search costs
  // about one pass over the candidates (95 + 48 + 24 + ...), not twice that.
  check('air time stayed close to one pass over the candidates',
    fan.commands.length <= listen.candidates * 1.35,
    `${fan.commands.length} frames for ${listen.candidates} candidates`);

  // No sweep before the first question: forcing a known starting state over the
  // air costs a full extra pass for what one press of the user's own remote
  // does instantly, and ten silent seconds reads as a hang.
  check('the search asked its first question without a warm-up sweep',
    fan.commands.length < listen.candidates * 1.35
      && parseInt(fan.commands[0].slice(24, 32), 2) === BUTTON_IDS.light_on,
    `first frame id 0x${parseInt(fan.commands[0].slice(24, 32), 2).toString(16)}`);

  // Homey's own add-device view finishes the pairing, so the handler behind it
  // must offer exactly the address the search found. A custom view calling
  // Homey.createDevice() sat on "adding the fan..." forever.
  // One address, two devices: the unit is a fan AND a ceiling light, and a zone
  // action reaches whichever class it names. Both come from one search.
  const listed = await session.handlers.list_devices();
  check('list_devices offers both the fan and the light on one address',
    listed.length === 2
      && listed.every((d) => d.data.address === TRUE_ADDRESS)
      && listed.map((d) => d.data.role).sort().join(',') === 'fan,light'
      && new Set(listed.map((d) => d.data.id)).size === 2,
    JSON.stringify(listed.map((d) => d.data)));

  // list_devices and add_devices are two halves of one template. With only the
  // first, the chosen device has nowhere to go: the pair session ends and Homey
  // offers the device outside the app's own flow.
  const pairFlow = require(path.join(ROOT, 'app.json')).drivers
    .find((d) => d.id === 'civx-fan').pair;
  const listView = pairFlow.find((v) => v.id === 'list_devices');
  check('the device list has an add step to commit to',
    !!listView && listView.navigation && listView.navigation.next === 'add_devices'
      && pairFlow.some((v) => v.id === 'add_devices' && v.template === 'add_devices'),
    pairFlow.map((v) => v.id).join(' -> '));

  // --- a noisy hold must be rejected, not guessed at -----------------------
  //
  // This is the regression that broke a full run on hardware: the old code
  // grabbed the modal of the first 12 frames and accepted ANY modal that
  // produced a non-empty candidate list. A frame seen twice out of twelve was
  // enough, the true address was then simply absent from the list, and every
  // question was answered "no" until the search failed.
  const noisy = makeFan(TRUE_ADDRESS);
  const d4 = makeDriver(noisy);
  await d4.onInit();
  const s4 = makeSession([]);
  await d4.onPair(s4);
  await s4.handlers.listen_start();
  for (let i = 0; i < 14; i++) {          // 14 frames, all different
    const bits = received.split('');
    bits[i % 41] = bits[i % 41] === '1' ? '0' : '1';
    bits[(i * 7 + 3) % 41] = bits[(i * 7 + 3) % 41] === '1' ? '0' : '1';
    d4._fire(bits.join(''));
    await sleep(2);
  }
  await sleep(2200);                      // let the burst-over check fire
  const noisyListen = await s4.handlers.listen_poll();
  check('a hold with no dominant frame is not turned into a candidate list',
    noisyListen.phase !== 'done',
    `phase=${noisyListen.phase}, ${noisyListen.candidates} candidates`);

  // ...and holding again properly must still work in the same session.
  for (let i = 0; i < 25; i++) { d4._fire(received); await sleep(2); }
  let recovered = { phase: 'listening' };
  const recoverDeadline = Date.now() + 6000;
  while (Date.now() < recoverDeadline && recovered.phase === 'listening') {
    recovered = await s4.handlers.listen_poll();
    await sleep(20);
  }
  check('a second, clean hold recovers in the same session',
    recovered.phase === 'done' && recovered.candidates === 189,
    `phase=${recovered.phase}, ${recovered.candidates} candidates`);

  // --- the fan fallback, for a unit whose lamp is dead ---------------------
  const fanOnly = makeFan(TRUE_ADDRESS);
  const d3 = makeDriver(fanOnly);
  await d3.onInit();
  const s3 = makeSession([]);
  await d3.onPair(s3);
  await s3.handlers.listen_start();
  for (let i = 0; i < 30; i++) { d3._fire(received); await sleep(2); }
  let l3 = { phase: 'listening' };
  const d3Deadline = Date.now() + 5000;
  while (Date.now() < d3Deadline && l3.phase === 'listening') {
    l3 = await s3.handlers.listen_poll();
    await sleep(5);
  }
  const viaFan = await runProbe(s3.handlers, fanOnly, 'fan');
  check('the fan fallback finds the same address', viaFan.address === TRUE_ADDRESS,
    `${viaFan.phase} ${viaFan.address || ''} in ${viaFan.asks} questions`);
  check('the fan fallback leaves the fan stopped', fanOnly.speed === 0);

  // --- a fan that never answers -------------------------------------------
  const deadFan = makeFan('111111111111111111111111');
  const d2 = makeDriver(deadFan);
  await d2.onInit();
  const s2 = makeSession([]);
  await d2.onPair(s2);
  await s2.handlers.listen_start();
  for (let i = 0; i < 30; i++) { d2._fire(received); await sleep(2); }

  let l2 = { phase: 'listening' };
  const d2Deadline = Date.now() + 5000;
  while (Date.now() < d2Deadline && l2.phase === 'listening') {
    l2 = await s2.handlers.listen_poll();
    await sleep(5);
  }
  const dead = await runProbe(s2.handlers, deadFan);
  check('a fan that never reacts fails cleanly rather than picking one',
    dead.phase === 'failed',
    dead.phase === 'found' ? 'it wrongly claimed success' : `phase=${dead.phase}`);

  // --- a fan that is already in Homey --------------------------------------
  //
  // Homey's device list hides anything already paired, so handing it a known
  // address renders "no new devices have been found" — which reads as a failed
  // search when the search in fact succeeded. Say so instead.
  const stub = (id) => ({ getData: () => ({ id, address: TRUE_ADDRESS }), getSetting: () => true });
  const known = makeFan(TRUE_ADDRESS);
  const d5 = makeDriver(known);
  d5.getDevices = () => [stub(`civx-${TRUE_ADDRESS}`), stub(`civx-${TRUE_ADDRESS}-light`)];
  await d5.onInit();
  const s5 = makeSession([]);
  await d5.onPair(s5);
  await s5.handlers.listen_start();
  for (let i = 0; i < 25; i++) { d5._fire(received); await sleep(2); }
  let l5 = { phase: 'listening' };
  const d5Deadline = Date.now() + 6000;
  while (Date.now() < d5Deadline && l5.phase === 'listening') {
    l5 = await s5.handlers.listen_poll();
    await sleep(20);
  }
  const dup = await runProbe(s5.handlers, known, 'light');
  check('a fan whose devices all exist is named as such, not offered again',
    dup.phase === 'exists', `phase=${dup.phase}`);

  // ...but a half-paired unit — the fan added under an older version, no light
  // yet — must still be able to add the missing half.
  const half = makeFan(TRUE_ADDRESS);
  const d6 = makeDriver(half);
  d6.getDevices = () => [stub(`civx-${TRUE_ADDRESS}`)];
  await d6.onInit();
  const s6 = makeSession([]);
  await d6.onPair(s6);
  await s6.handlers.listen_start();
  for (let i = 0; i < 25; i++) { d6._fire(received); await sleep(2); }
  let l6 = { phase: 'listening' };
  const d6Deadline = Date.now() + 6000;
  while (Date.now() < d6Deadline && l6.phase === 'listening') {
    l6 = await s6.handlers.listen_poll();
    await sleep(20);
  }
  const halfDone = await runProbe(s6.handlers, half, 'light');
  const halfList = await s6.handlers.list_devices();
  check('a unit with only the fan paired can still add its light',
    halfDone.phase === 'found' && halfList.length === 1 && halfList[0].data.role === 'light',
    `phase=${halfDone.phase}, offered ${JSON.stringify(halfList.map((d) => d.data.role))}`);

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll checks passed.');
  process.exit(failures ? 1 : 0);
})();
