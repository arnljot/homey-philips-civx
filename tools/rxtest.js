// Offline test for the RX state machine.
//
//   node tools/rxtest.js .
//
// Drives the REAL drivers/civx-fan/{driver,device}.js against a stubbed `homey`
// module, so the remote-tracking logic can be checked without a Homey or a fan.
// Covers: burst de-duplication, the centre button's toggle inference, our own
// transmissions not being read back as remote presses, foreign 433 traffic, and
// the track_remote opt-out.
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

const Device = require(path.join(ROOT, 'drivers/civx-fan/device.js'));
const Driver = require(path.join(ROOT, 'drivers/civx-fan/driver.js'));
const { FRAMES } = require(path.join(ROOT, 'lib/codes.js'));

// ---- harness -------------------------------------------------------------
const txLog = [];
let signalHandler = null;

function makeDevice(driver, settings = {}, data = {}) {
  const d = new Device();
  const store = {};
  const caps = {};
  const listeners = {};
  const conf = {
    repetitions: 8, signal_variant: 'default', onoff_speed: '3',
    deterministic_off: false, track_remote: true, ...settings,
  };
  Object.assign(d, {
    driver,
    homey: {
      rf: {
        getSignal433: () => ({
          tx: async (frame, opts) => {
            // Record what the UI showed at the moment transmission began — a
            // burst takes ~0.5s on air, so the state must already be painted.
            txLog.push({
              frame: frame.join(''),
              reps: opts.repetitions,
              litAtTx: [1, 2, 3, 4, 5, 6].filter((s) => caps[`civx_speed_${s}`] === true).join(','),
            });
            if (conf._txFails) throw new Error('tx failed');
          },
        }),
      },
      flow: { getDeviceTriggerCard: () => ({ trigger: async () => {} }) },
      // The device publishes the RUNNING app's version into its own settings,
      // read from the executing manifest rather than a constant.
      manifest: { version: '9.9.9-test' },
      // The device repaints the buttons on a later tick to beat Homey's own
      // post-listener capability write.
      setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); t.unref(); return t; },
      clearTimeout: (t) => clearTimeout(t),
    },
    // Pairing stores the discovered address in the device's data. Devices added
    // before pairing existed have none and fall back to the reference remote.
    getData: () => data,
    getSetting: (k) => conf[k],
    setSettings: async (o) => { Object.assign(conf, o); },
    getStoreValue: (k) => store[k],
    setStoreValue: async (k, v) => { store[k] = v; },
    getCapabilityValue: (k) => caps[k],
    setCapabilityValue: async (k, v) => { caps[k] = v; },
    hasCapability: (k) => k in caps,
    // One driver, two device classes: the light overrides the manifest's `fan`
    // at runtime so zone actions like "all lights off" reach it.
    getClass: () => conf._class || 'fan',
    setClass: async (c) => { conf._class = c; },
    getCapabilities: () => Object.keys(caps),
    addCapability: async (k) => { caps[k] = null; },
    removeCapability: async (k) => { delete caps[k]; },
    registerCapabilityListener: (k, fn) => { listeners[k] = fn; },
  });
  d._caps = caps; d._store = store; d._listeners = listeners;
  return d;
}

function makeDriver() {
  const dr = new Driver();
  const devices = [];
  Object.assign(dr, {
    homey: {
      rf: {
        getSignal433: () => ({
          on: (ev, fn) => { if (ev === 'payload') signalHandler = fn; },
          enableRX: async () => {},
        }),
      },
      // The driver arms periodic/deferred diagnostics; keep them off the event
      // loop so the test process can exit, and never fire the probe rehearsal
      // (it would transmit) during tests.
      setInterval: (fn, ms) => { const t = setInterval(fn, ms); t.unref(); return t; },
      setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); t.unref(); return t; },
    },
    getDevices: () => devices,
  });
  dr._devices = devices;
  return dr;
}

