/**
 * Keyboard model tests.
 *
 * The library's coverage requirements are only meaningful if the underlying
 * key→finger→movement mapping is correct, so that is asserted exhaustively.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  FINGERS,
  FINGER_INFO,
  MOVEMENTS,
  KEY_TABLE_SOURCE,
  keyInfo,
  fingerForChar,
  movementForChar,
  describeChar,
  charsForFinger,
} from '../src/core/keyboard.js';

describe('keyboard model', () => {
  test('every finger has a home key and metadata', () => {
    for (const finger of FINGERS) {
      const info = FINGER_INFO[finger];
      assert.ok(info, `missing info for ${finger}`);
      assert.ok(info.label, `${finger} has no label`);
      assert.ok(['left', 'right'].includes(info.hand), `${finger} has a bad hand`);
      assert.ok(info.home, `${finger} has no home key`);
      assert.equal(typeof info.order, 'number');
    }
    assert.equal(FINGERS.length, 10, 'there must be exactly ten fingers');
  });

  test('every authored key maps to exactly one finger', () => {
    for (const [key, finger] of KEY_TABLE_SOURCE) {
      assert.ok(FINGER_INFO[finger], `key ${key} maps to unknown finger ${finger}`);
      const info = keyInfo(key);
      assert.ok(info, `key ${key} did not resolve`);
      assert.equal(info.finger, finger);
    }
  });

  test('shifted characters resolve to the same finger as their base key', () => {
    for (const [key, finger, , shifted] of KEY_TABLE_SOURCE) {
      if (!shifted) continue;
      const shiftedInfo = keyInfo(shifted);
      assert.ok(shiftedInfo, `shifted char ${shifted} did not resolve`);
      assert.equal(shiftedInfo.finger, finger, `${shifted} should use the same finger as ${key}`);
      assert.equal(shiftedInfo.requiresShift, true);
    }
  });

  test('space is owned by a thumb', () => {
    assert.equal(fingerForChar(' '), 'LTHUMB');
    assert.equal(movementForChar(' '), 'space');
    const info = describeChar(' ');
    assert.equal(info.mapped, true);
    assert.ok(info.fingerLabel.includes('thumb'));
  });

  test('unmapped characters are reported, not thrown', () => {
    for (const ch of ['\n', '\t', '€', 'ß']) {
      assert.equal(keyInfo(ch), null, `${JSON.stringify(ch)} should not be mapped`);
      const info = describeChar(ch);
      assert.equal(info.mapped, false);
      assert.equal(info.finger, null);
    }
  });

  test('every movement id is declared in MOVEMENTS', () => {
    for (const [key] of KEY_TABLE_SOURCE) {
      const movement = movementForChar(key);
      assert.ok(MOVEMENTS[movement], `key ${key} produced unknown movement ${movement}`);
    }
  });

  test('home-row keys are classified as home movements for their own finger', () => {
    const homeExpectations = {
      a: 'LPINKY',
      s: 'LRING',
      d: 'LMIDDLE',
      f: 'LINDEX',
      j: 'RINDEX',
      k: 'RMIDDLE',
      l: 'RRING',
      ';': 'RPINKY',
    };
    for (const [key, finger] of Object.entries(homeExpectations)) {
      assert.equal(fingerForChar(key), finger, `${key} should be typed by ${finger}`);
      assert.equal(movementForChar(key), 'home', `${key} should be a home movement`);
    }
  });

  test('inner-column keys use the index fingers', () => {
    for (const key of ['t', 'g', 'b']) {
      assert.equal(fingerForChar(key), 'LINDEX', `${key} should be left index`);
      assert.equal(movementForChar(key), 'inner');
    }
    for (const key of ['y', 'h', 'n']) {
      assert.equal(fingerForChar(key), 'RINDEX', `${key} should be right index`);
      assert.equal(movementForChar(key), 'inner');
    }
  });

  test('row reaches are classified up/down/stretch', () => {
    assert.equal(movementForChar('q'), 'up');
    assert.equal(movementForChar('z'), 'down');
    assert.equal(movementForChar('1'), 'stretch');
    assert.equal(movementForChar('0'), 'stretch');
  });

  test('outer-column keys use the right pinky', () => {
    for (const key of ['[', ']', "'"]) {
      assert.equal(fingerForChar(key), 'RPINKY', `${key} should be right pinky`);
      assert.equal(movementForChar(key), 'outer');
    }
  });

  test('charsForFinger returns only that finger keys, home row first', () => {
    for (const finger of FINGERS) {
      const keys = charsForFinger(finger);
      for (const key of keys) {
        assert.equal(fingerForChar(key), finger, `${key} should belong to ${finger}`);
      }
      if (keys.length > 1) {
        const rows = keys.map((k) => keyInfo(k).row);
        const sorted = [...rows].sort((a, b) => a - b);
        assert.deepEqual(rows, sorted, `${finger} keys should be ordered by row`);
      }
    }
  });

  test('the whole alphabet plus digits and common punctuation is covered', () => {
    const required = 'abcdefghijklmnopqrstuvwxyz0123456789,.;\'/[]';
    for (const ch of required) {
      assert.ok(keyInfo(ch), `character ${ch} must be mapped`);
    }
  });
});
