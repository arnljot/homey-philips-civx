// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

const Homey = require('homey');

module.exports = class PhilipsCivxApp extends Homey.App {

  async onInit() {
    this.homey.flow.getActionCard('set_speed')
      .registerRunListener(async ({ device, speed }) => device.setSpeed(speed));

    // Any of the 19 codes. `update_state` is a checkbox defaulting to true;
    // unticked it transmits without touching state, which is what range testing
    // wants. Cards placed before the checkbox existed report `undefined`, and
    // are read as ticked so they behave like every other card.
    this.homey.flow.getActionCard('send_raw_code')
      .registerRunListener(async ({ device, button, update_state: track }) => (
        device.pressButton(button, track !== false)
      ));

    this.log('Philips Civx Ceiling Fan app ready');
  }

};

