/**
 * Interactive terminal typing drill.
 *
 * Captures raw keystrokes (no line buffering, no Enter required) so typing in
 * the terminal behaves like typing anywhere else. Falls back to a non-raw
 * prompt when stdin is not a TTY.
 *
 * All scoring comes from the shared `TypingSession`; this module only paints
 * and collects keys.
 */

import readline from 'node:readline';
import { TypingSession } from '../core/engine.js';
import { describeChar, FINGER_INFO, movementLabel } from '../core/keyboard.js';
import { SESSION_MODES } from '../core/engine.js';
import { createTheme, progressBar, rule, terminalWidth, wrap, humanDuration } from './ui.js';

const ESC = '\u001b[';

/**
 * Render the typing view: target text with per-character states, a live HUD,
 * and a finger hint.
 */
function render({ theme, session, lesson, exerciseIndex, exerciseCount, mode }) {
  const width = Math.min(terminalWidth(), 100);
  const stats = session.stats();
  const lines = [];

  lines.push('');
  lines.push(`${theme.bold(lesson.name)}  ${theme.gray(`level ${lesson.level} · exercise ${exerciseIndex}/${exerciseCount}`)}`);
  lines.push(rule(theme, width));
  lines.push('');

  // Target text, coloured per character state, wrapped by visible width.
  // Wrapping tracks a visible column so ANSI escapes never count, and breaks
  // only at spaces to keep words intact.
  const segments = session.segments();
  const paintChar = (ch, state) => {
    switch (state) {
      case 'correct':
        return theme.green(ch);
      case 'wrong':
        return theme.bgRed(theme.white(ch));
      case 'current':
        return theme.inverse(ch);
      default:
        return theme.gray(ch);
    }
  };

  const chunks = [];
  let line = '';
  let col = 0;
  for (const segment of segments) {
    for (const ch of segment.text) {
      line += paintChar(ch, segment.state);
      col += 1;
      if (col >= width && ch === ' ') {
        chunks.push(line);
        line = '';
        col = 0;
      }
    }
  }
  if (line.trim()) chunks.push(line);

  for (const chunk of chunks) lines.push(`  ${chunk}`);
  lines.push('');

  // HUD
  const accuracyHue = stats.accuracy >= 96 ? theme.green : stats.accuracy >= 92 ? theme.yellow : theme.red;
  lines.push(
    `  ${theme.gray('WPM')} ${theme.bold(String(stats.wpm).padStart(5))}   ` +
      `${theme.gray('ACC')} ${accuracyHue(`${stats.accuracy}%`.padStart(6))}   ` +
      `${theme.gray('ERR')} ${theme.bold(String(stats.errors).padStart(3))}   ` +
      `${theme.gray('TIME')} ${theme.bold(humanDuration(stats.elapsedMs))}`,
  );
  lines.push(`  ${theme.gray('Progress')} ${progressBar(stats.completion, { width: 30, theme })} ${theme.gray(`${Math.round(stats.completion)}%`)}`);
  lines.push('');

  // Finger hint for the character under the caret.
  const next = session.nextChar;
  if (next !== null) {
    const info = describeChar(next);
    const hintText = next === ' ' ? 'space' : next;
    lines.push(
      `  ${theme.gray('Next')} ${theme.bold(`[${hintText === ' ' ? '␣' : hintText}]`)}  ` +
        `${theme.cyan(info.fingerLabel)} ${theme.gray('·')} ${theme.gray(info.movementLabel)}` +
        (info.requiresShift ? ` ${theme.gray('· hold')} ${theme.bold(info.shiftHand === 'left' ? 'L-Shift' : 'R-Shift')}` : ''),
    );
  } else {
    lines.push(`  ${theme.green('Exercise complete — press Enter to continue.')}`);
  }
  lines.push('');
  lines.push(
    `  ${theme.gray(`mode: ${SESSION_MODES[mode].label} · `)}${theme.gray('Backspace fixes · Esc abandons')}`,
  );

  return lines.join('\n');
}

/**
 * Run one exercise interactively.
 *
 * @param {object} params
 * @param {object} params.lesson
 * @param {object} params.exercise
 * @param {string} [params.mode]
 * @param {object} [params.theme]
 * @param {NodeJS.ReadStream} [params.input]   Defaults to process.stdin.
 * @param {NodeJS.WriteStream} [params.output] Defaults to process.stdout.
 * @returns {Promise<{record, session}|null>}
 */
