// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

const Homey = require('homey');
const { speedButton } = require('../../lib/codes');
const { frameForId, BUTTON_IDS } = require('../../lib/pairing');

// Devices added before pairing existed carry no address; they belong to the
// remote everything was captured from, so they fall back to it.
const REFERENCE_ADDRESS = '001010111100110100001101';

const SIGNAL_IDS = {
  default: 'philips_civx_fan',
  eof: 'philips_civx_fan_eof',
};

const SPEEDS = [1, 2, 3, 4, 5, 6];
const speedCapability = (step) => `civx_speed_${step}`;

// One frame is ~52 ms on air (7.4 ms sync + 41 bits ~1.05 ms each).
const FRAME_MS = 52;

// Delay before repainting the buttons, so the repaint lands after Homey's own
// post-listener capability write rather than being overwritten by it.
const REPAINT_DELAY_MS = 250;

// Fire-and-forget buttons: none of these has a readable state — the fan never
// says which way it is turning — so they light on press and clear again.
const MOMENTARY = {
  civx_reverse: 'reverse',
  civx_sleep: 'sleep_wind',
  civx_timer_1h: 'timer_1h',
  civx_timer_3h: 'timer_3h',
  civx_timer_6h: 'timer_6h',
  civx_dim_up: 'dim_up',
  civx_dim_down: 'dim_down',
};

// The three fixed white shades, driven as a radio group like the speeds.
const WHITES = { civx_white_ww: 'white_ww', civx_white_nw: 'white_nw', civx_white_dw: 'white_dw' };

// In DISPLAY order. `onoff` renders as the toggle page; the speed capabilities
// are stateful buttons Homey groups onto a buttons page. `civx_speed` is a
// read-only enum that exists to be pickable as the tile's status indicator,
// which only offers capabilities.
const FAN_CAPABILITIES = [
  'onoff', 'civx_speed', ...SPEEDS.map(speedCapability),
  'civx_reverse', 'civx_sleep', 'civx_timer_1h', 'civx_timer_3h', 'civx_timer_6h',
];

// One piece of hardware, two devices on the same address, so zone actions
// naming either class reach it.
//
// The light has no `dim` slider on purpose: the remote has only relative +/-
// steps and the lamp cannot be read back, so a 0-100% figure would be invented.
const CAPABILITIES_BY_ROLE = {
  fan: FAN_CAPABILITIES,
  light: ['onoff', ...Object.keys(WHITES), 'civx_dim_up', 'civx_dim_down'],
};

// The driver's manifest class is `fan`; a light device overrides it at runtime.
const CLASS_BY_ROLE = { fan: 'fan', light: 'light' };

// Capabilities from earlier versions, removed from devices that still carry
// them: the standard `button` capability (getable:false, so it could never show
// which speed was selected) and the retired diagnostic probe buttons.
const RETIRED_CAPABILITIES = [
  ...SPEEDS.map((s) => `button.speed${s}`),
  ...['A', 'B', 'C', 'D', 'E'].map((l) => `button.probe${l}`),
];

