/**
 * Keyboard model — the single source of truth for which finger is responsible
 * for a key, and which physical movement that key requires.
 *
 * Everything downstream (error attribution, finger progress, BTS weakness
 * detection, lesson targeting) reads from this module. It contains no state and
 * no randomness, so it is safe to share between the CLI, the web server and the
 * tests.
 */

/** Canonical finger identifiers, in screen order. */
export const FINGERS = [
  'LPINKY',
  'LRING',
  'LMIDDLE',
  'LINDEX',
  'LTHUMB',
  'RTHUMB',
  'RINDEX',
  'RMIDDLE',
  'RRING',
  'RPINKY',
];

export const FINGER_INFO = {
  LPINKY: { id: 'LPINKY', label: 'Left pinky', short: 'L5', hand: 'left', home: 'a', order: 0 },
  LRING: { id: 'LRING', label: 'Left ring', short: 'L4', hand: 'left', home: 's', order: 1 },
  LMIDDLE: { id: 'LMIDDLE', label: 'Left middle', short: 'L3', hand: 'left', home: 'd', order: 2 },
  LINDEX: { id: 'LINDEX', label: 'Left index', short: 'L2', hand: 'left', home: 'f', order: 3 },
  LTHUMB: { id: 'LTHUMB', label: 'Left thumb', short: 'L1', hand: 'left', home: ' ', order: 4 },
  RTHUMB: { id: 'RTHUMB', label: 'Right thumb', short: 'R1', hand: 'right', home: ' ', order: 5 },
  RINDEX: { id: 'RINDEX', label: 'Right index', short: 'R2', hand: 'right', home: 'j', order: 6 },
  RMIDDLE: { id: 'RMIDDLE', label: 'Right middle', short: 'R3', hand: 'right', home: 'k', order: 7 },
  RRING: { id: 'RRING', label: 'Right ring', short: 'R4', hand: 'right', home: 'l', order: 8 },
  RPINKY: { id: 'RPINKY', label: 'Right pinky', short: 'R5', hand: 'right', home: ';', order: 9 },
};

export const HAND_LABEL = { left: 'Left hand', right: 'Right hand', both: 'Both hands' };

/**
 * Movement taxonomy.
 *
 * `single` movements are what an individual key press requires and are used for
 * per-key error attribution. `combo` movements describe skills that only exist
 * across more than one key press (alternation, rolls, digraphs ...) and are used
 * as lesson targets.
 */
export const MOVEMENTS = {
  home: {
    id: 'home',
    kind: 'single',
    label: 'Home position',
    description: 'Pressing the resting key for a finger without leaving the home row.',
  },
  up: {
    id: 'up',
    kind: 'single',
    label: 'Upward reach',
    description: 'Reaching one row up from home, then returning.',
  },
  down: {
    id: 'down',
    kind: 'single',
    label: 'Downward reach',
    description: 'Reaching one row down from home, then returning.',
  },
  stretch: {
    id: 'stretch',
    kind: 'single',
    label: 'Number-row stretch',
    description: 'Stretching two rows up to the number row and returning to home.',
  },
  inner: {
    id: 'inner',
    kind: 'single',
    label: 'Inner-column reach',
    description: 'Index finger reaching to the inner columns (t g b / y h n).',
  },
  outer: {
    id: 'outer',
    kind: 'single',
    label: 'Outer-column reach',
    description: 'Pinky stretching outward to bracket and quote keys.',
  },
  space: {
    id: 'space',
    kind: 'single',
    label: 'Thumb space',
    description: 'Thumb pressing the space bar while the other fingers stay anchored.',
  },
  alternation: {
    id: 'alternation',
    kind: 'combo',
    label: 'Cross-hand alternation',
    description: 'Alternating between the two hands so one hand rests while the other types.',
  },
  'same-hand-roll': {
    id: 'same-hand-roll',
    kind: 'combo',
    label: 'Same-hand roll',
    description: 'Rolling through neighbouring fingers of one hand in sequence.',
  },
  crossover: {
    id: 'crossover',
    kind: 'combo',
    label: 'Index crossover',
    description: 'Passing between the two index fingers across the centre of the keyboard (g / h).',
  },
  'shift-reach': {
    id: 'shift-reach',
    kind: 'combo',
    label: 'Shift reach',
    description: 'Holding shift with one pinky while the opposite hand types the letter.',
  },
  digraph: {
    id: 'digraph',
    kind: 'combo',
    label: 'Common digraphs',
    description: 'High-frequency two-letter patterns typed as one motion.',
  },
  trigraph: {
    id: 'trigraph',
    kind: 'combo',
    label: 'Common trigraphs',
    description: 'High-frequency three-letter patterns typed as one motion.',
  },
  'double-letter': {
    id: 'double-letter',
    kind: 'combo',
    label: 'Double letters',
    description: 'Pressing the same key twice with a controlled double tap.',
  },
  'common-word': {
    id: 'common-word',
    kind: 'combo',
    label: 'Common words',
    description: 'Whole high-frequency words typed without conscious letter search.',
  },
  coordination: {
    id: 'coordination',
    kind: 'combo',
    label: 'Full coordination',
    description: 'Mixed content exercising all fingers, both hands and the space bar together.',
  },
};

