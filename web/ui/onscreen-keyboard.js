/**
 * Shared on-screen keyboard and the show/hide preference.
 *
 * Default is visible. The choice is stored on this device so Practice and
 * Learn keep the same setting.
 */

import { h } from '../dom.js';
import { KEYBOARD_ROWS, describeChar } from '../core/keyboard.js';

export const KEYBOARD_VISIBLE_KEY = 'typebreak-keyboard-visible';

export function isKeyboardVisible() {
  try {
    const raw = localStorage.getItem(KEYBOARD_VISIBLE_KEY);
    if (raw === null) return true;
    return raw !== '0';
  } catch {
    return true;
  }
}

export function setKeyboardVisible(visible) {
  try {
    localStorage.setItem(KEYBOARD_VISIBLE_KEY, visible ? '1' : '0');
  } catch {
    /* private browsing — keep the in-memory choice only */
  }
}

export function createOnscreenKeyboard() {
  const keyEls = new Map();
  const board = h(
    'div.keyboard',
    { 'aria-hidden': 'true' },
    KEYBOARD_ROWS.map((row) =>
      h(
        'div.kb-row',
        null,
        row.keys.map((ch) => {
          const finger = describeChar(ch).finger;
          const el = h(
            `div.key${ch === ' ' ? '.space' : ''}${finger ? `.finger-${finger.toLowerCase()}` : ''}`,
            null,
            ch === ' ' ? 'space' : ch,
          );
          keyEls.set(ch, el);
          return el;
        }),
      ),
    ),
  );

  const wrap = h('div.keyboard-reveal', null, board);
  const toggle = buildToggle();

  function apply(visible) {
    wrap.classList.toggle('is-off', !visible);
    wrap.setAttribute('aria-hidden', visible ? 'false' : 'true');
    toggle.setAttribute('aria-checked', String(visible));
    toggle.classList.toggle('is-on', visible);
  }

  function paint(segments = [], pressed = null) {
    for (const el of keyEls.values()) el.classList.remove('active', 'pressed');
    const target = segments.find((segment) => segment.state === 'current');
    if (target) {
      const active = keyEls.get(String(target.text[0]).toLowerCase());
      if (active) active.classList.add('active');
    }
    if (pressed) {
      const el = keyEls.get(pressed.toLowerCase());
      if (el) {
        el.classList.add('pressed');
        setTimeout(() => el.classList.remove('pressed'), 90);
      }
    }
  }

  toggle.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const next = toggle.getAttribute('aria-checked') !== 'true';
    setKeyboardVisible(next);
    apply(next);
  });

  apply(isKeyboardVisible());

  return { wrap, toggle, paint, apply };
}

function buildToggle() {
  return h(
    'button.kb-toggle',
    {
      type: 'button',
      role: 'switch',
      'aria-checked': 'true',
      'aria-label': 'On-screen keyboard',
    },
    h('span.kb-toggle-track', { 'aria-hidden': 'true' }, h('span.kb-toggle-thumb')),
    h('span.kb-toggle-copy', null, 'Keyboard'),
  );
}