module.exports = class CivxFanDevice extends Homey.Device {

  /**
   * `fan` or `light`. Devices paired before the light existed carry no role and
   * are fans — the same reasoning as the address fallback below.
   */
  _role() {
    return CAPABILITIES_BY_ROLE[this.getData().role] ? this.getData().role : 'fan';
  }

  async onInit() {
    // Transmissions are serialised: two overlapping tx calls would garble the air.
    this._txChain = Promise.resolve();

    const role = this._role();
    // A manifest declares one class per driver, and both devices come from this
    // one, so the light corrects its own. Guarded: without the class the light
    // still works, it just does not answer to "all lights off".
    if (typeof this.setClass === 'function' && this.getClass() !== CLASS_BY_ROLE[role]) {
      await this.setClass(CLASS_BY_ROLE[role]).catch(this.error);
    }

    await this._migrateCapabilities();
    await this._showVersion();

    this._registerMomentary();

    if (role === 'light') {
      this.registerCapabilityListener('onoff', async (value) => {
        await this.sendButton(value ? 'light_on' : 'light_off');
      });

      // A radio group like the speed ring: pressing one always selects it, so
      // the incoming value is ignored and the group repainted from store.
      for (const [capability, button] of Object.entries(WHITES)) {
        this.registerCapabilityListener(capability, async () => {
          await this.setWhite(capability, button);
        });
      }
      await this._reflectWhite(this.getStoreValue('white'));

      this.log(`Civx light ready — onoff=${JSON.stringify(this.getCapabilityValue('onoff'))}`
        + ` | white=${this.getStoreValue('white') || 'unknown'} | class=${this.getClass()}`
        + ` | caps=[${this.getCapabilities().join(',')}]`);
      return;
    }

    this.registerCapabilityListener('onoff', async (value) => {
      if (value) await this.setSpeed(this._resumeSpeed());
      else await this.turnOff();
    });

    // Direct-select buttons mirroring the remote's 1-6 ring. A press always
    // selects that speed, so the incoming value is deliberately ignored:
    // re-pressing the already-active speed re-sends it rather than clearing it.
    for (const step of SPEEDS) {
      this.registerCapabilityListener(speedCapability(step), async () => this.setSpeed(step));
    }

    // Repaint the buttons from tracked state so a restart does not leave them blank.
    await this._reflect(this.getStoreValue('speed') || 0);

    this.log(`Civx fan ready — speed ${this.getStoreValue('speed') || 0}`
      + ` | civx_speed=${JSON.stringify(this.getCapabilityValue('civx_speed'))}`
      + ` | onoff=${JSON.stringify(this.getCapabilityValue('onoff'))}`
      + ` | caps=[${this.getCapabilities().join(',')}]`);
  }

  /**
   * Send the code, then clear the button again. Homey writes a capability's own
   * value after the listener resolves, so a boolean button left alone stays lit
   * for good; the clear runs on the same later tick `_setState` uses.
   */
  _registerMomentary() {
    for (const [capability, button] of Object.entries(MOMENTARY)) {
      if (!this.hasCapability(capability)) continue;
      this.registerCapabilityListener(capability, async () => {
        await this.sendButton(button);
        this.homey.setTimeout(() => {
          this._set(capability, false).catch(this.error);
        }, REPAINT_DELAY_MS);
      });
    }
  }

  /** Select one of the three white shades, as a radio group. */
  async setWhite(capability, button) {
    const previous = this.getStoreValue('white');
    await this.setStoreValue('white', capability).catch(this.error);
    await this._reflectWhite(capability);
    try {
      await this.sendButton(button);
    } catch (err) {
      await this.setStoreValue('white', previous).catch(this.error);
      await this._reflectWhite(previous);
      throw err;
    }
    if (this._repaintWhite) this.homey.clearTimeout(this._repaintWhite);
    this._repaintWhite = this.homey.setTimeout(() => {
      this._reflectWhite(capability).catch(this.error);
    }, REPAINT_DELAY_MS);
  }

  /** Exactly one shade lit, or none until one has been chosen. */
  async _reflectWhite(selected) {
    for (const capability of Object.keys(WHITES)) {
      if (this.hasCapability(capability)) await this._set(capability, capability === selected);
    }
  }

  /**
   * Homey freezes a device's capability list at pairing time: changing the
   * driver manifest does not touch devices that are already added. Without this
   * a device paired under an older version keeps showing that version's UI, so
   * every capability change has to be applied here as well.
   */
  async _migrateCapabilities() {
    for (const cap of RETIRED_CAPABILITIES) {
      if (this.hasCapability(cap)) {
        await this.removeCapability(cap).catch(this.error);
        this.log(`migration: removed ${cap}`);
      }
    }

    // ORDER matters, not just membership: `addCapability()` appends and cannot
    // insert, and Homey presents a device from its capability order, so one
    // added late can fail to surface even with the right value. Rebuild from
    // the first position that differs; _reflect() restores the values.
    const wanted = CAPABILITIES_BY_ROLE[this._role()];
    const current = this.getCapabilities();
    let i = 0;
    while (i < wanted.length && i < current.length && current[i] === wanted[i]) i++;
    if (i === wanted.length && current.length === wanted.length) return;

    this.log(`migration: reordering from index ${i}`
      + ` — have [${current.join(',')}], want [${wanted.join(',')}]`);

    for (const cap of current.slice(i).reverse()) {
      await this.removeCapability(cap).catch(this.error);
    }
    for (const cap of wanted.slice(i)) {
      await this.addCapability(cap).catch(this.error);
    }
    this.log(`migration: now [${this.getCapabilities().join(',')}]`);
  }

  /**
   * Publish the running version onto the device page. Taken from
   * `this.homey.manifest` — the app actually executing — because a hardcoded
   * string would report the version we think we installed, which is the very
   * thing being checked. The start time distinguishes a live install from a
   * stale one. `setSettings()` does not re-trigger `onSettings`.
   */
  async _showVersion() {
    const started = new Date().toLocaleString('nb-NO', {
      timeZone: 'Europe/Oslo',
      dateStyle: 'short',
      timeStyle: 'medium',
    });
    await this.setSettings({
      app_version: String(this.homey.manifest.version),
      app_started: started,
      // So the address pairing found can be checked, not taken on trust.
      fan_address: this._address(),
    }).catch(this.error);
    this.log(`v${this.homey.manifest.version} started ${started}, address ${this._address()}`);
  }

  /** The Signal433 selected by the "Signal timing variant" setting. */
  _signal() {
    const id = SIGNAL_IDS[this.getSetting('signal_variant')] || SIGNAL_IDS.default;
    return this.homey.rf.getSignal433(id);
  }

  /** Speed to use when switching on: the last one we sent, else the configured default. */
  _resumeSpeed() {
    const last = Number(this.getStoreValue('lastSpeed'));
    if (SPEEDS.includes(last)) return last;
    const configured = Number(this.getSetting('onoff_speed'));
    return SPEEDS.includes(configured) ? configured : 3;
  }

  /**
   * Paint the UI to match tracked state: exactly one speed button lit when the
   * fan is running, none when it is off. `speed` is 0 for off, else 1..6.
   */
  async _reflect(speed) {
    let changed = 0;
    for (const step of SPEEDS) {
      if (await this._set(speedCapability(step), step === speed)) changed++;
    }
    if (await this._set('onoff', speed > 0)) changed++;
    // Drives the status indicator: 'off' or '1'..'6'.
    if (await this._set('civx_speed', speed > 0 ? String(speed) : 'off')) changed++;
    return changed;
  }

  /**
   * Write a capability only when the value actually changes. Each write is an
   * IPC round trip clients are notified about, and a state change plus its
   * deferred repaint would otherwise cost up to 16 writes per press, most of
   * them no-ops.
   *
   * @returns {Promise<boolean>} whether a write happened
   */
  async _set(capability, value) {
    if (this.getCapabilityValue(capability) === value) return false;
    await this.setCapabilityValue(capability, value).catch(this.error);
    return true;
  }

  /**
   * Persist tracked state. `lastSpeed` survives an off so the power toggle can
   * resume the speed the fan was actually running at.
   */
  async _setState(speed) {
    await this.setStoreValue('speed', speed).catch(this.error);
    if (speed > 0) await this.setStoreValue('lastSpeed', speed).catch(this.error);
    await this._reflect(speed);

    // Homey writes a capability's own value AFTER its listener resolves, which
    // overwrites whatever _reflect() painted from inside it. Repainting on a
    // later tick lands after that write and makes the radio group stick.
    if (this._repaint) this.homey.clearTimeout(this._repaint);
    this._repaint = this.homey.setTimeout(() => {
      this._reflect(speed).catch(this.error);
    }, REPAINT_DELAY_MS);
  }

  /**
   * The driver overheard the physical remote. The fan obeys it regardless of
   * what Homey thinks, so this is the one chance to resync; state is inferred
   * from the instruction, since the fan never reports back.
   * @param {string} button one of speed_1..speed_6, off
   */
  async onRemoteButton(button) {
    // RX identifies the seven fan buttons only, so the light tracks nothing.
    if (this._role() === 'light') return;

    const before = this.getStoreValue('speed') || 0;

    // The centre button is a dedicated Fan Off, not a toggle: pressing it on a
    // stopped fan leaves it stopped.
    await this._setState(button === 'off' ? 0 : Number(button.slice('speed_'.length)));

    const after = this.getStoreValue('speed') || 0;
    this.log(`remote ${button}: speed ${before} -> ${after}`);

    await this.homey.flow.getDeviceTriggerCard('remote_button')
      .trigger(this, {
        button: button === 'off' ? 'Power' : `Speed ${after}`,
        speed: after,
      })
      .catch(this.error);
  }

  /**
   * Select a speed step. On the remote this both starts the fan and picks the
   * speed, so pressing a speed always means the fan is now on.
   * @param {number|string} step 1..6
   */
  async setSpeed(step) {
    const speed = Number(step);
    if (!SPEEDS.includes(speed)) throw new Error(`Invalid speed step: ${step}`);
    await this._withOptimisticState(speed, () => this.sendButton(speedButton(speed)));
  }

  /**
   * Paint the new state first, then transmit. A burst is over half a second on
   * air at the default 8 repetitions, and the UI should not sit unchanged for
   * that long after a tap. If the transmission fails the old state goes back,
   * rather than the UI claiming something that never went out.
   */
  async _withOptimisticState(speed, transmit) {
    const previous = this.getStoreValue('speed') || 0;
    const previousLast = this.getStoreValue('lastSpeed');
    await this._setState(speed);
    try {
      await transmit();
    } catch (err) {
      // Roll back completely, `lastSpeed` included — otherwise a send that
      // never went out would still steer the next power-on.
      await this._setState(previous);
      await this.setStoreValue('lastSpeed', previousLast).catch(this.error);
      throw err;
    }
  }

  /** Stop the fan: speed 0, every speed button unlit. */
  async turnOff() {
    await this._withOptimisticState(0, () => this.sendButton('off'));
  }

  /**
   * The address this fan answers to, found during pairing and stored on the
   * device. Devices paired before that existed fall back to the reference one.
   */
  _address() {
    return this.getData().address || REFERENCE_ADDRESS;
  }

  /** Whether this device's role is the one that owns a button's state. */
  _ownsButton(button) {
    if (this._role() === 'light') {
      return button === 'light_on' || button === 'light_off'
        || Object.values(WHITES).includes(button);
    }
    return button === 'off' || /^speed_[1-6]$/.test(button);
  }

  /** The other half of this unit: same address, the other role. */
  _sibling() {
    const address = this._address();
    return this.driver.getDevices().find((d) => d !== this
      && typeof d._address === 'function'
      && d._address() === address
      && d._role() !== this._role());
  }

  /**
   * Paint the state a button implies, without transmitting. Used when the
   * button belongs to the OTHER device of the pair — the code goes out from
   * whichever device the Flow card sits on, but the tile that shows the result
   * is the sibling's.
   */
  async _applyState(button) {
    if (this._role() === 'light') {
      if (button === 'light_on' || button === 'light_off') {
        return this._set('onoff', button === 'light_on');
      }
      const capability = Object.keys(WHITES).find((c) => WHITES[c] === button);
      if (!capability) return undefined;
      await this.setStoreValue('white', capability).catch(this.error);
      return this._reflectWhite(capability);
    }
    if (button === 'off') return this._setState(0);
    return this._setState(Number(button.slice('speed_'.length)));
  }

  /**
   * Transmit a button and, unless asked not to, track what it does.
   *
   * Tracking is per button, not per device: a light code sent from the fan
   * device still updates the light's tile, because both halves answer to the
   * same address. Buttons with nothing to track — the timers, reverse, sleep
   * wind, the brightness steps — are simply transmitted.
   *
   * @param {string} button a key of BUTTON_IDS
   * @param {boolean} [track] whether to update tracked state
   */
  async pressButton(button, track = true) {
    if (BUTTON_IDS[button] === undefined) throw new Error(`Unknown button: ${button}`);
    if (!track) return this.sendButton(button);

    if (this._ownsButton(button)) {
      if (this._role() === 'light') {
        if (button === 'light_on' || button === 'light_off') {
          return this.setLight(button === 'light_on');
        }
        return this.setWhite(Object.keys(WHITES).find((c) => WHITES[c] === button), button);
      }
      if (button === 'off') return this.turnOff();
      return this.setSpeed(Number(button.slice('speed_'.length)));
    }

    const sibling = this._sibling();
    if (sibling && sibling._ownsButton(button)) {
      await sibling._applyState(button).catch(this.error);
    }
    return this.sendButton(button);
  }

  /** Switch the light, painting the new state before transmitting. */
  async setLight(on) {
    const previous = this.getCapabilityValue('onoff');
    await this._set('onoff', on);
    try {
      await this.sendButton(on ? 'light_on' : 'light_off');
    } catch (err) {
      await this._set('onoff', previous);
      throw err;
    }
  }

  /**
   * Transmit one captured button code. Does not touch tracked state.
   * @param {string} button a key of BUTTON_IDS
   */
  async sendButton(button) {
    const id = BUTTON_IDS[button];
    if (id === undefined) throw new Error(`Unknown button: ${button}`);
    const frame = frameForId(this._address(), id);

    const repetitions = this.getSetting('repetitions') || 5;

    // Queue behind any in-flight transmission, and keep the chain alive on failure.
    const send = this._txChain.then(async () => {
      // Deafen the receiver for the burst, so the driver does not read our own
      // transmission as a remote press. Muted here rather than at call time
      // because this may have waited in the queue.
      this.driver.muteRx(repetitions * FRAME_MS);
      this.log(`tx ${button} x${repetitions} via ${this.getSetting('signal_variant')}`);
      await this._signal().tx(frame, { repetitions });
      this.driver.muteRx(0); // extend the guard past the end of the burst
    });
    this._txChain = send.catch(() => {});
    await send;
  }

};




