/**
 * Builds the predefined lesson library.
 *
 * The runtime NEVER generates exercises: it only reads `data/lessons.json`.
 * This script is the authoring tool that writes that file once. Regeneration is
 * deterministic (seeded PRNG, no clock, no randomness), so the committed
 * library is reproducible and reviewable in diffs.
 *
 *   npm run lessons:build
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FINGERS,
  FINGER_INFO,
  MOVEMENTS,
  charsForFinger,
  fingerLabel,
  keyInfo,
  movementLabel,
} from '../web/core/keyboard.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'web', 'data', 'lessons.json');

/* ------------------------------------------------------------------ *
 * Deterministic randomness
 * ------------------------------------------------------------------ */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const pick = (rng, arr) => arr[Math.floor(rng() * arr.length) % arr.length];

/* ------------------------------------------------------------------ *
 * Exercise text generation
 * ------------------------------------------------------------------ */

/**
 * Build one exercise line from a weighted key set. Keys are grouped into short
 * chunks separated by spaces, the way a real drill looks.
 */
function makeLine(rng, weights, { groups, minLen, maxLen }) {
  const bag = [];
  for (const [key, weight] of Object.entries(weights)) {
    for (let i = 0; i < weight; i += 1) bag.push(key);
  }
  const parts = [];
  const count = groups[0] + Math.floor(rng() * (groups[1] - groups[0] + 1));
  for (let g = 0; g < count; g += 1) {
    const len = minLen + Math.floor(rng() * (maxLen - minLen + 1));
    let chunk = '';
    for (let i = 0; i < len; i += 1) {
      let ch = pick(rng, bag);
      // Avoid triples: they turn a reach drill into a hammering drill.
      if (i >= 2 && ch === chunk[i - 1] && ch === chunk[i - 2]) {
        ch = bag.find((k) => k !== ch) ?? ch;
      }
      chunk += ch;
    }
    parts.push(chunk);
  }
  return parts.join(' ');
}

function weightMap(keys, targetKeys) {
  const targets = new Set(targetKeys);
  return Object.fromEntries(keys.map((k) => [k, targets.has(k) ? 3 : 1]));
}

