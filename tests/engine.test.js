/**
 * Typing engine tests.
 *
 * The engine is the scoring authority for both interfaces, so its maths is
 * pinned down precisely: WPM definition, accuracy over keystrokes, strict vs
 * flow behaviour, and per-finger error attribution.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { TypingSession, computeMetrics, summarizeAttempts, formatDuration, round } from '../web/core/engine.js';

/** A session with a controllable clock. */
function session(text, { mode = 'flow', start = 0 } = {}) {
  let time = start;
  const now = () => time;
  const s = new TypingSession({ text, lessonId: 'L', exerciseId: 'E', mode, now });
  return {
    s,
    tick: (ms) => {
      time += ms;
    },
    type: (input) => s.press(input),
  };
}

describe('metrics', () => {
  test('WPM uses five characters per word', () => {
    // 250 correct chars in exactly one minute = 50 WPM.
    const m = computeMetrics({ correctChars: 250, totalKeystrokes: 250, errors: 0, elapsedMs: 60000, totalChars: 250 });
    assert.equal(m.wpm, 50);
    assert.equal(m.cpm, 250);
  });

  test('accuracy is measured over keystrokes, so corrections cost accuracy', () => {
    // 100 keystrokes, 10 of which were wrong = 90%.
    const m = computeMetrics({ correctChars: 90, totalKeystrokes: 100, errors: 10, elapsedMs: 60000, totalChars: 90 });
    assert.equal(m.accuracy, 90);
  });

  test('accuracy is 100 when nothing was typed', () => {
    const m = computeMetrics({ correctChars: 0, totalKeystrokes: 0, errors: 0, elapsedMs: 0, totalChars: 10 });
    assert.equal(m.accuracy, 100);
  });

  test('sub-second attempts do not report absurd speeds', () => {
    // Without a floor, 20 chars in 1ms would be ~240,000 WPM.
    const m = computeMetrics({ correctChars: 20, totalKeystrokes: 20, errors: 0, elapsedMs: 1, totalChars: 20 });
    assert.ok(m.wpm < 1000, `WPM should be floored to something sane, got ${m.wpm}`);
  });

  test('completion reflects progress through the text', () => {
    const m = computeMetrics({ correctChars: 5, totalKeystrokes: 5, errors: 0, elapsedMs: 60000, totalChars: 10 });
    assert.equal(m.completion, 50);
  });

  test('completion measures progress, not correctness', () => {
    // Regression: completion used to be correctChars/total, which made 100%
    // unreachable after a single mistake and therefore made a lesson impossible
    // to pass however clean the rest of it was.
    const m = computeMetrics({
      correctChars: 9,
      totalKeystrokes: 10,
      errors: 1,
      elapsedMs: 60000,
      totalChars: 10,
      position: 10,
    });
    assert.equal(m.completion, 100, 'the caret reached the end of the text');
    assert.equal(m.accuracy, 90, 'and accuracy still reports the mistake');
  });

  test('completion cannot exceed 100 even if position overruns', () => {
    const m = computeMetrics({ correctChars: 10, totalKeystrokes: 12, errors: 2, elapsedMs: 1000, totalChars: 10, position: 12 });
    assert.equal(m.completion, 100);
  });
});

describe('session typing', () => {
  test('correct keys advance the caret and count as correct', () => {
    const { s, type } = session('abc');
    const r1 = type('a');
    assert.equal(r1.correct, true);
    assert.equal(r1.position, 1);
    assert.equal(s.correctChars, 1);
    assert.equal(s.errors, 0);
  });

  test('flow mode advances on error and records the mistake', () => {
    const { s, type } = session('ab', { mode: 'flow' });
    const r = type('x');
    assert.equal(r.correct, false);
    assert.equal(r.position, 1, 'flow mode should still advance');
    assert.equal(s.errors, 1);
    assert.equal(s.results[0], false);
    assert.equal(s.typed[0], 'x');
  });

  test('strict mode holds position on error so the key is retried', () => {
    const { s, type } = session('ab', { mode: 'strict' });
    const r = type('x');
    assert.equal(r.accepted, false);
    assert.equal(r.position, 0, 'strict mode must not advance');
    assert.equal(s.errors, 1);
    // Retrying correctly then advances.
    const r2 = type('a');
    assert.equal(r2.correct, true);
    assert.equal(r2.position, 1);
  });

  test('strict mode still counts every keystroke against accuracy', () => {
    const { s, type } = session('a', { mode: 'strict' });
    type('x');
    type('y');
    type('a');
    assert.equal(s.totalKeystrokes, 3);
    assert.equal(s.errors, 2);
    assert.equal(round(s.stats().accuracy, 1), 33.3);
  });

  test('completing the text finishes the session exactly once', () => {
    const { s, type } = session('ab');
    type('a');
    const last = type('b');
    assert.equal(last.finished, true);
    assert.equal(s.completed, true);
    const after = type('c');
    assert.equal(after.finished, true);
    assert.equal(s.totalKeystrokes, 2, 'keystrokes after completion must be ignored');
  });

  test('carriage return is normalised to a newline', () => {
    const { s, type } = session('a\nb');
    type('a');
    const r = type('\r');
    assert.equal(r.correct, true, '\\r should match the expected \\n');
    assert.equal(s.position, 2);
  });

  test('backspace rewinds only correct characters and not the keystroke count', () => {
    const { s, type } = session('abc');
    type('a');
    type('b');
    assert.equal(s.position, 2);
    assert.equal(s.backspace(), true);
    assert.equal(s.position, 1);
    assert.equal(s.totalKeystrokes, 2, 'backspace must not erase the record of typing');
    assert.equal(s.backspace(), true);
    assert.equal(s.backspace(), false, 'cannot backspace before the start');
  });

  test('elapsed time stops when the session completes', () => {
    const { s, tick, type } = session('a');
    tick(1000);
    type('a');
    const elapsedAtFinish = s.elapsedMs;
    tick(5000);
    assert.equal(s.elapsedMs, elapsedAtFinish, 'time must freeze after completion');
  });

  test('an empty target text is rejected', () => {
    assert.throws(() => new TypingSession({ text: '', lessonId: 'L', exerciseId: 'E' }));
  });

  test('an unknown mode is rejected', () => {
    assert.throws(() => new TypingSession({ text: 'a', lessonId: 'L', exerciseId: 'E', mode: 'turbo' }));
  });
});

