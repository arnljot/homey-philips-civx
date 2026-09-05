// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

const Homey = require('homey');
const { matcherFor } = require('../../lib/codes');
const {
  candidateAddresses, modalFrame, frameForId, frameStringFor, BUTTON_IDS,
  PROBE_BUTTONS, PROBE_BUTTONS_FAN,
} = require('../../lib/pairing');

// The buttons reception can identify. Deliberately the fan set only: adding the
// light codes drops the closest distance between distorted codes from 3 bits to
// 2, below what the 1-bit matching tolerance needs to stay unambiguous
// (`node tools/check_light_codes.js`).
const RX_BUTTONS = ['speed_1', 'speed_2', 'speed_3', 'speed_4', 'speed_5', 'speed_6', 'off'];

// Reception. Frames arrive NOT correctly decoded — Homey cannot resolve this
// remote's PWM — and are identified by their distorted form, see `distort()` in
// lib/codes.js. The signal definition is deliberate to the last field; see
// "Signal definition" in CLAUDE.md before changing it.
const RX_SIGNAL_IDS = ['civx_ctl'];

// Transmit signal used while pairing (the device picks its own for normal use).
const TX_SIGNAL_ID = 'philips_civx_fan';

// How long after our own transmission to keep ignoring the air, so a frame we
// sent ourselves is never mistaken for someone pressing the physical remote.
const TX_ECHO_GUARD_MS = 750;

// A press of the remote is sent 5x. Collapse a burst into a single press.
const BURST_MS = 1500;

// Pairing listens for the "hold 1+2" gesture. Collection runs until the air
// goes quiet — the user let go — and the modal frame is only trusted if it
// genuinely dominates: a weak modal yields a candidate list without the fan in
// it, which is indistinguishable from a dead transmitter.
const PAIR_MIN_FRAMES = 12;
const PAIR_QUIET_MS = 1500;
const PAIR_MAX_FRAMES = 80;
const PAIR_MIN_MODAL = 4;
const PAIR_MODAL_SHARE = 0.2;
const LISTEN_TIMEOUT_MS = 45000;

// Pause between a batch and its question. Short, because the question asks
// about a STATE ("is the light on now?"), so it does not matter that the change
// may have happened halfway through the batch.
const PROBE_SETTLE_MS = 500;

// Longer, for the fan fallback only: blades coast, and a question asked too
// early is answered against a fan that is still turning. A wrong answer sends
// the halving search down the wrong branch with no way back.
const PROBE_SPINDOWN_MS = 3000;