function lit(dev) {
  const on = [1, 2, 3, 4, 5, 6].filter((s) => dev._caps[`civx_speed_${s}`] === true);
  return `onoff=${dev._caps.onoff} lit=[${on.join(',')}] speed=${dev._store.speed ?? 0} last=${dev._store.lastSpeed ?? '-'}`;
}

/** The enum that drives the device's status indicator. */
const indicator = (dev) => String(dev._caps.civx_speed);

// The real signal handler is fire-and-forget (an EventEmitter callback cannot
// be awaited), so give its async work a chance to finish before asserting.
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 5)); };
// Momentary buttons clear themselves on the same deferred tick the speed group
// uses to beat Homey's post-listener write, so asserting on them needs to wait
// past REPAINT_DELAY_MS rather than merely past the microtask queue.
const settleRepaint = async () => { await new Promise((r) => setTimeout(r, 400)); await settle(); };
const fire = async (frame, first) => { signalHandler(frame, first); await settle(); };

let failures = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      ${actual}${ok ? '' : `\n      expected: ${expected}`}`);
}

(async () => {
  const driver = makeDriver();
  await driver.onInit();
  const dev = makeDevice(driver);
  driver._devices.push(dev);
  await dev.onInit();

  console.log('--- start ---');
  check('fresh device is off', lit(dev), 'onoff=false lit=[] speed=0 last=-');

  // The version shown on the device page must come from the running manifest,
  // so it confirms an install went live rather than echoing our intent.
  check('running app version published to settings', dev.getSetting('app_version'), '9.9.9-test');
  check('start time published to settings',
    typeof dev.getSetting('app_started') === 'string' && dev.getSetting('app_started') !== 'unknown',
    true);

  check('status indicator starts off', indicator(dev), 'off');
  // Assert the PRODUCTION capabilities and their order. Diagnostic probe
  // buttons may be appended after them; those come and go, but the order of the
  // real ones is what must hold.
  const PRODUCTION_CAPS = 'onoff,civx_speed,civx_speed_1,civx_speed_2,'
    + 'civx_speed_3,civx_speed_4,civx_speed_5,civx_speed_6';
  check('production capabilities are in the declared order',
    dev.getCapabilities().slice(0, 8).join(','), PRODUCTION_CAPS);

  // A device migrated across versions: `addCapability` appends, so civx_speed
  // ended up AFTER the six buttons instead of second. Homey presents a device
  // from its capability order, so the migration must fix the order, not just
  // the membership.
  const stale = makeDevice(driver);
  for (const c of ['onoff', 'civx_speed_1', 'civx_speed_2', 'civx_speed_3',
    'civx_speed_4', 'civx_speed_5', 'civx_speed_6', 'civx_speed']) stale._caps[c] = null;
  check('stale device starts in the wrong order',
    stale.getCapabilities().join(','),
    'onoff,civx_speed_1,civx_speed_2,civx_speed_3,civx_speed_4,civx_speed_5,civx_speed_6,civx_speed');
  await stale.onInit();
  check('migration repairs capability order',
    stale.getCapabilities().slice(0, 8).join(','), PRODUCTION_CAPS);

  // Remote presses speed 3
  await fire(FRAMES.speed_3, true);
  check('remote speed_3 -> running at 3', lit(dev), 'onoff=true lit=[3] speed=3 last=3');
  check('status indicator follows the remote', indicator(dev), '3');

  // The other 4 repetitions of that same burst must be ignored
  for (let i = 0; i < 4; i++) await fire(FRAMES.speed_3, false);
  check('burst repeats ignored', lit(dev), 'onoff=true lit=[3] speed=3 last=3');

  // Remote centre button: toggle off
  await fire(FRAMES.off, true);
  check('remote power -> off', lit(dev), 'onoff=false lit=[] speed=0 last=3');
  check('status indicator reads off when stopped', indicator(dev), 'off');

  // Same burst re-detected within BURST_MS changes nothing
  await fire(FRAMES.off, true);
  check('re-detected off burst is idempotent', lit(dev), 'onoff=false lit=[] speed=0 last=3');

  // The centre button is a dedicated Fan Off, not a toggle: pressing it again
  // on a stopped fan must leave it stopped.
  await new Promise((r) => setTimeout(r, 1600));
  await fire(FRAMES.off, true);
  check('remote power on a stopped fan stays off', lit(dev), 'onoff=false lit=[] speed=0 last=3');

  // Reception is not bit-perfect; a frame with 3 bit errors must still count.
  await new Promise((r) => setTimeout(r, 1600));
  const noisy = [...FRAMES.speed_2];
  noisy[1] ^= 1; noisy[17] ^= 1; noisy[38] ^= 1;
  await fire(noisy, true);
  check('remote speed_2 with 3 bit errors -> running at 2', lit(dev), 'onoff=true lit=[2] speed=2 last=2');

  // Homey's own UI: press speed 5
  txLog.length = 0;
  await dev._listeners.civx_speed_5();
  await settle();
  check('UI speed 5 -> running at 5', lit(dev), 'onoff=true lit=[5] speed=5 last=5');
  check('UI speed 5 transmitted right frame', txLog[0].frame, FRAMES.speed_5.join(''));
  check('UI speed 5 used repetitions setting', String(txLog[0].reps), '8');
  // The UI must be painted BEFORE the burst goes out, not after it finishes.
  check('UI painted before transmission started', txLog[0].litAtTx, '5');

  // A failed transmission must roll the state back rather than claim success.
  const failing = makeDevice(driver, { _txFails: true });
  await failing.onInit();
  await failing._listeners.civx_speed_4().catch(() => {});
  await settle();
  check('failed transmission rolls state back', lit(failing), 'onoff=false lit=[] speed=0 last=-');

  // Our own transmission must not be re-read as a remote press
  await fire(FRAMES.speed_5, true);
  check('own tx echo is muted', lit(dev), 'onoff=true lit=[5] speed=5 last=5');

  // Remote drops it to speed 1
  await new Promise((r) => setTimeout(r, 1600));
  await fire(FRAMES.speed_1, true);
  check('remote speed_1 -> running at 1', lit(dev), 'onoff=true lit=[1] speed=1 last=1');

  // Unknown traffic on 433 must be ignored
  await fire(new Array(41).fill(0), true);
  check('foreign 433 frame ignored', lit(dev), 'onoff=true lit=[1] speed=1 last=1');

  // Opt-out respected
  const muted = makeDevice(driver, { track_remote: false });
  driver._devices.length = 0; driver._devices.push(muted);
  await muted.onInit();
  await new Promise((r) => setTimeout(r, 1600));
  await fire(FRAMES.speed_6, true);
  check('track_remote=false ignores the remote', lit(muted), 'onoff=false lit=[] speed=0 last=-');

  // Radio-group behaviour. Homey writes capability values after a listener
  // resolves, which left the previously selected speed lit and let a second
  // press unlight the active one. Simulate that overwrite and verify the
  // deferred repaint cleans it up.
  await dev._listeners.civx_speed_4();
  await settle();
  check('selecting 4 lights only 4', lit(dev), 'onoff=true lit=[4] speed=4 last=4');

  dev._caps.civx_speed_2 = true;    // stale value Homey re-applies
  dev._caps.civx_speed_4 = false;   // and the active one wrongly cleared
  check('stale UI state before repaint', lit(dev), 'onoff=true lit=[2] speed=4 last=4');

  await new Promise((r) => setTimeout(r, 500));
  check('deferred repaint restores the radio group', lit(dev), 'onoff=true lit=[4] speed=4 last=4');

  // Real frames captured off the air on 2026-09-04 while pressing 1, 3, 4, 6
  // and finally off. Homey cannot decode this remote correctly, but it distorts
  // it deterministically, so these are matched by their distorted form.
  const { matchButton } = require(path.join(ROOT, 'lib/codes.js'));
  const REAL_OFF_AIR = [
    ['speed_1', '11000000000100000111000000011110000000001'],
    ['speed_3', '11000000000100000111000000100000100000000'],
    ['speed_4', '11000000000100000111000001001100000100111'],
    ['speed_6', '11000000000100000111000000110000000010001'],
    ['off', '11000000000100000111000011100100000000111'],
  ];
  for (const [expected, bits] of REAL_OFF_AIR) {
    const got = matchButton(bits.split('').map(Number));
    check(`off-air frame identified as ${expected}`, String(got), expected);
  }

  // A frame from the same speed_1 burst that came off the air too corrupted to
  // identify. It must be rejected rather than guessed at — most frames in a
  // burst land like this, and only the clean ones should count.
  check('over-corrupted frame rejected, not guessed',
    String(matchButton('11000000000100001111000000011100000000111'.split('').map(Number))),
    'null');

  // A device paired through the guided flow carries its own discovered address
  // and must transmit on THAT, not on the remote everything was captured from.
  const OTHER = '110011001100110011001100';
  const paired = makeDevice(driver, {}, { id: `civx-${OTHER}`, address: OTHER });
  await paired.onInit();
  txLog.length = 0;
  await paired._listeners.civx_speed_3();
  await settle();
  check('a paired device transmits on its own learned address',
    txLog[0].frame.slice(0, 24), OTHER);
  check('and with the correct button id for that address',
    txLog[0].frame.slice(24, 32), FRAMES.speed_3.slice(24, 32).join(''));

  // A device added before pairing existed has no address and must keep working.
  const legacy = makeDevice(driver, {}, { id: 'philips-civx-fan' });
  await legacy.onInit();
  txLog.length = 0;
  await legacy._listeners.civx_speed_3();
  await settle();
  check('a legacy device falls back to the reference address',
    txLog[0].frame, FRAMES.speed_3.join(''));

  // --- the light half of the same unit -------------------------------------
  //
  // One address, two devices. The light exists so a zone action naming the
  // `light` class reaches the lamp without also spinning the fan up.
  const ADDRESS = FRAMES.speed_3.join('').slice(0, 24);
  const lamp = makeDevice(driver, {}, { id: 'civx-x-light', address: ADDRESS, role: 'light' });
  await lamp.onInit();

  check('the light device corrects its class', lamp.getClass(), 'light');
  check('the light device carries the lamp controls, and no fan controls',
    lamp.getCapabilities().join(','),
    'onoff,civx_white_ww,civx_white_nw,civx_white_dw,civx_dim_up,civx_dim_down');

  txLog.length = 0;
  await lamp._listeners.onoff(true);
  await settle();
  check('switching the light on sends light_on, not a speed',
    txLog[0].frame, `${ADDRESS}${'0111111010010101'}0`);

  txLog.length = 0;
  await lamp._listeners.onoff(false);
  await settle();
  check('switching the light off sends light_off, not the fan off code',
    txLog[0].frame, `${ADDRESS}${'1011110001010111'}0`);

  // RX identifies the seven fan buttons only; the lamp must not act on them.
  txLog.length = 0;
  await lamp.onRemoteButton('speed_3');
  await settle();
  check('the light ignores overheard fan buttons',
    `${txLog.length} tx, speed=${JSON.stringify(lamp._store.speed)}`,
    '0 tx, speed=undefined');

  // The three shades are a radio group, exactly like the speed ring.
  txLog.length = 0;
  await lamp._listeners.civx_white_nw();
  await settle();
  check('choosing natural white sends its code',
    txLog[0].frame, `${ADDRESS}${'0110011010001101'}0`);
  check('and lights exactly that shade',
    Object.keys(lamp._caps).filter((k) => k.startsWith('civx_white_') && lamp._caps[k]).join(','),
    'civx_white_nw');

  txLog.length = 0;
  await lamp._listeners.civx_white_dw();
  await settle();
  check('choosing another shade moves the highlight rather than adding one',
    Object.keys(lamp._caps).filter((k) => k.startsWith('civx_white_') && lamp._caps[k]).join(','),
    'civx_white_dw');

  // Brightness is relative on the remote, so it is relative here: a momentary
  // button that sends one step and clears itself again.
  txLog.length = 0;
  lamp._caps.civx_dim_up = true;
  await lamp._listeners.civx_dim_up();
  await settleRepaint();
  check('a brightness step sends dim_up and does not stay pressed',
    `${txLog[0].frame} lit=${lamp._caps.civx_dim_up}`,
    `${ADDRESS}${'0111001110011000'}0 lit=false`);

  // --- the fan's own extra buttons -----------------------------------------
  txLog.length = 0;
  dev._caps.civx_timer_3h = true;
  await dev._listeners.civx_timer_3h();
  await settleRepaint();
  check('the fan timer sends its code and does not stay pressed',
    `${txLog[0].frame} lit=${dev._caps.civx_timer_3h}`,
    `${FRAMES.speed_3.join('').slice(0, 24)}${'0001100011110011'}0 lit=false`);

  txLog.length = 0;
  await dev._listeners.civx_reverse();
  await settle();
  check('reverse sends its code without touching the tracked speed',
    `${txLog[0].frame} speed=${dev._store.speed}`,
    `${FRAMES.speed_3.join('').slice(0, 24)}${'0101000010111011'}0 speed=${dev._store.speed}`);

  // --- the "Send a remote button code" Flow action -------------------------
  //
  // One card for all 19 codes, with a checkbox deciding whether Homey also
  // tracks what the button does. Unticked it is the range-testing tool it
  // always was; ticked it keeps the tiles in step.
  driver._devices.push(lamp);

  txLog.length = 0;
  await dev.pressButton('speed_5', true);
  await settle();
  check('tracked press sends the code and moves the tracked speed',
    `${txLog.length} tx, ${lit(dev)}`,
    '1 tx, onoff=true lit=[5] speed=5 last=5');

  txLog.length = 0;
  await dev.pressButton('speed_2', false);
  await settle();
  check('untracked press sends the code and leaves state alone',
    `${txLog.length} tx, ${lit(dev)}`,
    '1 tx, onoff=true lit=[5] speed=5 last=5');

  txLog.length = 0;
  await dev.pressButton('off', true);
  await settle();
  check('tracked off stops the fan and keeps lastSpeed for the power toggle',
    lit(dev), 'onoff=false lit=[] speed=0 last=5');

  // A light code sent from the FAN device: both halves answer to the same
  // address, so the tile that should show the result is the sibling's.
  lamp._caps.onoff = false;
  txLog.length = 0;
  await dev.pressButton('light_on', true);
  await settle();
  check('a light code sent from the fan device updates the light device',
    `${txLog.length} tx, light onoff=${lamp._caps.onoff}, fan ${lit(dev)}`,
    '1 tx, light onoff=true, fan onoff=false lit=[] speed=0 last=5');

  txLog.length = 0;
  await lamp.pressButton('white_ww', true);
  await settleRepaint();
  check('a white shade tracked on the light device lights exactly one',
    Object.keys(lamp._caps).filter((k) => k.startsWith('civx_white_') && lamp._caps[k]).join(','),
    'civx_white_ww');

  // Buttons with no readable state must still transmit, and must not throw.
  txLog.length = 0;
  await dev.pressButton('timer_6h', true);
  await settle();
  check('a button with nothing to track still transmits',
    `${txLog.length} tx`, '1 tx');

  let threw = '';
  await dev.pressButton('not_a_button', true).catch((e) => { threw = e.message; });
  check('an unknown button is rejected, not transmitted', threw, 'Unknown button: not_a_button');

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll checks passed.');
  process.exit(failures ? 1 : 0);
})();




