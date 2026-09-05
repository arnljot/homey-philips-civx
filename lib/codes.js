// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

/**
 * Captured 41-bit frames for the Philips Civx remote (433.92 MHz OOK).
 *
 * Bits 0..23  address, identical on every button
 * Bits 24..39 per-button command
 * Bit  40     trailer, always 0
 *
 * Source of truth: ../docs/codes.json
 */
const CODES = {
  speed_1: '00101011110011010000110101000001101010100',
  speed_2: '00101011110011010000110110101101010001100',
  speed_3: '00101011110011010000110110011110011101010',
  speed_4: '00101011110011010000110100100011110010000',
  speed_5: '00101011110011010000110110000000011010110',
  speed_6: '00101011110011010000110110001101011001100',
  off: '00101011110011010000110100010011111110000',
};

const ADDRESS = '001010111100110100001101';
const FRAME_LENGTH = 41;

// The word-index arrays Signal#tx expects: words[0] is a 0 bit (340us mark /
// 720us space), words[1] a 1 bit (720us / 330us).
const FRAMES = {};
for (const [name, bits] of Object.entries(CODES)) {
  if (bits.length !== FRAME_LENGTH || !/^[01]+$/.test(bits)) {
    throw new Error(`Malformed frame for ${name}: ${bits}`);
  }
  if (!bits.startsWith(ADDRESS)) {
    throw new Error(`Frame for ${name} does not carry the expected address`);
  }
  FRAMES[name] = bits.split('').map(Number);
}

/** Button id for a speed step 1..6, e.g. speedButton('3') -> 'speed_3'. */
function speedButton(step) {
  const name = `speed_${step}`;
  if (!FRAMES[name]) throw new Error(`No code for speed step ${step}`);
  return name;
}

module.exports = {
  CODES, FRAMES, ADDRESS, FRAME_LENGTH, speedButton,
};

// Maximum bit errors tolerated when identifying a received frame. Both radii
// are bounded by measurement, not taste — see "Matching rules" in CLAUDE.md.
const MATCH_TOLERANCE_BITS = 4;
const DISTORTED_TOLERANCE_BITS = 1;

// Reverse lookup for received frames: '0010101...' -> 'speed_3'.
const BUTTON_BY_FRAME = {};
for (const [name, frame] of Object.entries(FRAMES)) {
  BUTTON_BY_FRAME[frame.join('')] = name;
}

/**
 * A matcher for ONE fan's frames.
 *
 * Every unit answers to its own address, so a matcher built from the reference
 * remote's codes recognises the reference remote and nothing else. Callers
 * build one per paired address; the distortion is deterministic, so the
 * received form of any address can be predicted without ever hearing it.
 *
 * @param {Object<string,string>} framesByName button id -> 41-bit string
 */
function matcherFor(framesByName) {
  const real = {};
  const distorted = {};
  for (const [name, bits] of Object.entries(framesByName)) {
    if (!/^[01]{41}$/.test(bits)) throw new Error(`Malformed frame for ${name}: ${bits}`);
    real[name] = bits;
    distorted[name] = distort(bits.split('').map(Number));
  }

  const nearestIn = (set) => (payload) => {
    if (!Array.isArray(payload) || payload.length !== FRAME_LENGTH) return null;
    const bits = payload.join('');
    let best = null;
    for (const [name, candidate] of Object.entries(set)) {
      let distance = 0;
      for (let i = 0; i < FRAME_LENGTH; i++) if (candidate[i] !== bits[i]) distance++;
      if (!best || distance < best.distance) best = { name, distance };
    }
    return best;
  };

  const nearestReal = nearestIn(real);
  const nearestMangled = nearestIn(distorted);

  return {
    real,
    distorted,
    nearestCode: nearestReal,
    nearestDistorted: nearestMangled,
    /**
     * @param {number[]} payload array of word indexes
     * @param {number} [tolerance] maximum bit errors to accept
     * @returns {string|null} button id, or null if it is not this fan's
     */
    matchButton(payload, tolerance = MATCH_TOLERANCE_BITS) {
      const near = nearestReal(payload);
      if (near && near.distance <= tolerance) return near.name;
      const mangled = nearestMangled(payload);
      return mangled && mangled.distance <= DISTORTED_TOLERANCE_BITS ? mangled.name : null;
    },
  };
}

/**
 * Identify a received payload as one of the captured buttons, by exact code
 * first and by the receiver's distorted rendering second.
 *
 * Bound to the REFERENCE remote. Anything driving a user's own fan must build
 * its own matcher with matcherFor().
 *
 * @param {number[]} payload array of word indexes
 * @param {number} [tolerance] maximum bit errors to accept
 * @returns {string|null} button id, or null if it is not one of ours
 */
function matchButton(payload, tolerance = MATCH_TOLERANCE_BITS) {
  const near = nearestCode(payload);
  if (near && near.distance <= tolerance) return near.name;

  const distorted = nearestDistorted(payload);
  return distorted && distorted.distance <= DISTORTED_TOLERANCE_BITS ? distorted.name : null;
}

/**
 * How Homey's receiver renders a transmitted frame.
 *
 * It cannot resolve this remote's PWM, but it fails deterministically: a
 * received bit is 1 only where the previous and current transmitted bits are
 * both 0. The app recognises that form rather than trying to decode properly.
 * See "RX: WORKS, but not by decoding correctly" in CLAUDE.md.
 *
 * @param {number[]} bits transmitted frame
 * @returns {string} how the receiver renders it
 */
function distort(bits) {
  let out = '';
  for (let i = 0; i < bits.length; i++) {
    const prev = i > 0 ? bits[i - 1] : 0;
    out += (prev === 0 && bits[i] === 0) ? '1' : '0';
  }
  return out;
}

const DISTORTED = {};
for (const [name, frame] of Object.entries(FRAMES)) DISTORTED[name] = distort(frame);

/**
 * Closest distorted code to a received payload.
 * @param {number[]} payload
 * @returns {{name: string, distance: number}|null}
 */
function nearestDistorted(payload) {
  if (!Array.isArray(payload) || payload.length !== FRAME_LENGTH) return null;
  const bits = payload.join('');
  let best = null;
  for (const [name, d] of Object.entries(DISTORTED)) {
    let distance = 0;
    for (let i = 0; i < FRAME_LENGTH; i++) if (d[i] !== bits[i]) distance++;
    if (!best || distance < best.distance) best = { name, distance };
  }
  return best;
}

module.exports.BUTTON_BY_FRAME = BUTTON_BY_FRAME;
module.exports.matchButton = matchButton;
module.exports.DISTORTED = DISTORTED;
module.exports.distort = distort;
module.exports.nearestDistorted = nearestDistorted;

/**
 * Closest captured code to a received payload, by Hamming distance. A small
 * distance is the difference between "not our remote" and "our remote, decoded
 * badly".
 * @param {number[]} payload
 * @returns {{name: string, distance: number}|null}
 */
function nearestCode(payload) {
  if (!Array.isArray(payload) || payload.length !== FRAME_LENGTH) return null;
  let best = null;
  for (const [name, frame] of Object.entries(FRAMES)) {
    let distance = 0;
    for (let i = 0; i < FRAME_LENGTH; i++) if (frame[i] !== payload[i]) distance++;
    if (!best || distance < best.distance) best = { name, distance };
  }
  return best;
}

module.exports.nearestCode = nearestCode;
module.exports.matcherFor = matcherFor;



