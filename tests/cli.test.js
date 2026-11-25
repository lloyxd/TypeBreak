/**
 * CLI drill tests.
 *
 * The interactive drill uses raw-mode stdin, which is hard to test normally. The
 * drill accepts injected input/output streams, so it is driven here through a
 * fake TTY without mutating the real process streams (which would swallow the
 * test reporter's own output).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { runDrill } from '../src/cli/drill.js';
import { createTheme } from '../src/cli/ui.js';
import { TypingSession } from '../src/core/engine.js';

const lesson = {
  id: 'TEST-LESSON',
  name: 'Test lesson',
  level: 2,
  fingers: ['LINDEX'],
  movements: ['home'],
  criteria: { minAccuracy: 95, minWpm: 20, speedIsAdvisory: true },
  exercises: [
    { id: 'TEST-LESSON-E1', text: 'ff jj', focus: 'f j' },
    { id: 'TEST-LESSON-E2', text: 'fj jf', focus: 'f j' },
  ],
};

const theme = createTheme({ enabled: false });

/** A fake TTY pair: emits keypress events and captures painted frames. */
function fakeTty() {
  const stdin = new EventEmitter();
  stdin.isTTY = true;
  stdin.isRaw = false;
  stdin.setRawMode = (value) => {
    stdin.isRaw = value;
  };
  stdin.resume = () => {};
  stdin.pause = () => {};

  const frames = [];
  const stdout = {
    isTTY: true,
    columns: 100,
    write: (chunk) => {
      frames.push(String(chunk));
      return true;
    },
  };

  return { stdin, stdout, frames };
}

/** Emit a character keypress. */
function typeChar(stdin, ch) {
  stdin.emit('keypress', ch, { name: ch === ' ' ? 'space' : ch, sequence: ch });
}

/** Wait long enough for the drill's listener to attach. */
const settle = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));