function makeExercises(lessonId, keys, opts, count = 3, targetKeys = keys) {
  const rng = mulberry32(hashString(lessonId));
  const weights = weightMap(keys, targetKeys);
  const heavy = [...new Set([...targetKeys, keys[0]])].filter((k) => keys.includes(k));
  const out = [];
  for (let i = 0; i < count; i += 1) {
    let text = makeLine(rng, weights, opts);
    // Guarantee every targeted key appears at least once per exercise.
    const missing = heavy.filter((k) => !text.includes(k));
    if (missing.length && missing.length < text.length) {
      const chars = text.split('');
      for (const key of missing) {
        const at = Math.floor(rng() * chars.length);
        if (chars[at] !== ' ') chars[at] = key;
      }
      text = chars.join('');
    }
    out.push({
      id: `${lessonId}-E${i + 1}`,
      text,
      focus: heavy.join(' '),
    });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Difficulty model
 * ------------------------------------------------------------------ */

const FINGER_BASE = {
  LINDEX: 1,
  RINDEX: 1,
  LMIDDLE: 2,
  RMIDDLE: 2,
  LRING: 3,
  RRING: 3,
  LPINKY: 4,
  RPINKY: 4,
  LTHUMB: 3,
  RTHUMB: 3,
};

const MOVEMENT_COST = {
  home: 0,
  space: 1,
  down: 1,
  up: 2,
  inner: 2,
  outer: 3,
  stretch: 4,
  alternation: 3,
  'same-hand-roll': 3,
  crossover: 4,
  'shift-reach': 4,
  digraph: 3,
  trigraph: 4,
  'double-letter': 3,
  'common-word': 4,
  coordination: 5,
};

const clampLevel = (n) => Math.max(1, Math.min(10, n));

/**
 * Performance criteria grow with difficulty. Accuracy gates progression; WPM is
 * advisory so slow-but-clean learners are not blocked.
 */
function criteriaFor(level) {
  return {
    minAccuracy: Math.max(88, 97 - level),
    minWpm: 18 + level * 3,
    attempts: level <= 3 ? 2 : level <= 6 ? 3 : 4,
    speedIsAdvisory: true,
  };
}

/* ------------------------------------------------------------------ *
 * Key selection
 * ------------------------------------------------------------------ */

const MOVEMENT_KEYS = {
  home: ['a', 's', 'd', 'f', 'j', 'k', 'l', ';'],
  up: ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
  down: ['z', 'x', 'c', 'v', 'b', 'n', 'm', ',', '.', '/'],
  stretch: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
  inner: ['t', 'g', 'b', 'y', 'h', 'n'],
  outer: ['[', ']', "'"],
  space: ['a', 's', 'd', 'f', 'j', 'k', 'l'],
};

/** Home anchors each finger must keep planted. */
const ANCHORS = {
  LPINKY: ['a'],
  LRING: ['s'],
  LMIDDLE: ['d'],
  LINDEX: ['f'],
  RINDEX: ['j'],
  RMIDDLE: ['k'],
  RRING: ['l'],
  RPINKY: [';'],
  LTHUMB: [],
  RTHUMB: [],
};

/**
 * Keys a movement lesson exercises.
 *
 * `targets` are the finger's own keys for that movement and are drilled
 * heaviest; `context` adds the neighbouring fingers' keys for the same movement
 * plus the home anchors, so the drill stays readable and the hand cannot cheat
 * by sliding. Every key is verified to be mapped.
 *
 * Returns `{ keys, targets }`.
 */
function keysForMovement(finger, movement) {
  if (movement === 'space') {
    const keys = ['a', 's', 'd', 'f', 'j', 'k', 'l'];
    return { keys, targets: keys };
  }

  const hand = FINGER_INFO[finger].hand;
  const siblings = FINGERS.filter((f) => f !== finger && FINGER_INFO[f].hand === hand && f !== 'LTHUMB' && f !== 'RTHUMB');

  if (movement === 'home') {
    const homeKeys = hand === 'right' ? ['j', 'k', 'l', ';'] : ['a', 's', 'd', 'f'];
    return { keys: homeKeys, targets: ANCHORS[finger] ?? homeKeys };
  }

  const pool = MOVEMENT_KEYS[movement] ?? [];
  const owned = pool.filter((k) => keyInfo(k)?.finger === finger);
  if (owned.length === 0) return { keys: [], targets: [] };

  const context = pool.filter((k) => siblings.some((f) => keyInfo(k)?.finger === f));
  const anchor = (ANCHORS[finger] ?? []).filter(() => movement !== 'stretch');

  const keys = [...new Set([...(movement === 'inner' ? anchor : []), ...owned, ...(movement === 'inner' ? [] : context)])];
  return { keys, targets: owned };
}

/**
 * Movement variations that do not exist for a finger on a US ANSI layout: the
 * left pinky has no outer-column keys, and neither pinky has an inner reach.
 */
function movementSupported(finger, movement) {
  if (movement === 'outer') return FINGER_INFO[finger].hand === 'right';
  if (movement === 'inner') return finger === 'LINDEX' || finger === 'RINDEX';
  return true;
}

const MOVEMENT_EXERCISE_OPTS = {
  home: { groups: [4, 6], minLen: 2, maxLen: 4 },
  up: { groups: [4, 6], minLen: 2, maxLen: 4 },
  down: { groups: [4, 6], minLen: 2, maxLen: 4 },
  stretch: { groups: [4, 5], minLen: 2, maxLen: 3 },
  inner: { groups: [4, 6], minLen: 2, maxLen: 4 },
  outer: { groups: [4, 5], minLen: 2, maxLen: 3 },
  space: { groups: [4, 6], minLen: 2, maxLen: 4 },
};

const OUTCOME_BY_MOVEMENT = {
  home: 'Presses the home key reliably without moving the other fingers off their anchors.',
  up: 'Reaches one row up and returns to home without looking down.',
  down: 'Reaches the bottom row and returns to home cleanly.',
  stretch: 'Stretches to the number row and returns to home without drift.',
  inner: 'Reaches the inner-column keys with a controlled index motion.',
  outer: 'Stretches the pinky outward without rotating the whole hand.',
  space: 'Strikes the space bar with the thumb while the other fingers stay anchored.',
};

/* ------------------------------------------------------------------ *
 * Lesson assembly
 * ------------------------------------------------------------------ */

const lessons = [];

function addLesson(lesson) {
  if (lessons.some((l) => l.id === lesson.id)) throw new Error(`Duplicate lesson id: ${lesson.id}`);
  lessons.push(lesson);
}

const FINGER_MOVEMENTS = {
  LPINKY: ['home', 'up', 'down', 'stretch'],
  RPINKY: ['home', 'up', 'down', 'stretch', 'outer'],
  LRING: ['home', 'up', 'down', 'stretch'],
  RRING: ['home', 'up', 'down', 'stretch'],
  LMIDDLE: ['home', 'up', 'down', 'stretch'],
  RMIDDLE: ['home', 'up', 'down', 'stretch'],
  LINDEX: ['home', 'up', 'down', 'stretch', 'inner'],
  RINDEX: ['home', 'up', 'down', 'stretch', 'inner'],
  LTHUMB: ['space'],
  RTHUMB: ['space'],
};

const movementLessonIndex = new Map();

for (const finger of FINGERS) {
  for (const movement of FINGER_MOVEMENTS[finger]) {
    if (!movementSupported(finger, movement)) continue;
    const level = clampLevel(FINGER_BASE[finger] + MOVEMENT_COST[movement]);
    const id = `L-${finger}-${movement.toUpperCase()}`;
    const { keys, targets } = keysForMovement(finger, movement);
    if (!keys.length) continue;
    const isThumb = finger === 'LTHUMB' || finger === 'RTHUMB';
    const fingerText = fingerLabel(finger).toLowerCase();

    const name = isThumb
      ? `${fingerLabel(finger)} · space bar control`
      : `${fingerLabel(finger)} · ${movementLabel(movement).toLowerCase()}`;

    const description = isThumb
      ? `Keep four fingers anchored on a home-row quartet and drive the space bar with the ${fingerText}, letting the other hand rest between words.`
      : `Isolate the ${fingerText} on ${keys.map((k) => `"${k}"`).join(', ')} so it works alone while the rest of the hand stays planted on home row.`;

    addLesson({
      id,
      name,
      description,
      category: movement === 'home' ? 'finger-isolation' : 'movement-variation',
      level,
      fingers: [finger],
      movements: [movement],
      keys,
      exercises: makeExercises(id, keys, MOVEMENT_EXERCISE_OPTS[movement], 3, targets),
      outcome: OUTCOME_BY_MOVEMENT[movement],
      related: [],
      criteria: criteriaFor(level),
      estimatedSeconds: 45 + level * 8,
    });

    movementLessonIndex.set(`${finger}:${movement}`, id);
  }
}

/* --- 2. Finger transition lessons ------------------------------------- */

const NEIGHBOURS = {
  LPINKY: ['LRING'],
  LRING: ['LMIDDLE'],
  LMIDDLE: ['LINDEX'],
  LINDEX: ['LMIDDLE'],
  RINDEX: ['RMIDDLE'],
  RMIDDLE: ['RRING'],
  RRING: ['RPINKY'],
  RPINKY: ['RRING'],
};

for (const finger of FINGERS) {
  for (const other of NEIGHBOURS[finger] ?? []) {
    const pair = [finger, other].sort((a, b) => FINGER_INFO[a].order - FINGER_INFO[b].order);
    const id = `L-TRANSITION-${pair[0]}-${pair[1]}`;
    if (lessons.some((l) => l.id === id)) continue;

    const keys = [
      ...new Set(
        [...charsForFinger(pair[0]), ...charsForFinger(pair[1])].filter((k) =>
          ['home', 'up', 'down'].includes(keyInfo(k).movement),
        ),
      ),
    ];
    const level = clampLevel(4 + Math.round((FINGER_BASE[pair[0]] + FINGER_BASE[pair[1]]) / 2));

    addLesson({
      id,
      name: `${fingerLabel(pair[0])} → ${fingerLabel(pair[1])} transitions`,
      description: `Move back and forth between ${fingerLabel(pair[0]).toLowerCase()} and ${fingerLabel(pair[1]).toLowerCase()} across home, top and bottom rows without breaking rhythm.`,
      category: 'finger-combination',
      level,
      fingers: pair,
      movements: ['home', 'up', 'down'],
      keys,
      exercises: makeExercises(id, keys, { groups: [5, 7], minLen: 2, maxLen: 4 }),
      outcome: `Smooth, even timing when alternating between the ${fingerLabel(pair[0]).toLowerCase()} and the ${fingerLabel(pair[1]).toLowerCase()}.`,
      related: [
        movementLessonIndex.get(`${pair[0]}:home`),
        movementLessonIndex.get(`${pair[1]}:home`),
      ].filter(Boolean),
      criteria: criteriaFor(level),
      estimatedSeconds: 60 + level * 8,
    });
  }
}

/* --- 3. Skill combination lessons ------------------------------------- */

const ALL_TYPING_FINGERS = FINGERS.filter((f) => f !== 'LTHUMB' && f !== 'RTHUMB');

const SKILL_LESSONS = [
  {
    id: 'L-SKILL-ALTERNATION',
    name: 'Cross-hand alternation',
    category: 'pattern',
    level: 4,
    fingers: ALL_TYPING_FINGERS,
    movements: ['alternation'],
    keys: ['a', 's', 'd', 'f', 'j', 'k', 'l', 'e', 'i', 'o', 'n', 'r'],
    description:
      'Alternate strictly left/right on the home and top rows. One hand rests fully while the other works — the basis of sustainable speed.',
    outcome: 'Keeps one hand idle while the other types, removing same-hand finger tangles.',
    content: [
      'sad had fad lad sis dad ask lass fall dahl',
      'flak jade safe lead sank lake hash gala half',
      'else idea also done fire near road said side',
      'hand land send lend held shelf half dash khan',
    ],
    related: ['L-SKILL-ROLL', 'L-SKILL-DIGRAPH'],
  },
  {
    id: 'L-SKILL-ROLL',
    name: 'Same-hand rolls',
    category: 'pattern',
    level: 5,
    fingers: ALL_TYPING_FINGERS,
    movements: ['same-hand-roll'],
    keys: ['a', 's', 'd', 'f', 'j', 'k', 'l', 'e', 'r', 'u', 'i', 'o'],
    description:
      'Roll through neighbouring fingers of one hand in sequence, outside-in and inside-out. Rolls are the fastest and least error-prone same-hand motion.',
    outcome: 'Chains three or four same-hand keys with one flowing motion instead of discrete stabs.',
    content: [
      'were tree free deer feed seed keel look pool',
      'drew asks adds sass dads lulu kiki juju pool',
      'sold fold gold held weld field shield juiced',
      'jerk kelp self idle older order udder inner',
    ],
    related: ['L-SKILL-ALTERNATION', 'L-SKILL-DOUBLE'],
  },
  {
    id: 'L-SKILL-CROSSOVER',
    name: 'Index crossover',
    category: 'pattern',
    level: 6,
    fingers: ['LINDEX', 'RINDEX'],
    movements: ['crossover'],
    keys: ['f', 'g', 'h', 'j', 't', 'y', 'b', 'n', 'v', 'm'],
    description:
      'Pass between the index fingers across the centre column (g and h). This is the only place the two hands share a boundary, and the most common source of silent index errors.',
    outcome: 'Hits g and h with the correct index finger every time, without crossing hands.',
    content: [
      'gh hg ghg hgh gh hg ght hgh gh hg jhg fgh',
      'high thigh thing hung hang bang gong hong hg',
      'gnat hang hinge gh gh hg hg gb nh hb ng gbn',
      'bg nh hb ng gbn gnh gbh hbg gnb nhb hgn bhg',
    ],
    related: ['L-SKILL-ALTERNATION', 'L-SKILL-DIGRAPH'],
  },
  {
    id: 'L-SKILL-SHIFT',
    name: 'Shift reach',
    category: 'pattern',
    level: 6,
    fingers: ['LPINKY', 'RPINKY'],
    movements: ['shift-reach'],
    keys: ['A', 'S', 'D', 'F', 'J', 'K', 'L', 'Q', 'W', 'E', 'U', 'I', 'O', 'P'],
    description:
      'Hold shift with the pinky of the resting hand, then type the capital with the opposite hand. Never type a capital with a shift key on the same side.',
    outcome: 'Produces capitals using opposite-hand shift without slowing the whole word.',
    content: [
      'Al So Di Fa Ju Ke Li Pa Quad Went Us Out Pip',
      'AS DF JK LQ WE UI OP AS DF JK LQ WE UI OP QU',
      'Abe Sue Dora Finn Jose Kate Lena Paul Quinn Wil',
      'Ed If Ox Up Am Be Do Go Hi In Jo Ki La My No',
    ],
    related: ['L-SKILL-ALTERNATION', 'L-SKILL-WORDS'],
  },
  {
    id: 'L-SKILL-DIGRAPH',
    name: 'High-frequency digraphs',
    category: 'pattern',
    level: 5,
    fingers: ALL_TYPING_FINGERS,
    movements: ['digraph'],
    keys: ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', 'e', 'r', 't', 'i', 'o', 'n', 'u'],
    description:
      'Drill the two-letter pairs that make up most English text (th, he, in, er, an, re) until they are single motions rather than two decisions.',
    outcome: 'Types common pairs as one unit, raising speed without dropping accuracy.',
    content: [
      'th he in er an re on at en nd ti es or te of ed',
      'th th he he in in er er an an re re on on at at',
      'the then there these those other rather either',
      'think thing thank their there they them then th',
    ],
    related: ['L-SKILL-TRIGRAPH', 'L-SKILL-ROLL'],
  },
  {
    id: 'L-SKILL-TRIGRAPH',
    name: 'High-frequency trigraphs',
    category: 'pattern',
    level: 6,
    fingers: ALL_TYPING_FINGERS,
    movements: ['trigraph'],
    keys: ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', 'e', 'r', 't', 'i', 'o', 'n', 'u', 'w'],
    description:
      'Extend the digraph drills to three-letter groups (the, and, ing, ion, ent, her) which occur so often that a stumble in one costs whole words.',
    outcome: 'Produces the most common three-letter groups without a pause at any boundary.',
    content: [
      'the and ing ion ent her ter ere hat tha for',
      'the and ing ion ent her the and ing ion ent',
      'thing going doing being thank think there their',
      'nation action station mention section question',
    ],
    related: ['L-SKILL-DIGRAPH', 'L-SKILL-WORDS'],
  },
  {
    id: 'L-SKILL-DOUBLE',
    name: 'Double letters',
    category: 'pattern',
    level: 5,
    fingers: ALL_TYPING_FINGERS,
    movements: ['double-letter'],
    keys: ['a', 's', 'd', 'f', 'l', 'k', 'e', 'o', 't', 'n'],
    description:
      'The same key twice in a row needs a controlled double tap, not a held key. Doubles are where fast typists lose accuracy first.',
    outcome: 'Reproduces doubled letters at speed without dropping or tripling them.',
    content: [
      'all off see too add odd ill egg ask less tell',
      'letter better summer dinner coffee running fill',
      'sheet steel speed sweet greet fleet street need',
      'happen sudden common cotton lesson button middle',
    ],
    related: ['L-SKILL-ROLL', 'L-SKILL-DIGRAPH'],
  },
  {
    id: 'L-SKILL-WORDS',
    name: 'Common words',
    category: 'pattern',
    level: 6,
    fingers: ALL_TYPING_FINGERS,
    movements: ['common-word'],
    keys: ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', 'e', 'r', 't', 'i', 'o', 'n', 'u', 'w', 'v'],
    description:
      'Whole high-frequency words typed as single chunks. The top 100 English words cover roughly half of all text, so these patterns pay back immediately.',
    outcome: 'Types the most common English words without searching for individual letters.',
    content: [
      'the of and to in is you that it he was for on',
      'are as with his they at be this have from one',
      'had by hot word but what some we can out other',
      'were all there when up use your how said an each',
    ],
    related: ['L-SKILL-DIGRAPH', 'L-SKILL-COORDINATION'],
  },
  {
    id: 'L-SKILL-NUMBERS',
    name: 'Number row integration',
    category: 'pattern',
    level: 7,
    fingers: ['LPINKY', 'LRING', 'LMIDDLE', 'LINDEX', 'RINDEX', 'RMIDDLE', 'RRING', 'RPINKY'],
    movements: ['stretch'],
    keys: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', 'a', 's', 'd', 'f', 'j', 'k', 'l', ';'],
    description:
      'Stretch to the number row while the rest of the hand holds home, then return. Numbers break rhythm more than any other row because the reach is two rows deep.',
    outcome: 'Reaches any number-row key and returns to home without losing the anchor.',
    content: [
      '1a 2s 3d 4f 5f 6j 7j 8k 9l 0; 1a 2s 3d 4f',
      '11 22 33 44 55 66 77 88 99 00 12 34 56 78 90',
      'a1 s2 d3 f4 j7 k8 l9 ;0 fa jf dk sl a; 4f 7j',
      '123 456 789 0 12 34 56 78 90 f4 j7 d3 k8 s2',
    ],
    related: ['L-SKILL-PUNCTUATION', 'L-SKILL-COORDINATION'],
  },
  {
    id: 'L-SKILL-PUNCTUATION',
    name: 'Punctuation and symbols',
    category: 'pattern',
    level: 7,
    fingers: ['LPINKY', 'RPINKY', 'RMIDDLE', 'RRING', 'RINDEX'],
    movements: ['outer', 'down', 'shift-reach'],
    keys: [',', '.', ';', "'", '/', '[', ']', 'a', 's', 'd', 'f', 'j', 'k', 'l'],
    description:
      'Commas, periods, semicolons, quotes and brackets, all reached from home. Punctuation is where pinky drift shows up as sloppy sentences.',
    outcome: 'Reaches comma, period and semicolon accurately with the correct finger.',
    content: [
      'as, if; do. we: it, he. so; an, at. be, my; no.',
      'red, blue; green. gold, grey; teal. ash, oil; eel.',
      'ask, said. read; lead. fade, dead; heed. look, jade.',
      'a; s. d, f; j. k, l; a. s, d; f. j, k; l. a, f;',
    ],
    related: ['L-SKILL-NUMBERS', 'L-SKILL-COORDINATION'],
  },
  {
    id: 'L-SKILL-WEAK-PINKY',
    name: 'Pinky endurance',
    category: 'pattern',
    level: 8,
    fingers: ['LPINKY', 'RPINKY'],
    movements: ['home', 'stretch', 'outer'],
    keys: ['a', 'q', 'z', '1', ';', 'p', "'", '/', 'o', 's', 'k'],
    description:
      'Long sustained pinky work. The pinkies have the least independent strength and the longest reach, so they fatigue and drift first.',
    outcome: 'Keeps each pinky on its key for extended runs without collapsing inward.',
    content: [
      'aqa zqz aqa zqz qpq ;l; /;/ papa quip pulp',
      'as ask zaq aqs qaz zap lap pal lop pol oil',
      'applaq aqaq zqza qaza asas l;l; p;p; o;o;',
      'quick quiz jazz pizza plaza apple people poppy',
    ],
    related: ['L-LPINKY-HOME', 'L-RPINKY-HOME', 'L-SKILL-COORDINATION'],
  },
  {
    id: 'L-SKILL-COORDINATION',
    name: 'Full coordination',
    category: 'coordination',
    level: 9,
    fingers: ALL_TYPING_FINGERS,
    movements: ['coordination', 'alternation', 'common-word'],
    keys: ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', 'q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p', 'z', 'x', 'c', 'v', 'b', 'n', 'm'],
    description:
      'Real sentences using every finger, both hands and the space bar. This is the transfer test: everything drilled separately now has to work together at once.',
    outcome: 'Sustains accurate, even typing across unconstrained English text.',
    content: [
      'the quick brown fox jumps over the lazy dog near',
      'pack my box with five dozen liquor jugs before nine',
      'a calm hand keeps steady rhythm through every line',
      'when the work is even the speed will follow the hand',
    ],
    related: ['L-SKILL-WORDS', 'L-SKILL-NUMBERS', 'L-SKILL-PUNCTUATION'],
  },
];

for (const spec of SKILL_LESSONS) {
  addLesson({
    id: spec.id,
    name: spec.name,
    description: spec.description,
    category: spec.category,
    level: spec.level,
    fingers: spec.fingers,
    movements: spec.movements,
    keys: [...new Set(spec.keys)],
    exercises: spec.content.map((text, i) => ({
      id: `${spec.id}-E${i + 1}`,
      text,
      focus: spec.keys.slice(0, 8).join(' '),
    })),
    outcome: spec.outcome,
    related: spec.related,
    criteria: criteriaFor(spec.level),
    estimatedSeconds: 60 + spec.level * 10,
  });
}

/* --- 4. Fill in related lessons for anything still empty -------------- */

for (const lesson of lessons) {
  if (lesson.related.length) continue;
  const related = [];
  for (const finger of lesson.fingers) {
    for (const movement of FINGER_MOVEMENTS[finger] ?? []) {
      const id = movementLessonIndex.get(`${finger}:${movement}`);
      if (id && id !== lesson.id) related.push(id);
      if (related.length >= 3) break;
    }
    if (related.length >= 3) break;
  }
  lesson.related = related;
}

/* --- 5. Ordering and validation --------------------------------------- */

lessons.sort((a, b) => a.level - b.level || a.id.localeCompare(b.id));
lessons.forEach((lesson, i) => {
  lesson.order = i + 1;
});

const coveredFingers = new Set(lessons.flatMap((l) => l.fingers));
const missingFingers = FINGERS.filter((f) => !coveredFingers.has(f));
if (missingFingers.length) throw new Error(`Library does not cover fingers: ${missingFingers.join(', ')}`);

const coveredMovements = new Set(lessons.flatMap((l) => l.movements));
const missingMovements = Object.keys(MOVEMENTS).filter((m) => !coveredMovements.has(m));
if (missingMovements.length) throw new Error(`Library does not cover movements: ${missingMovements.join(', ')}`);

const ids = new Set(lessons.map((l) => l.id));
for (const lesson of lessons) {
  if (!lesson.exercises.length) throw new Error(`Lesson ${lesson.id} has no exercises`);
  for (const ex of lesson.exercises) {
    if (!ex.text.trim()) throw new Error(`Lesson ${lesson.id} has an empty exercise`);
    for (const ch of ex.text) {
      if (!keyInfo(ch) && ch !== ' ') throw new Error(`Lesson ${lesson.id} uses unmapped char "${ch}"`);
    }
  }
  for (const r of lesson.related) {
    if (!ids.has(r)) throw new Error(`Lesson ${lesson.id} references unknown related lesson ${r}`);
  }
}

/* --- 6. Emit --------------------------------------------------------- */

const library = {
  schemaVersion: 1,
  generatedBy: 'tools/build-lessons.js',
  note: 'Predefined lesson library. Runtime code must only read this file and never generate exercise content.',
  counts: {
    lessons: lessons.length,
    exercises: lessons.reduce((n, l) => n + l.exercises.length, 0),
    byCategory: lessons.reduce((acc, l) => {
      acc[l.category] = (acc[l.category] ?? 0) + 1;
      return acc;
    }, {}),
  },
  lessons: lessons.map((l) => ({
    ...l,
    fingers: [...new Set(l.fingers)].sort((a, b) => FINGER_INFO[a].order - FINGER_INFO[b].order),
    movements: [...new Set(l.movements)],
  })),
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(library, null, 2)}\n`, 'utf8');

console.log(`Wrote ${library.counts.lessons} lessons / ${library.counts.exercises} exercises to ${OUT}`);
console.log('By category:', library.counts.byCategory);