module.exports = class CivxFanDriver extends Homey.Driver {

  async onInit() {
    this._muteUntil = 0;
    this._lastSeen = { button: null, at: 0 };
    this._pairFrames = null;          // non-null only while a pairing session listens

    await this._startListening();

    this.log('Civx fan driver ready');
  }

  /**
   * Listen for the original Philips remote. RF is one-way and the fan never
   * reports anything, so overhearing the remote is the only way to learn that
   * something other than Homey changed it — and how pairing finds an address.
   */
  async _startListening() {
    this._signals = {};
    for (const id of RX_SIGNAL_IDS) {
      try {
        const signal = this.homey.rf.getSignal433(id);
        signal.on('payload', (payload, first) => {
          this._onPayload(payload, first, id).catch(this.error);
        });
        await signal.enableRX();
        this._signals[id] = signal;
        this.log(`433 MHz RX enabled on '${id}'`);
      } catch (err) {
        this.error(`could not enable 433 MHz RX on '${id}':`, err);
      }
    }

    if (!Object.keys(this._signals).length) {
      this.error('no 433 MHz RX signal could be enabled — remote tracking is off');
    }
  }

  /** The signal used to transmit while pairing. */
  _txSignal() {
    return this.homey.rf.getSignal433(TX_SIGNAL_ID);
  }

  /**
   * Serialise every transmission in the app onto one queue.
   *
   * The queue belongs here, not on the device: a fan and a light are two
   * devices sharing one radio and one address, so a per-device chain lets two
   * bursts overlap and garble each other on air.
   *
   * @param {function(): Promise<void>} send
   */
  async enqueueTx(send) {
    const next = (this._txChain || Promise.resolve()).then(send);
    this._txChain = next.catch(() => {});   // a failure must not break the queue
    return next;
  }

  /** Called around our own transmissions to avoid self-triggering. */
  muteRx(durationMs) {
    this._muteUntil = Math.max(this._muteUntil, Date.now() + durationMs + TX_ECHO_GUARD_MS);
  }

  /**
   * A matcher per paired address.
   *
   * Reception has to be built from the addresses actually in use: a matcher
   * made from the reference remote's captured codes recognises the reference
   * remote and nothing else, which would leave remote tracking dead for every
   * other owner. The distortion is deterministic, so the received form of an
   * address can be predicted without ever having heard it.
   *
   * Rebuilt whenever the set of paired addresses changes.
   */
  _matchers() {
    const addresses = [...new Set(this.getDevices().map((d) => d.address()))].sort();
    const key = addresses.join(',');
    if (this._matcherKey === key) return this._matcherCache;

    this._matcherCache = addresses.map((address) => {
      const frames = {};
      for (const button of RX_BUTTONS) frames[button] = frameStringFor(address, BUTTON_IDS[button]);
      return { address, matcher: matcherFor(frames) };
    });
    this._matcherKey = key;
    this.log(`RX matching ${addresses.length} address(es): ${key || '(none paired)'}`);
    return this._matcherCache;
  }

  async _onPayload(payload, first, signalId) {
    const now = Date.now();
    if (now < this._muteUntil) return;

    // While pairing is listening, collect raw frames — the address of a fan we
    // have never seen cannot be matched against known codes.
    if (this._pairFrames && payload.length === 41) {
      this._pairFrames.push(payload.join(''));
      if (this._pairFrames.length % 5 === 0) {
        this.log(`pairing: collected ${this._pairFrames.length} frames`);
      }
    }

    // Not restricted to `first`: alignment varies between repetitions, so a
    // later one often decodes more cleanly. The burst guard collapses them.
    let hit = null;
    for (const entry of this._matchers()) {
      const button = entry.matcher.matchButton(payload);
      if (button) { hit = { ...entry, button }; break; }
    }
    if (!hit) return;

    // Keyed by address as well as button: two fans in one house are two
    // independent remotes, and a press of one must not mute the other.
    const seenKey = `${hit.address}:${hit.button}`;
    if (seenKey === this._lastSeen.key && now - this._lastSeen.at < BURST_MS) {
      this._lastSeen.at = now;
      return;
    }
    this._lastSeen = { key: seenKey, at: now };

    const near = hit.matcher.nearestCode(payload);
    this.log(`remote: ${hit.button} (${signalId}, ${near ? near.distance : '?'} bit error(s),`
      + ` first=${first}, address ${hit.address})`);

    for (const device of this.getDevices()) {
      if (device.address() !== hit.address) continue;
      if (device.getSetting('track_remote') === false) continue;
      await device.onRemoteButton(hit.button).catch(this.error);
    }
  }

  /**
   * The devices one address is worth: one piece of hardware, but a fan and a
   * light to a smart home, and zone actions key off the device class. Both are
   * offered from one search, preselected, so it stays one confirmation.
   */
  _devicesFor(address) {
    if (!address) return [];
    return [
      {
        name: this.homey.__('pair.probe.deviceName'),
        data: { id: `civx-${address}`, address, role: 'fan' },
      },
      {
        name: this.homey.__('pair.probe.lightName'),
        data: { id: `civx-${address}-light`, address, role: 'light' },
      },
    ];
  }

  /** Whether this exact device is already in Homey. */
  _isPaired(device) {
    return this.getDevices().some((d) => (d.getData() || {}).id === device.data.id);
  }

  /**
   * Guided pairing: discover which address this fan answers to.
   *
   * Every Civx learns its own remote, so the address cannot be hardcoded. With
   * the button known, the receiver's distortion still narrows the 24-bit
   * address to a short list — 189 for the reference remote, median ~65 — and a
   * halving search over that list identifies the fan. Address matching is exact,
   * so exactly one candidate can react and a near miss cannot claim the pairing.
   */
  async onPair(session) {
    this.log('pairing: onPair session opened');

    // Homey.__() does not substitute {{placeholders}} in a pair session, so do
    // it here. View text uses data-i18n instead; only interpolated strings
    // are built driver-side.
    const t = (key, vars = {}) => {
      let s = this.homey.__(key);
      for (const [k, v] of Object.entries(vars)) s = s.split(`{{${k}}}`).join(String(v));
      return s;
    };

    const state = {
      candidates: [], rounds: 0, round: 0, half: [], confirming: false, listenTimer: null,
      // Everything the view needs, read back through its polling handlers.
      frames: 0, phase: 'listening', message: '', probe: 'idle', address: null, pct: 0,
      // Probing toggles one thing on and off; `lit` is its believed state, so
      // the next question can be the opposite — one batch per question.
      medium: PROBE_BUTTONS, lit: false, expect: 'on', step: '', progress: '',
      // Probing runs detached from any handler, so without this an abandoned
      // session keeps transmitting.
      cancelled: false,
      // Set while a detached probe step is running, so a double tap cannot
      // start a second one over the top of it.
      working: false,
    };

    // Never two live sessions at once: an abandoned one whose `disconnect` never
    // fired keeps its probe loop, and that loop transmits.
    if (this._pairCancel) {
      this.log('pairing: cancelling a previous session that was still open');
      this._pairCancel();
    }
    this._pairCancel = () => {
      state.cancelled = true;
      if (state.listenTimer) this.homey.clearInterval(state.listenTimer);
      state.listenTimer = null;
    };
    this.log(`pairing: ${this.getDevices().length} device(s) already paired`);

    // MUST return promptly. Homey serialises pair-session messages, so anything
    // emitted from inside a still-running handler is queued behind it and never
    // reaches the view. Arm a timer and return.
    const startListening = () => {
      if (state.listenTimer) return;   // idempotent: two triggers, one listener
      // Also the way back in after a failed search: a fresh hold, a fresh
      // candidate list. The old one has been shown not to contain the fan.
      state.phase = 'listening';
      state.frames = 0;
      state.candidates = [];
      state.round = 0;
      state.confirming = false;
      state.probe = 'idle';
      state.step = '';
      state.progress = '';
      this._pairFrames = [];
      const deadline = Date.now() + LISTEN_TIMEOUT_MS;

      const stop = () => {
        if (state.listenTimer) this.homey.clearInterval(state.listenTimer);
        state.listenTimer = null;
      };

      this.log('pairing: listen_start handler entered, arming timer');
      let ticks = 0;

      let lastCount = 0;
      let quietSince = 0;

      state.listenTimer = this.homey.setInterval(() => {
        try {
          const frames = this._pairFrames ? this._pairFrames.length : 0;
          ticks += 1;
          if (ticks % 10 === 0) this.log(`pairing: tick ${ticks}, frames=${frames}`);
          state.frames = frames;
          session.emit('listen_progress', { frames }).catch(() => {});

          // Decide only once the hold has ENDED. The modal of the first twelve
          // frames is easily a corruption; the modal of the whole hold is not.
          if (frames > lastCount) { lastCount = frames; quietSince = Date.now(); }
          const burstOver = frames >= PAIR_MIN_FRAMES
            && (Date.now() - quietSince > PAIR_QUIET_MS || frames >= PAIR_MAX_FRAMES);

          if (burstOver) {
            const modal = modalFrame(this._pairFrames);
            const strong = modal
              && modal.count >= PAIR_MIN_MODAL
              && modal.count >= modal.total * PAIR_MODAL_SHARE;
            const candidates = strong ? candidateAddresses(modal.bits, 'pairing') : [];

            if (modal) {
              this.log(`pairing: hold ended, ${modal.total} frames, modal seen`
                + ` ${modal.count}x (${Math.round((modal.count / modal.total) * 100)}%)`
                + ` -> ${candidates.length} candidates; modal=${modal.bits}`);
            }

            if (candidates.length) {
              state.candidates = candidates;
              // The +1 is the confirmation round, skipped when the last answer
              // was already a "yes".
              state.rounds = Math.ceil(Math.log2(candidates.length)) + 1;
              state.phase = 'done';
              session.emit('listen_done', { candidates: candidates.length }).catch(() => {});
              this._pairFrames = null;
              stop();
              return;
            }
            // Too corrupted to trust. Throw the batch away and let the user
            // hold again rather than pair against an address the fan never had.
            this.log('pairing: modal too weak to trust, waiting for another hold');
            this._pairFrames = [];
            lastCount = 0;
          }

          if (Date.now() > deadline) {
            this._pairFrames = null;
            state.phase = 'error';
            state.message = t('pair.listen.timeout');
            session.emit('listen_error', { message: state.message }).catch(() => {});
            stop();
          }
        } catch (err) {
          this.error('pairing listen failed:', err);
          state.phase = 'error';
          state.message = String(err && err.message ? err.message : err);
          stop();
        }
      }, 400);
    };

    // The view renders from this poll. View -> driver is the direction that has
    // never failed here; the pushes elsewhere only make the screen immediate.
    let polls = 0;
    session.setHandler('listen_poll', async () => {
      polls += 1;
      if (polls === 1 || polls % 10 === 0) {
        this.log(`pairing: listen_poll #${polls} -> phase=${state.phase} frames=${state.frames}`);
      }
      return {
        frames: state.frames,
        phase: state.phase,
        candidates: state.candidates.length,
        message: state.message,
      };
    });


    // Two independent triggers: the view's emit depends on its script running,
    // whereas showView does not depend on our JavaScript at all.
    session.setHandler('showView', async (viewId) => {
      this.log(`pairing: view '${viewId}' shown`);
      if (viewId === 'listen') startListening();
      return true;
    });

    session.setHandler('listen_start', async (data) => {
      this.log(`pairing: listen_start received ${JSON.stringify(data)}`);
      startListening();
      return { ok: true };
    });

    // A channel for the view to report into when the page itself cannot be read.
    session.setHandler('view_trace', async (data) => {
      this.log(`pairing: VIEW TRACE ${JSON.stringify(data)}`);
      return { ok: true };
    });

    /**
     * Transmit one button to every address in a batch, one repetition each.
     * A frame is ~52 ms on air, so a 95-address batch takes about five seconds;
     * progress is reported throughout because silence reads as a hang.
     */
    const probeBatch = async (addresses, button, label) => {
      // Pairing drives a fan nobody has identified yet, so a light-medium
      // session putting a speed command on the air must be impossible by
      // construction, not merely unlikely.
      if (button !== state.medium.on && button !== state.medium.off) {
        this.error(`pairing: refusing to send '${button}' — medium is`
          + ` ${JSON.stringify(state.medium)}`);
        return;
      }
      const started = Date.now();
      let done = 0;
      for (const address of addresses) {
        if (state.cancelled) return;            // session closed mid-batch
        done += 1;
        if (done === 1 || done % 4 === 0 || done === addresses.length) {
          state.message = t(label, { done, total: addresses.length });
          state.pct = Math.round((done / addresses.length) * 100);
          // `step` rides along, or the view blanks that line on every push and
          // refills it on every poll — which reads as flicker.
          session.emit('probe_working', { text: state.message, pct: state.pct, step: state.progress })
            .catch(() => {});
        }
        this.muteRx(300);
        await this._txSignal()
          .tx(frameForId(address, BUTTON_IDS[button]), { repetitions: 1 })
          .catch(this.error);
      }
      this.log(`pairing: sent '${button}' to ${done} address(es) in ${Date.now() - started} ms`);
    };

    const fail = async () => {
      state.message = t('pair.probe.noneLeft');
      state.probe = 'failed';
      session.emit('probe_failed', { message: state.message }).catch(() => {});
    };

    /**
     * Ask one question.
     *
     * The medium is TOGGLED rather than driven to a fixed state: if the lamp is
     * believed on, the next batch switches it off. One batch per question
     * instead of a probe plus an undo, which halves the search's air time.
     */
    const ask = async () => {
      if (state.cancelled) return;
      if (!state.candidates.length) return fail();

      if (state.candidates.length === 1) {
        // A halving search converges to one candidate even when the fan never
        // reacted at all, since every "no" simply discards the other half. So a
        // search ending on a "no" gets one more question, which must be a yes.
        state.confirming = true;
        state.half = state.candidates;
      } else {
        state.half = state.candidates.slice(0, Math.ceil(state.candidates.length / 2));
      }

      state.expect = state.lit ? 'off' : 'on';
      const button = state.medium[state.expect];
      const medium = state.medium === PROBE_BUTTONS_FAN ? 'fan' : 'light';

      state.round += 1;
      state.probe = 'working';

      // Set BEFORE the batch, so the counter is on screen during the slow part
      // rather than appearing when it is no longer news.
      //
      // Two wordings: "Question 3 of about 9" while sweeping would claim a
      // question is being asked when none is, so the sweep says "Step 3" and
      // the question count appears only beside the actual Yes/No. These are
      // built here because data-i18n cannot interpolate.
      const round = Math.min(state.round, state.rounds);
      state.progress = t('pair.probe.stepWorking', { round, rounds: state.rounds });
      state.step = state.confirming
        ? t('pair.probe.stepConfirm')
        : t('pair.probe.step', { round, rounds: state.rounds });

      // One batch is ONE test, not 95 of them; the bar is only how far it got.
      await probeBatch(state.half, button, `pair.probe.sweep_${medium}_${state.expect}`);
      if (state.cancelled) return;

      // A lamp is already in its new state by the time the frame ends. Blades
      // coast, so the fan fallback has to wait them out.
      const settle = state.medium === PROBE_BUTTONS_FAN && state.expect === 'off'
        ? PROBE_SPINDOWN_MS
        : PROBE_SETTLE_MS;
      if (settle > PROBE_SETTLE_MS) {
        state.message = t('pair.probe.settling');
        state.pct = 100;
        session.emit('probe_working', { text: state.message, pct: 100, step: state.progress })
          .catch(() => {});
      }
      await new Promise((r) => this.homey.setTimeout(r, settle));
      if (state.cancelled) return;

      state.probe = 'ask';
      session.emit('probe_ask', {
        remaining: state.candidates.length,
        round: Math.min(state.round, state.rounds),
        rounds: state.rounds,
        confirming: state.confirming,
        expect: state.expect,
        medium,
        step: state.step,
      }).catch(() => {});
    };

    session.setHandler('probe_poll', async () => ({
      phase: state.probe,
      round: Math.min(state.round, state.rounds),
      rounds: state.rounds,
      remaining: state.candidates.length,
      message: state.message,
      pct: state.pct,
      address: state.address,
      confirming: state.confirming,
      expect: state.expect,
      medium: state.medium === PROBE_BUTTONS_FAN ? 'fan' : 'light',
      // The question count belongs with the question. While sweeping, the same
      // line carries the neutral step wording instead.
      step: state.probe === 'ask' ? state.step : state.progress,
    }));

    // Same rule as listen_start: a batch takes seconds, and anything emitted
    // from a still-running handler is queued behind it. Return immediately.
    // Run the work off the handler, and NEVER two at once. The view guards
    // double taps of its own, but the driver must not depend on that: two
    // `answer()` calls interleaved both mutate the candidate list, and a
    // halving search sent down the wrong branch cannot recover.
    const detach = (fn) => {
      if (state.working) {
        this.log('pairing: ignoring an overlapping request, one is already running');
        return true;
      }
      state.working = true;
      this.homey.setTimeout(() => {
        fn().catch(this.error).then(() => { state.working = false; });
      }, 0);
      return true;
    };

    // The first question assumes the light starts OFF; the intro asks the user
    // to arrange that with their own remote, rather than Homey spending a full
    // extra pass over the air forcing it.
    //
    // `medium: 'fan'` is the fallback for a unit whose lamp is dead or removed.
    session.setHandler('probe_start', async (data) => {
      state.medium = (data && data.medium === 'fan') ? PROBE_BUTTONS_FAN : PROBE_BUTTONS;
      state.lit = false;
      this.log(`pairing: probing with the ${data && data.medium === 'fan' ? 'fan' : 'light'}`
        + `, ${state.candidates.length} candidates`);
      return detach(ask);
    });

    session.setHandler('probe_answer', async ({ reacted }) => detach(() => answer(reacted)));

    /** Put the fan back the way we found it and hand the address to the view. */
    const finish = async (address) => {
      // Homey's device list hides anything already paired, so handing it only
      // known devices renders "no new devices have been found" — the opposite
      // of what just happened.
      const fresh = this._devicesFor(address).filter((d) => !this._isPaired(d));
      if (!fresh.length) {
        this.log(`pairing: ${address} is already paired, nothing new to add`);
        state.address = address;
        state.message = t('pair.probe.alreadyPaired');
        state.probe = 'exists';
        session.emit('probe_exists', { message: state.message }).catch(() => {});
        return;
      }

      if (state.lit) {
        state.probe = 'working';
        await probeBatch([address], state.medium.off, 'pair.probe.finishing');
        state.lit = false;
      }
      this.log(`pairing: identified ${address} after ${state.round} question(s)`);
      state.address = address;
      state.probe = 'found';
      session.emit('probe_found', { address }).catch(() => {});
    };

    const answer = async (reacted) => {
      if (state.cancelled) return;

      if (reacted) state.lit = state.expect === 'on';

      if (state.confirming) {
        if (!reacted) {
          this.log('pairing: final confirmation failed — no address claimed');
          return fail();
        }
        return finish(state.candidates[0]);
      }

      if (reacted) {
        // A "yes" proves the address is in the half just sent.
        state.candidates = state.half;
        // If that half is one address, the reaction just confirmed IS the
        // positive confirmation; asking again repeats the same question.
        if (state.candidates.length === 1) return finish(state.candidates[0]);
      } else {
        // Nothing happened, so nothing was left switched on to undo either.
        state.candidates = state.candidates.slice(state.half.length);
      }
      await ask();
    };

    // Homey's own add-device view finishes the job; Homey.createDevice() from a
    // custom page does not. See "list_devices and add_devices" in CLAUDE.md.
    session.setHandler('list_devices', async () => {
      const devices = this._devicesFor(state.address).filter((d) => !this._isPaired(d));
      this.log(`pairing: list_devices -> ${devices.length} device(s),`
        + ` address=${state.address || 'none'}`);
      return devices;
    });

    session.setHandler('disconnect', async () => {
      this.log('pairing: session closed');
      state.cancelled = true;              // stops any in-flight probe batch
      if (state.listenTimer) this.homey.clearInterval(state.listenTimer);
      state.listenTimer = null;
      this._pairCancel = null;
      this._pairFrames = null;
    });
  }

};