export function runDrill({
  service,
  lesson,
  exercise,
  mode = 'flow',
  theme = createTheme(),
  onKey = null,
  input = process.stdin,
  output = process.stdout,
}) {
  return new Promise((resolve) => {
    const session = new TypingSession({
      text: exercise.text,
      lessonId: lesson.id,
      exerciseId: exercise.id,
      mode,
      now: () => Date.now(),
    });

    const exerciseIndex = lesson.exercises.indexOf(exercise) + 1;
    const exerciseCount = lesson.exercises.length;

    const paint = () => {
      // Move the cursor home and repaint in place, so the screen does not grow.
      output.write(`${ESC}H${ESC}2J`);
      output.write(`${render({ theme, session, lesson, exerciseIndex, exerciseCount, mode })}\n`);
    };

    // Non-interactive fallback so the CLI still works when piped.
    if (!input.isTTY) {
      runLineBased(session, exercise, { input, output }).then((outcome) => {
        if (outcome.aborted) {
          resolve(null);
          return;
        }
        resolve({ record: session.finish(), session });
      });
      return;
    }

    const stdin = input;
    readline.emitKeypressEvents(stdin);
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();

    let done = false;

    const cleanup = () => {
      stdin.removeListener('keypress', onKeypress);
      try {
        stdin.setRawMode(wasRaw ?? false);
      } catch {
        /* ignore */
      }
      stdin.pause();
    };

    const onKeypress = (str, key) => {
      if (done) return;

      if (key?.name === 'escape' || (key?.ctrl && key.name === 'c')) {
        done = true;
        cleanup();
        output.write(`\n${theme.yellow('Exercise abandoned — nothing recorded.')}\n`);
        resolve(null);
        return;
      }

      if (key?.name === 'backspace') {
        if (session.backspace()) paint();
        return;
      }

      if (key?.name === 'return' || key?.name === 'enter') {
        // Enter only matters once complete; otherwise it is a real keystroke
        // looking for a newline the drill does not contain.
        if (session.nextChar === '\n') {
          session.press('\n');
          paint();
        }
        if (session.completed) {
          done = true;
          cleanup();
          resolve({ record: session.finish(), session });
        }
        return;
      }

      if (key?.ctrl || key?.meta) return;
      if (typeof str !== 'string' || str.length === 0) return;
      // Ignore multi-character sequences such as bracketed paste markers.
      if (str.length > 1) return;

      if (onKey) onKey(str);

      session.press(str);
      paint();

      if (session.completed) {
        done = true;
        // Small pause so the final state is visible before the summary.
        setTimeout(() => {
          cleanup();
          resolve({ record: session.finish(), session });
        }, 250);
      }
    };

    stdin.on('keypress', onKeypress);
    paint();
  });
}

/** Fallback for non-TTY stdin: read whole lines and score them. */
async function runLineBased(session, exercise, { input = process.stdin, output = process.stdout } = {}) {
  const rl = readline.createInterface({ input, output });
  output.write(`\nType this line exactly:\n  ${exercise.text}\n> `);
  const answer = await new Promise((resolve) => rl.question('', resolve));
  rl.close();
  for (const ch of answer) {
    if (session.completed) break;
    session.press(ch);
  }
  return { answer };
}

/**
 * Play a whole lesson: every exercise in order, with a summary between each.
 */
export async function runLesson({
  service,
  lesson,
  mode = 'flow',
  theme = createTheme(),
  ask = null,
  input = process.stdin,
  output = process.stdout,
}) {
  const results = [];

  for (const exercise of lesson.exercises) {
    const outcome = await runDrill({ service, lesson, exercise, mode, theme, input, output });
    if (!outcome) break;

    const evaluation = service.recordAttempt(outcome.record);
    printAttemptSummary(theme, evaluation, lesson, output);
    results.push({ ...evaluation, record: outcome.record });

    if (exercise !== lesson.exercises[lesson.exercises.length - 1]) {
      if (ask) {
        const next = await ask(theme, 'Continue to the next exercise?', ['y', 'n']);
        if (next !== 'y') break;
      }
    }
  }

  return results;
}

/** Print the post-exercise summary. */
export function printAttemptSummary(theme, evaluation, lesson, output = process.stdout) {
  const { record, verdict, attributedMistakes } = evaluation;
  const m = record.metrics;

  output.write('\n');
  output.write(`${theme.bold('Exercise result')} ${theme.gray('·')} ${lesson.name}\n`);
  output.write(`${theme.gray('─'.repeat(Math.min(terminalWidth(), 60)))}\n`);

  const accHue = m.accuracy >= 96 ? theme.green : m.accuracy >= 92 ? theme.yellow : theme.red;
  output.write(
    `  ${theme.gray('WPM')} ${theme.bold(String(m.wpm))}   ${theme.gray('CPM')} ${theme.bold(String(m.cpm))}   ` +
      `${theme.gray('Accuracy')} ${accHue(`${m.accuracy}%`)}   ${theme.gray('Errors')} ${theme.bold(String(m.errors))}\n`,
  );
  output.write(
    `  ${theme.gray('Time')} ${theme.bold(humanDuration(m.elapsedMs))}   ${theme.gray('Typed')} ${theme.bold(`${m.correctChars}/${m.totalKeystrokes}`)}\n`,
  );

  output.write(
    `\n  ${verdict.passed ? theme.green('✔ Lesson criteria met') : theme.yellow('· Criteria not met yet')}\n`,
  );
  for (const line of wrap(verdict.message, Math.min(terminalWidth(), 80))) {
    output.write(`  ${theme.gray(line)}\n`);
  }

  if (attributedMistakes.length) {
    output.write(`\n  ${theme.bold('Where the mistakes were')}\n`);
    for (const mistake of attributedMistakes) {
      const finger = FINGER_INFO[mistake.finger];
      const movementText = mistake.movements.map((mv) => movementLabel(mv.movement)).join(', ');
      output.write(
        `   ${theme.red('•')} ${theme.bold(finger?.label ?? mistake.finger)} ${theme.gray(`×${mistake.count}`)}  ${theme.gray(movementText)}\n`,
      );
      const chars = mistake.chars.map((c) => `${c.char === ' ' ? '␣' : c.char}(×${c.count})`).join(' ');
      output.write(`     ${theme.gray(chars)}\n`);
    }
  }
  output.write('\n');
}