describe('error attribution', () => {
  test('errors are attributed to the expected character, finger and movement', () => {
    // 'f' is left index home; 'q' is left pinky up.
    const { s, type } = session('fq');
    type('x'); // wrong for the expected 'f'
    type('q'); // correct for the expected 'q'
    assert.equal(s.errorsByChar.f, 1);
    assert.equal(s.errorsByFinger.LINDEX, 1);
    assert.equal(s.errorsByMovement.home, 1);
    assert.equal(s.errorsByFinger.LPINKY, undefined, 'correct keys must not be attributed as errors');
  });

  test('a mistake on a finger is recorded against that finger', () => {
    const { s, type } = session('ff');
    type('j'); // 'f' expected; left index is responsible
    type('f');
    type('f');
    assert.equal(s.errorsByFinger.LINDEX, 1, 'the expected key was an LINDEX key');
    assert.equal(s.errorsByChar.f, 1);
    assert.equal(s.errorsByMovement.home, 1);
  });

  test('mistakes on different fingers are attributed separately', () => {
    const { s, type } = session('fs');
    type('j'); // f → LINDEX
    type('k'); // s → LRING
    assert.equal(s.errorsByFinger.LINDEX, 1);
    assert.equal(s.errorsByFinger.LRING, 1);
  });

  test('target attribution counts correct and wrong per finger', () => {
    const { s } = session('ffss');
    s.press('f');
    s.press('x'); // wrong at position 1 (f)
    s.press('s');
    s.press('s');
    const { fingerStats } = s.attributeTargets();
    assert.equal(fingerStats.LINDEX.correct, 1);
    assert.equal(fingerStats.LINDEX.wrong, 1);
    assert.equal(fingerStats.LRING.correct, 2);
    assert.equal(fingerStats.LRING.wrong, 0);
  });

  test('a fully correct session reports fullyCorrect', () => {
    const { s, type } = session('ff');
    type('f');
    type('f');
    assert.equal(s.finish().fullyCorrect, true);
  });

  test('a session with an uncorrected mistake is not fullyCorrect', () => {
    const { s, type } = session('ff');
    type('x');
    type('f');
    assert.equal(s.finish().fullyCorrect, false);
  });
});

describe('segments', () => {
  test('segments describe each character state for rendering', () => {
    const { s, type } = session('abc');
    type('a');
    type('x'); // wrong at 'b', flow mode advances
    const segments = s.segments();
    assert.equal(segments[0].state, 'correct');
    assert.equal(segments[1].state, 'wrong');
    assert.equal(segments[2].state, 'current');
  });

  test('segments merge consecutive characters in the same state', () => {
    const { s } = session('aaab');
    for (const ch of 'aaa') s.press(ch);
    const segments = s.segments();
    assert.equal(segments.length, 2, 'aaa should be one run plus the current char');
    assert.equal(segments[0].text, 'aaa');
    assert.equal(segments[1].state, 'current');
  });
});

describe('summaries', () => {
  test('summarizing no attempts is safe', () => {
    const s = summarizeAttempts([]);
    assert.equal(s.attempts, 0);
    assert.equal(s.accuracy, 0);
  });

  test('summarize averages metrics across attempts', () => {
    const mk = (wpm, accuracy) => ({ metrics: { wpm, accuracy, cpm: wpm * 5, errors: 1, elapsedMs: 1000, completion: 100, totalKeystrokes: 10 } });
    const s = summarizeAttempts([mk(20, 90), mk(40, 100)]);
    assert.equal(s.attempts, 2);
    assert.equal(s.wpm, 30);
    assert.equal(s.accuracy, 95);
  });

  test('duration formatting', () => {
    assert.equal(formatDuration(0), '0:00');
    assert.equal(formatDuration(1500), '0:02');
    assert.equal(formatDuration(65000), '1:05');
  });
});
