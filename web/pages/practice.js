/**
 * Practice page — the interactive typing interface.
 *
 * The browser only renders: it forwards each keystroke to the server, which
 * scores it with the shared `TypingSession`. That keeps a single implementation
 * of the scoring maths and means the CLI and web can never disagree.
 *
 * The visible text is a `<span>` per character so each one can carry its own
 * state class; a hidden input keeps mobile keyboards and IME working.
 */

import { h, mount, clear } from '../dom.js';
import { client as api } from '../client.js';
import { navigate } from '../router.js';
import { pageHead, errorBox, toast } from './shared.js';
import { ComboTracker } from '../ui/effects.js';
import { getEffects } from '../app.js';
import { freePracticePage } from './free-practice.js';
import { decideLessonComplete, nextLessonId, remainingSeconds, PROMPT_DELAY_MS } from '../core/lesson-flow.js';

const KEYBOARD_ROWS = [
  ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
  ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p', '[', ']'],
  ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', ';', "'"],
  ['z', 'x', 'c', 'v', 'b', 'n', 'm', ',', '.', '/'],
  [' '],
];

/** Map a character to the finger id, mirroring core/keyboard.js. */
const FINGER_MAP = (() => {
  const map = { ' ': 'LTHUMB' };
  const rows = [
    [['1', 'LPINKY'], ['2', 'LRING'], ['3', 'LMIDDLE'], ['4', 'LINDEX'], ['5', 'LINDEX'], ['6', 'RINDEX'], ['7', 'RINDEX'], ['8', 'RMIDDLE'], ['9', 'RRING'], ['0', 'RPINKY']],
    [['q', 'LPINKY'], ['w', 'LRING'], ['e', 'LMIDDLE'], ['r', 'LINDEX'], ['t', 'LINDEX'], ['y', 'RINDEX'], ['u', 'RINDEX'], ['i', 'RMIDDLE'], ['o', 'RRING'], ['p', 'RPINKY'], ['[', 'RPINKY'], [']', 'RPINKY']],
    [['a', 'LPINKY'], ['s', 'LRING'], ['d', 'LMIDDLE'], ['f', 'LINDEX'], ['g', 'LINDEX'], ['h', 'RINDEX'], ['j', 'RINDEX'], ['k', 'RMIDDLE'], ['l', 'RRING'], [';', 'RPINKY'], ["'", 'RPINKY']],
    [['z', 'LPINKY'], ['x', 'LRING'], ['c', 'LMIDDLE'], ['v', 'LINDEX'], ['b', 'LINDEX'], ['n', 'RINDEX'], ['m', 'RINDEX'], [',', 'RMIDDLE'], ['.', 'RRING'], ['/', 'RPINKY']],
  ];
  for (const row of rows) for (const [ch, finger] of row) map[ch] = finger;
  return map;
})();

const FINGER_SHORT = {
  LPINKY: 'Left pinky',
  LRING: 'Left ring',
  LMIDDLE: 'Left middle',
  LINDEX: 'Left index',
  LTHUMB: 'Left thumb',
  RTHUMB: 'Right thumb',
  RINDEX: 'Right index',
  RMIDDLE: 'Right middle',
  RRING: 'Right ring',
  RPINKY: 'Right pinky',
};

/**
 * Render the practice screen for a lesson.
 */
export async function practicePage({ query }) {
  const lessonId = query.get('lesson');
  const mode = query.get('mode') === 'strict' ? 'strict' : 'flow';
  const exerciseIndex = query.get('ex') ? Number.parseInt(query.get('ex'), 10) : null;

  if (!lessonId) {
    return freePracticePage({ query });
  }

  const detail = api.lesson(lessonId);
  if (!detail) {
    return [
      pageHead('Practice', null),
      errorBox(`No lesson with the id "${lessonId}". Browse the library to pick one.`),
    ];
  }

  const { lesson } = detail;
  let payload;
  try {
    const exercise = exerciseIndex !== null ? lesson.exercises[exerciseIndex] : undefined;
    payload = await api.startSession({ lessonId, exerciseId: exercise?.id, mode });
    payload.lessonDetail = lesson;
  } catch (error) {
    return [pageHead('Practice', null), errorBox(error.message)];
  }

  return buildPracticeView(payload, { mode, lessonId, exerciseIndex });
}

