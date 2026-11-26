import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { isKeyboardVisible, KEYBOARD_VISIBLE_KEY } from '../web/ui/onscreen-keyboard.js';

describe('on-screen keyboard preference', () => {
  test('defaults to on when nothing has been stored', () => {
    assert.equal(isKeyboardVisible(), true);
  });

  test('the storage key is stable so Practice and Learn share it', () => {
    assert.equal(KEYBOARD_VISIBLE_KEY, 'typebreak-keyboard-visible');
  });
});