export const SINGLE_MOVEMENTS = Object.values(MOVEMENTS)
  .filter((m) => m.kind === 'single')
  .map((m) => m.id);

export const COMBO_MOVEMENTS = Object.values(MOVEMENTS)
  .filter((m) => m.kind === 'combo')
  .map((m) => m.id);

/** Visual layout, also used by the web on-screen keyboard. */
export const KEYBOARD_ROWS = [
  { id: 'numbers', keys: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'] },
  { id: 'top', keys: ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p', '[', ']'] },
  { id: 'home', keys: ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', ';', "'"] },
  { id: 'bottom', keys: ['z', 'x', 'c', 'v', 'b', 'n', 'm', ',', '.', '/'] },
  { id: 'space', keys: [' '] },
];

const ROW_OFFSETS = { numbers: 2, top: 1, home: 0, bottom: -1, space: 0 };

/**
 * Authored key table. Every printable key we teach maps to exactly one finger.
 * `row` is relative to the home row: 0 home, 1 up, 2 up twice, -1 down.
 * `shifted` lists the shifted form produced while holding shift.
 */
const KEY_TABLE = [
  // Number row
  ['1', 'LPINKY', 2, '!'],
  ['2', 'LRING', 2, '@'],
  ['3', 'LMIDDLE', 2, '#'],
  ['4', 'LINDEX', 2, '$'],
  ['5', 'LINDEX', 2, '%'],
  ['6', 'RINDEX', 2, '^'],
  ['7', 'RINDEX', 2, '&'],
  ['8', 'RMIDDLE', 2, '*'],
  ['9', 'RRING', 2, '('],
  ['0', 'RPINKY', 2, ')'],
  // Top row
  ['q', 'LPINKY', 1, 'Q'],
  ['w', 'LRING', 1, 'W'],
  ['e', 'LMIDDLE', 1, 'E'],
  ['r', 'LINDEX', 1, 'R'],
  ['t', 'LINDEX', 1, 'T'],
  ['y', 'RINDEX', 1, 'Y'],
  ['u', 'RINDEX', 1, 'U'],
  ['i', 'RMIDDLE', 1, 'I'],
  ['o', 'RRING', 1, 'O'],
  ['p', 'RPINKY', 1, 'P'],
  ['[', 'RPINKY', 1, '{'],
  [']', 'RPINKY', 1, '}'],
  // Home row
  ['a', 'LPINKY', 0, 'A'],
  ['s', 'LRING', 0, 'S'],
  ['d', 'LMIDDLE', 0, 'D'],
  ['f', 'LINDEX', 0, 'F'],
  ['g', 'LINDEX', 0, 'G'],
  ['h', 'RINDEX', 0, 'H'],
  ['j', 'RINDEX', 0, 'J'],
  ['k', 'RMIDDLE', 0, 'K'],
  ['l', 'RRING', 0, 'L'],
  [';', 'RPINKY', 0, ':'],
  ["'", 'RPINKY', 0, '"'],
  // Bottom row
  ['z', 'LPINKY', -1, 'Z'],
  ['x', 'LRING', -1, 'X'],
  ['c', 'LMIDDLE', -1, 'C'],
  ['v', 'LINDEX', -1, 'V'],
  ['b', 'LINDEX', -1, 'B'],
  ['n', 'RINDEX', -1, 'N'],
  ['m', 'RINDEX', -1, 'M'],
  [',', 'RMIDDLE', -1, '<'],
  ['.', 'RRING', -1, '>'],
  ['/', 'RPINKY', -1, '?'],
];

/** Keys that are an inward reach for the index finger rather than a straight row move. */
const INNER_KEYS = new Set(['t', 'g', 'b', 'y', 'h', 'n']);
/** Pinky keys that require stretching sideways past the home column. */
const OUTER_KEYS = new Set(['[', ']', "'"]);

const CHAR_MAP = new Map();

for (const [key, finger, row, shifted] of KEY_TABLE) {
  const movement = key === ' ' ? 'space' : INNER_KEYS.has(key) ? 'inner' : OUTER_KEYS.has(key) ? 'outer' : row === 2 ? 'stretch' : row === 1 ? 'up' : row === -1 ? 'down' : 'home';

  const entry = {
    key,
    finger,
    hand: FINGER_INFO[finger].hand,
    row,
    movement,
    shifted,
    shiftHand: FINGER_INFO[finger].hand === 'left' ? 'right' : 'left',
  };

  CHAR_MAP.set(key, entry);
  CHAR_MAP.set(shifted, { ...entry, shiftedVariant: true, requiresShift: true });
}

CHAR_MAP.set(' ', {
  key: ' ',
  finger: 'LTHUMB',
  hand: 'left',
  row: 0,
  movement: 'space',
  requiresShift: false,
});

export const HOME_KEYS = FINGER_INFO;

/** Returns the key info for a single character, or null when unmapped. */
export function keyInfo(ch) {
  if (typeof ch !== 'string' || ch.length === 0) return null;
  return CHAR_MAP.get(ch) ?? CHAR_MAP.get(ch.toLowerCase()) ?? null;
}

/** Finger responsible for a character, or null when unmapped (or when it is a space, returned as thumb). */
export function fingerForChar(ch) {
  const info = keyInfo(ch);
  if (!info) return null;
  if (ch === ' ') return 'LTHUMB';
  return info.finger;
}

/** Physical movement required by a character, or null when unmapped. */
export function movementForChar(ch) {
  const info = keyInfo(ch);
  return info ? info.movement : null;
}

/**
 * Describe a character for display and attribution. Always returns an object so
 * callers never have to null-check in the middle of a loop.
 */
export function describeChar(ch) {
  const info = keyInfo(ch);
  if (!info) {
    return {
      char: ch,
      mapped: false,
      finger: null,
      movement: null,
      hand: null,
      fingerLabel: 'Unmapped',
      movementLabel: 'Unmapped',
      handLabel: 'Unknown',
    };
  }
  return {
    char: ch,
    mapped: true,
    finger: info.finger,
    movement: info.movement,
    hand: info.hand,
    fingerLabel: FINGER_INFO[info.finger].label,
    movementLabel: MOVEMENTS[info.movement].label,
    handLabel: HAND_LABEL[info.hand],
    requiresShift: Boolean(info.requiresShift),
  };
}

/** All characters belonging to a finger, home row first. */
export function charsForFinger(finger) {
  const keys = KEY_TABLE.filter(([, f]) => f === finger).map(([k]) => k);
  return keys.sort((a, b) => {
    const ra = keyInfo(a).row;
    const rb = keyInfo(b).row;
    return ra - rb || a.localeCompare(b);
  });
}

/** Human label for a finger id. */
export function fingerLabel(finger) {
  return FINGER_INFO[finger]?.label ?? 'Unknown finger';
}

/** Human label for a movement id. */
export function movementLabel(movement) {
  return MOVEMENTS[movement]?.label ?? 'Unknown movement';
}

/** The two thumbs both own the space bar; pick the resting thumb for a hand. */
export function thumbForHand(hand) {
  return hand === 'right' ? 'RTHUMB' : 'LTHUMB';
}

export const KEY_TABLE_SOURCE = KEY_TABLE;