describe('runDrill (interactive)', () => {
  test('records a perfect attempt when every key is correct', async () => {
    const { stdin, stdout } = fakeTty();
    const exercise = lesson.exercises[0];
    const pending = runDrill({ lesson, exercise, mode: 'flow', theme, input: stdin, output: stdout });

    await settle();
    for (const ch of exercise.text) typeChar(stdin, ch);

    const outcome = await pending;
    assert.ok(outcome, 'the drill should resolve with a record');
    assert.equal(outcome.record.metrics.accuracy, 100);
    assert.equal(outcome.record.metrics.errors, 0);
    assert.equal(outcome.record.metrics.completion, 100);
    assert.equal(outcome.record.fullyCorrect, true);
    assert.equal(outcome.record.lessonId, 'TEST-LESSON');
    assert.equal(outcome.record.exerciseId, 'TEST-LESSON-E1');
  });

  test('records an error without aborting in flow mode', async () => {
    const { stdin, stdout } = fakeTty();
    const exercise = lesson.exercises[0]; // 'ff jj' — five characters
    const pending = runDrill({ lesson, exercise, mode: 'flow', theme, input: stdin, output: stdout });
    await settle();

    // Flow mode advances past a mistake, so a wrong first key uses up position
    // 0 and the remaining four keys complete the drill.
    typeChar(stdin, 'x');
    for (const ch of exercise.text.slice(1)) typeChar(stdin, ch);

    const outcome = await pending;
    assert.equal(outcome.record.metrics.errors, 1);
    assert.equal(outcome.record.metrics.completion, 100, 'every position should have been consumed');
    assert.equal(outcome.record.fullyCorrect, false, 'a mistake means the exercise was not perfect');
    // The first expected char is 'f' (left index), so that finger is blamed.
    assert.equal(outcome.record.errorsByFinger.LINDEX, 1);
  });

  test('flow mode leaves the tail untyped if keys are skipped', async () => {
    const { stdin, stdout } = fakeTty();
    const exercise = lesson.exercises[0];
    const pending = runDrill({ lesson, exercise, mode: 'flow', theme, input: stdin, output: stdout });
    await settle();

    // Four keys against a five-character text: the drill should not complete,
    // so abandon it to end the test deterministically.
    typeChar(stdin, 'x');
    for (const ch of exercise.text.slice(1, 4)) typeChar(stdin, ch);
    await settle();
    stdin.emit('keypress', '', { name: 'escape', sequence: '\u001b' });

    assert.equal(await pending, null, 'an incomplete exercise is abandoned, not scored');
  });

  test('strict mode does not advance on a wrong key', async () => {
    const { stdin, stdout } = fakeTty();
    const exercise = lesson.exercises[0];
    const pending = runDrill({ lesson, exercise, mode: 'strict', theme, input: stdin, output: stdout });
    await settle();

    typeChar(stdin, 'x'); // wrong, should not advance
    typeChar(stdin, 'f'); // correct for position 0
    for (const ch of exercise.text.slice(1)) typeChar(stdin, ch);

    const outcome = await pending;
    assert.equal(outcome.record.metrics.errors, 1);
    assert.equal(outcome.record.metrics.completion, 100, 'the text should still complete');
  });

  test('escape abandons the exercise and records nothing', async () => {
    const { stdin, stdout } = fakeTty();
    const exercise = lesson.exercises[0];
    const pending = runDrill({ lesson, exercise, mode: 'flow', theme, input: stdin, output: stdout });
    await settle();

    typeChar(stdin, 'f');
    stdin.emit('keypress', '', { name: 'escape', sequence: '\u001b' });

    assert.equal(await pending, null, 'an abandoned drill resolves to null');
  });

  test('ctrl-c abandons the exercise', async () => {
    const { stdin, stdout } = fakeTty();
    const exercise = lesson.exercises[0];
    const pending = runDrill({ lesson, exercise, mode: 'flow', theme, input: stdin, output: stdout });
    await settle();

    typeChar(stdin, 'f');
    stdin.emit('keypress', 'c', { name: 'c', ctrl: true, sequence: '\u0003' });

    assert.equal(await pending, null);
  });

  test('renders progress and the next-key hint', async () => {
    const { stdin, stdout, frames } = fakeTty();
    const exercise = lesson.exercises[0];
    const pending = runDrill({ lesson, exercise, mode: 'flow', theme, input: stdin, output: stdout });
    await settle();

    typeChar(stdin, 'f');
    await settle();
    for (const ch of exercise.text.slice(1)) typeChar(stdin, ch);
    await pending;

    const painted = frames.join('');
    assert.match(painted, /Test lesson/, 'the lesson name should be rendered');
    assert.match(painted, /WPM/, 'the HUD should be rendered');
    assert.match(painted, /Next/, 'the next-key hint should be rendered');
    assert.match(painted, /Left index/, 'the finger hint should be rendered');
    assert.ok(frames.length >= 2, 'the view should repaint as keys arrive');
  });

  test('restores the terminal mode after finishing', async () => {
    const { stdin, stdout } = fakeTty();
    const exercise = lesson.exercises[0];
    const pending = runDrill({ lesson, exercise, mode: 'flow', theme, input: stdin, output: stdout });
    await settle();
    for (const ch of exercise.text) typeChar(stdin, ch);
    await pending;
    assert.equal(stdin.isRaw, false, 'raw mode must be turned off when the drill ends');
  });

  test('the keypress listener is removed after the drill ends', async () => {
    const { stdin, stdout } = fakeTty();
    const exercise = lesson.exercises[0];
    const pending = runDrill({ lesson, exercise, mode: 'flow', theme, input: stdin, output: stdout });
    await settle();
    for (const ch of exercise.text) typeChar(stdin, ch);
    await pending;
    assert.equal(stdin.listenerCount('keypress'), 0, 'a leaked listener would eat later keystrokes');
  });

  test('ignores multi-character sequences such as paste markers', async () => {
    const { stdin, stdout } = fakeTty();
    const exercise = lesson.exercises[0];
    const pending = runDrill({ lesson, exercise, mode: 'flow', theme, input: stdin, output: stdout });
    await settle();

    stdin.emit('keypress', '[200~', { name: undefined, sequence: '[200~' });
    for (const ch of exercise.text) typeChar(stdin, ch);

    const outcome = await pending;
    assert.equal(outcome.record.metrics.errors, 0, 'a paste marker must not count as a keystroke');
  });
});

describe('TypingSession drives the drill', () => {
  test('the drill reports exactly what the engine scored', () => {
    // Same text, same input, same engine — the drill must not add scoring of
    // its own. The clock starts on the first keystroke, so five keys at 100ms
    // intervals span 400ms.
    const text = 'ff jj';
    let time = 0;
    const direct = new TypingSession({ text, lessonId: 'L', exerciseId: 'E', mode: 'flow', now: () => time });
    for (const ch of text) {
      time += 100;
      direct.press(ch);
    }
    const record = direct.finish();
    assert.equal(record.metrics.accuracy, 100);
    assert.equal(record.metrics.elapsedMs, 400);
    assert.equal(record.metrics.completion, 100);
  });
});