function buildPracticeView(payload, ctx) {
  const mode = ctx.mode;
  const state = {
    payload,
    segments: payload.segments,
    stats: { wpm: 0, accuracy: 100, errors: 0, elapsedMs: 0, completion: 0 },
    position: 0,
    total: payload.text.length,
    finished: false,
    busy: false,
    startedAt: null,
    timer: null,
    prompt: null,
  };

  const lesson = payload.lesson;
  const progressLabel = h('span.pill', null, `Exercise ${payload.exerciseIndex}/${payload.exerciseCount}`);
  const levelPill = h('span.pill.progression', null, `Level ${lesson.level}`);
  const modePill = h('span.pill', null, mode === 'strict' ? 'Strict' : 'Flow');

  const head = pageHead(lesson.name, lesson.description, [levelPill, progressLabel, modePill]);

  /* ---------- text surface ---------- */

  const textEl = h('div.typing-text', { 'aria-label': 'Target text', 'aria-live': 'off' });
  const surface = h('div.typing-surface', { onClick: () => input.focus() }, textEl);

  const input = h('input.hidden-input', {
    type: 'text',
    autocomplete: 'off',
    autocorrect: 'off',
    autocapitalize: 'off',
    spellcheck: false,
    'aria-label': 'Type here',
  });

  function paintText() {
    clear(textEl);
    for (const segment of state.segments) {
      for (const ch of segment.text) {
        const cls = `ch ${segment.state}`;
        textEl.appendChild(h('span', { class: cls }, ch === ' ' ? '\u00a0' : ch));
      }
    }
  }

  /**
   * Repaint only the characters that changed.
   *
   * A full repaint on every keystroke would restart the caret's pulse animation
   * and drop the pop animation below, so we walk the segments and update just the
   * spans whose index is affected. `paintText` is still used for a fresh render.
   */
  function paintCharacters(indices) {
    const targets = new Set(indices.filter((i) => i >= 0));
    if (!targets.size) return;

    const spans = textEl.children;
    let index = 0;
    for (const segment of state.segments) {
      for (const ch of segment.text) {
        if (targets.has(index)) {
          const span = spans[index];
          if (span) {
            span.className = `ch ${segment.state}`;
            span.textContent = ch === ' ' ? '\u00a0' : ch;
            if (segment.state === 'correct') {
              // Re-trigger the pop on repeat hits at the same index.
              span.classList.remove('pop');
              void span.offsetWidth;
              span.classList.add('pop');
            }
          }
        }
        index += 1;
      }
    }
  }

  /* ---------- HUD ---------- */

  const hudValues = {
    wpm: h('div.hud-value', null, '0'),
    accuracy: h('div.hud-value', null, '100%'),
    errors: h('div.hud-value', null, '0'),
    progress: h('div.hud-value', null, `0/${state.total}`),
    time: h('div.hud-value', null, '0:00'),
  };

  const hud = h(
    'div.typing-hud',
    null,
    hudCell('WPM', hudValues.wpm),
    hudCell('Accuracy', hudValues.accuracy),
    hudCell('Errors', hudValues.errors),
    hudCell('Progress', hudValues.progress),
    hudCell('Time', hudValues.time),
  );

  function hudCell(label, valueEl) {
    return h('div.hud-cell', null, h('div.hud-label', null, label), valueEl);
  }

  /** Briefly scale a HUD figure so a change is felt, not just read. */
  function bump(el) {
    el.classList.remove('bump');
    void el.offsetWidth;
    el.classList.add('bump');
  }

  /* ---------- combo meter ---------- */

  const comboTracker = new ComboTracker({ tierSize: 10 });
  const comboFlames = h('span.combo-flames');
  const comboLabel = h('span.combo-label', null, 'Start typing to build a combo');
  const comboMeter = h('div.combo-meter', null, comboFlames, comboLabel);

  /**
   * Paint the combo meter.
   *
   * The visual escalates with the run length — more flames, then a hot colour —
   * because the escalating reward is what makes a streak feel worth protecting.
   */
  function paintCombo() {
    const count = comboTracker.count;
    if (count === 0) {
      comboFlames.textContent = '';
      comboFlames.classList.remove('hot');
      comboLabel.classList.remove('hot');
      comboLabel.textContent = comboTracker.best > 0 ? `Best combo this exercise: ${comboTracker.best}` : 'Start typing to build a combo';
      return;
    }

    const flames = '🔥'.repeat(Math.min(5, 1 + Math.floor(count / 8)));
    comboFlames.textContent = flames;
    const hot = count >= 20;
    comboFlames.classList.toggle('hot', hot);
    comboLabel.classList.toggle('hot', hot);
    comboLabel.textContent = `Combo ×${count}`;
    surface.style.setProperty('--combo-glow', String(Math.min(1, 0.4 + count / 60)));
  }

  /* ---------- finger hint ---------- */

  const hintEl = h('div.finger-hint');

  function paintHint() {
    clear(hintEl);
    if (state.finished) {
      hintEl.appendChild(h('span', { style: { color: 'var(--green)' } }, 'Exercise complete'));
      return;
    }
    const target = state.segments.find((s) => s.state === 'current');
    if (!target) return;
    const ch = target.text[0];
    const finger = FINGER_MAP[ch.toLowerCase()] ?? null;
    hintEl.appendChild(h('span', null, 'Next ', h('strong.mono', null, ch === ' ' ? 'space' : ch)));
    if (finger) {
      hintEl.appendChild(h('span', null, 'Finger ', h('strong', null, FINGER_SHORT[finger])));
      hintEl.appendChild(h('span.faint', null, ch === ch.toUpperCase() && ch !== ch.toLowerCase() ? 'Hold Shift with the opposite hand' : ''));
    }
  }

  /* ---------- keyboard ---------- */

  const keyEls = new Map();
  const keyboard = h(
    'div.keyboard',
    { 'aria-hidden': 'true' },
    KEYBOARD_ROWS.map((row) =>
      h(
        'div.kb-row',
        null,
        row.map((ch) => {
          const finger = FINGER_MAP[ch];
          const el = h(`div.key${ch === ' ' ? '.space' : ''}${finger ? `.finger-${finger.toLowerCase()}` : ''}`, null, ch === ' ' ? 'space' : ch);
          keyEls.set(ch, el);
          return el;
        }),
      ),
    ),
  );

  function paintKeyboard(pressed = null) {
    for (const el of keyEls.values()) el.classList.remove('active', 'pressed');
    const target = state.segments.find((s) => s.state === 'current');
    if (target) {
      const active = keyEls.get(target.text[0].toLowerCase());
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

  /* ---------- controls ---------- */

  const restartBtn = h(
    'button.ghost',
    { onClick: () => restart() },
    'Restart',
  );
  const skipBtn = h(
    'button.ghost',
    {
      onClick: () => {
        const nextEx = ctx.exerciseIndex === null ? 1 : ctx.exerciseIndex + 1;
        if (nextEx < lesson.exercises?.length || (payload.lessonDetail && nextEx < payload.lessonDetail.exercises.length)) {
          navigate(`/practice?lesson=${encodeURIComponent(ctx.lessonId)}&mode=${ctx.mode}&ex=${nextEx}`);
        } else {
          toast('No further exercises in this lesson.');
        }
      },
    },
    'Next exercise',
  );
  const backBtn = h('button.ghost', { onClick: () => navigate(`/lesson/${encodeURIComponent(ctx.lessonId)}`) }, 'Back to lesson');

  const controls = h('div.btn-row', null, restartBtn, skipBtn, backBtn);

  /* ---------- summary panel ---------- */

  const summaryHost = h('div');
  const overlayHost = h('div');

  function clearPrompt() {
    if (state.prompt?.timer) clearInterval(state.prompt.timer);
    if (state.prompt?.delay) clearTimeout(state.prompt.delay);
    state.prompt?.overlay?.remove();
    state.prompt = null;
    clear(overlayHost);
  }

  function redoLesson() {
    clearPrompt();
    navigate(`/practice?lesson=${encodeURIComponent(ctx.lessonId)}&mode=${ctx.mode}&ex=0`);
  }

  function goNext() {
    const nextExerciseId = state.nextExerciseId;
    clearPrompt();
    if (nextExerciseId) {
      const exercises = payload.lessonDetail?.exercises ?? [];
      const index = exercises.findIndex((exercise) => exercise.id === nextExerciseId);
      navigate(`/practice?lesson=${encodeURIComponent(ctx.lessonId)}&mode=${ctx.mode}&ex=${Math.max(0, index)}`);
      return;
    }
    const next = nextLessonId(api.lessons(), ctx.lessonId);
    if (next) navigate(`/practice?lesson=${encodeURIComponent(next)}&mode=${ctx.mode}&ex=0`);
    else navigate('/lessons');
  }

  function goNextLesson() {
    clearPrompt();
    const next = nextLessonId(api.lessons(), ctx.lessonId);
    if (next) navigate(`/practice?lesson=${encodeURIComponent(next)}&mode=${ctx.mode}&ex=0`);
    else navigate('/lessons');
  }

  function revealLessonCompletePrompt() {
    const startedAt = Date.now();
    const countEl = h('div.lesson-complete-count', null, String(remainingSeconds(0)));
    const overlay = h(
      'div.lesson-complete-overlay',
      { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Redo this lesson' },
      h(
        'div.lesson-complete-card',
        null,
        h('h2', null, 'Next in'),
        countEl,
        h('p', null, 'Tab to redo · Space for the next lesson'),
        h('p.faint', { style: { margin: '8px 0 0' } }, 'Waiting continues automatically'),
      ),
    );
    document.body.appendChild(overlay);
    const timer = setInterval(() => {
      const elapsed = Date.now() - startedAt;
      countEl.textContent = String(remainingSeconds(elapsed));
      if (decideLessonComplete({ elapsedMs: elapsed }) === 'next') goNext();
    }, 100);
    state.prompt = { ...(state.prompt ?? {}), startedAt, timer, overlay, visible: true, delay: null };
  }

  function scheduleLessonCompletePrompt(result) {
    clearPrompt();
    state.nextExerciseId = result.nextExercise ?? null;
    const delay = setTimeout(revealLessonCompletePrompt, PROMPT_DELAY_MS);
    state.prompt = { delay, timer: null, overlay: null, visible: false };
  }

  /* ---------- behaviour ---------- */

  function tickTimer() {
    if (!state.startedAt || state.finished) return;
    const elapsed = Date.now() - state.startedAt;
    hudValues.time.textContent = formatClock(elapsed);
  }

  function formatClock(ms) {
    const total = Math.round(ms / 1000);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  }

  function restart() {
    return (async () => {
      try {
        await api.cancel();
      } catch {
        /* no session is fine */
      }
      const fresh = await api.startSession({
        lessonId: ctx.lessonId,
        exerciseId: payload.exerciseId,
        mode: ctx.mode,
      });
      state.payload = fresh;
      state.segments = fresh.segments;
      state.position = 0;
      state.total = fresh.text.length;
      state.stats = { wpm: 0, accuracy: 100, errors: 0, elapsedMs: 0, completion: 0 };
      state.startedAt = null;
      state.finished = false;
      input.value = '';
      clear(summaryHost);
      paintText();
      paintHint();
      paintKeyboard();
      syncHud();
      input.focus();
      toast('Exercise restarted');
    })();
  }

  function syncHud() {
    hudValues.wpm.textContent = String(state.stats.wpm ?? 0);
    const acc = state.stats.accuracy ?? 100;
    hudValues.accuracy.textContent = `${acc}%`;
    hudValues.accuracy.style.color = acc >= 96 ? 'var(--green)' : acc >= 92 ? 'var(--gold)' : 'var(--red)';
    hudValues.errors.textContent = String(state.stats.errors ?? 0);
    hudValues.progress.textContent = `${state.position}/${state.total}`;
    if (state.startedAt) hudValues.time.textContent = formatClock(Date.now() - state.startedAt);
  }

  /** Send one keystroke and apply the result, with game feedback attached. */
  async function sendKey(key) {
    if (state.busy || state.finished) return;
    state.busy = true;
    try {
      const result = await api.press(key);
      if (state.startedAt === null) state.startedAt = Date.now();

      const previousPosition = state.position;
      state.segments = result.segments;
      state.stats = result.stats;
      state.position = result.progress.position;

      // The span under the caret is the one that just changed.
      const span = textEl.children[Math.min(previousPosition, textEl.children.length - 1)];
      const fx = getEffects();

      if (result.correct) {
        const { tierUp, count } = comboTracker.hit();
        paintCharacters([previousPosition, state.position]);
        fx?.correct(span, count);
        if (tierUp) {
          const message = tierUp >= 3 ? `Blazing! ×${count}` : tierUp === 2 ? `On fire! ×${count}` : `Combo ×${count}`;
          fx?.banner(message, tierUp >= 3 ? 'rose' : 'gold');
        }
      } else {
        const { lost } = comboTracker.miss();
        paintCharacters([previousPosition, state.position]);
        fx?.wrong(span);
        if (lost >= 10) fx?.pop(`Combo lost ×${lost}`, { tone: 'rose' });
      }

      paintHint();
      paintKeyboard(key);
      syncHud();
      paintCombo();

      if (result.finished) {
        state.finished = true;
        clearInterval(state.timer);
        await complete();
      }
    } catch (error) {
      toast(error.message);
    } finally {
      state.busy = false;
    }
  }

  input.addEventListener('keydown', (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (state.prompt?.visible && (event.key === 'Tab' || event.key === ' ')) {
      event.preventDefault();
      handleKey(event.key);
      return;
    }
    if (event.key === 'Tab' || event.key === 'Escape') return;
    // Prevent the browser from doing anything with printable keys except
    // delivering them to us; `beforeinput` below is the single source.
    if (event.key.length === 1) event.preventDefault();
    handleKey(event.key);
    if (event.key === 'Backspace') event.preventDefault();
  });

  /**
   * Document-level handler.
   *
   * The drill listens on the document rather than relying on the hidden input
   * having focus: a user who clicks anywhere on the page can still type, which
   * is how dedicated typing sites behave. The hidden input remains for mobile
   * keyboards, which need a real focus target.
   */
  function handleKey(key) {
    if (state.prompt) {
      if (!state.prompt.visible) return;
      const elapsed = Date.now() - state.prompt.startedAt;
      const action = decideLessonComplete({
        tabPressed: key === 'Tab',
        spacePressed: key === ' ',
        elapsedMs: elapsed,
      });
      if (action === 'restart') redoLesson();
      if (action === 'next-lesson') goNextLesson();
      return;
    }
    if (key === 'Backspace' || key === 'Delete') {
      handleBackspace();
      return;
    }
    if (key === 'Enter') {
      // Enter is only meaningful when a newline is the expected character.
      const target = state.segments.find((s) => s.state === 'current');
      if (target && target.text[0] === '\n') sendKey('\n');
      return;
    }
    if (key === 'Escape') {
      navigate(`/lesson/${encodeURIComponent(ctx.lessonId)}`);
      return;
    }
    if (typeof key === 'string' && key.length === 1) sendKey(key);
  }

  function handleBackspace() {
    // Backspace is intentionally inert: attempts are recorded as typed, and
    // rewriting history would let the numbers be gamed.
    toast('Backspace is disabled during practice — mistakes are part of the record.', 1600);
  }

  const onDocumentKeydown = (event) => {
    // Let real form fields (search boxes, settings) behave normally.
    const tag = event.target?.tagName;
    if (tag === 'INPUT' && event.target !== input) return;
    if (tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (state.prompt?.visible && (event.key === 'Tab' || event.key === ' ')) {
      event.preventDefault();
      handleKey(event.key);
      return;
    }
    if (event.key === 'Tab' || event.key === 'F5') return;
    if (event.key.length > 1 && !['Backspace', 'Delete', 'Enter', 'Escape'].includes(event.key)) return;
    event.preventDefault();
    handleKey(event.key);
  };

  document.addEventListener('keydown', onDocumentKeydown);

  // Detach when this page is replaced, otherwise a stale handler would keep
  // consuming keystrokes on every other page.
  const detach = () => {
    document.removeEventListener('keydown', onDocumentKeydown);
    clearInterval(state.timer);
    clearPrompt();
  };
  window.addEventListener('hashchange', detach, { once: true });
  window.addEventListener('beforeunload', detach, { once: true });

  // Mobile / IME path: `beforeinput` fires where keydown may not.
  input.addEventListener('beforeinput', (event) => {
    if (event.inputType === 'insertText' && event.data && event.data.length === 1) {
      event.preventDefault();
      sendKey(event.data);
    }
  });

  // Block paste: the drill must be typed.
  input.addEventListener('paste', (event) => {
    event.preventDefault();
    toast('Typing practice is keyboard only — paste is disabled.');
  });

  /* ---------- completion ---------- */

  async function complete() {
    try {
      const result = await api.finish();
      // Persist immediately: a refresh on the summary screen must not lose the
      // attempt that just produced it.
      await api.flush?.();

      const metrics = result.record.metrics;
      const fx = getEffects();

      if (result.verdict.passed) {
        // A pass earns the full celebration plus a score pop.
        fx?.celebrate();
        fx?.banner('Cleared!', 'gold');
        fx?.pop(`+${metrics.wpm} WPM`, { tone: 'gold' });
      } else {
        fx?.pop(`${metrics.accuracy}% accuracy`, { tone: 'cyan' });
      }

      const summary = buildSummary(result, ctx, lesson);
      summary.classList.add('summary-enter');
      mount(summaryHost, summary);

      scheduleLessonCompletePrompt(result);

      // Let the sidebar and any listener know progress moved.
      window.dispatchEvent(new CustomEvent('typebreak:progress-changed'));
    } catch (error) {
      mount(summaryHost, errorBox(error.message));
    }
  }

  paintText();
  paintHint();
  paintKeyboard();
  syncHud();
  paintCombo();
  state.timer = setInterval(tickTimer, 250);

  // Focus the hidden input so the page is immediately typeable.
  queueMicrotask(() => input.focus());

  const focusNote = h(
    'p.faint',
    { style: { fontSize: '11.5px', marginTop: '12px' } },
    'Click the text area and start typing. Keep a clean streak to build a combo — mistakes break it.',
  );

  return h(
    'div',
    null,
    head,
    surface,
    input,
    comboMeter,
    keyboard,
    hud,
    h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap', marginBottom: '8px', alignItems: 'center' } }, hintEl, controls),
    focusNote,
    summaryHost,
    overlayHost,
  );
}

/** Post-exercise summary with finger-attributed mistakes. */
function buildSummary(result, ctx, lesson) {
  const m = result.record.metrics;
  const verdict = result.verdict;
  const lessonDetail = ctx.lessonDetail;

  const cells = [
    ['WPM', String(m.wpm)],
    ['CPM', String(m.cpm)],
    ['Accuracy', `${m.accuracy}%`],
    ['Errors', String(m.errors)],
    ['Time', formatMs(m.elapsedMs)],
    ['Completion', `${m.completion}%`],
  ];

  const summaryGrid = h(
    'div.summary-grid',
    null,
    cells.map(([label, value]) => h('div.summary-cell', null, h('div.hud-label', null, label), h('div.hud-value', null, value))),
  );

  const verdictBox = h(
    `div.verdict.${verdict.passed ? 'pass' : 'fail'}`,
    null,
    verdict.passed ? 'Lesson criteria met' : 'Criteria not met yet',
    h('p', null, verdict.message),
    typeof verdict.allowedErrors === 'number'
      ? h(
          'p',
          { style: { fontSize: '11.5px', opacity: 0.85, marginTop: '4px' } },
          `Target: ${verdict.required.accuracy}% accuracy${verdict.required.speedIsAdvisory ? '' : ` and ${verdict.required.wpm} WPM`} · this exercise allowed ${verdict.allowedErrors} mistake${verdict.allowedErrors === 1 ? '' : 's'}`,
        )
      : null,
  );

  const mistakes = result.attributedMistakes ?? [];
  const mistakeList = mistakes.length
    ? h(
        'ul.list',
        null,
        mistakes.map((mistake) =>
          h(
            'li',
            null,
            h('strong', null, mistake.label),
            h('span.faint', null, ` ×${mistake.count} `),
            h(
              'div.task-desc',
              null,
              mistake.movements.map((mv) => mv.label).join(', '),
            ),
            h(
              'div.task-desc.mono',
              null,
              mistake.chars.map((c) => `${c.char === ' ' ? '␣' : c.char}×${c.count}`).join('  '),
            ),
          ),
        ),
      )
    : h('p.muted', null, 'No mistakes in this exercise.');

  const actions = h(
    'div.btn-row',
    { style: { marginTop: '16px' } },
    result.nextExercise
      ? h(
          'button.primary',
          {
            onClick: () => {
              const index = lessonDetail?.exercises?.findIndex((e) => e.id === result.nextExercise);
              navigate(`/practice?lesson=${encodeURIComponent(ctx.lessonId)}&mode=${ctx.mode}&ex=${index ?? 0}`);
            },
          },
          'Next exercise',
        )
      : null,
    h('button', { onClick: () => navigate(`/lesson/${encodeURIComponent(ctx.lessonId)}`) }, 'Back to lesson'),
    h('button.ghost', { onClick: () => navigate('/') }, 'Dashboard'),
  );

  return h(
    'div.section',
    { style: { marginTop: '28px' } },
    h('h2', null, 'Exercise summary'),
    summaryGrid,
    verdictBox,
    h('h3', null, mistakes.length ? 'Where the mistakes were' : 'Accuracy'),
    mistakeList,
    actions,
  );
}

function formatMs(ms) {
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, '0')}s`;
}
