/**
 * Free Practice — a Monkeytype-style timed drill.
 *
 * Opens from the Practice tab with no lesson selected. Words come from the
 * frozen bank in core/words.js. Scoring still goes through AppService so WPM
 * and accuracy match lesson practice; the attempt is ephemeral and is not
 * stored in progress.
 */

import { h, clear } from '../dom.js';
import { client as api } from '../client.js';
import { navigate } from '../router.js';
import { toast } from './shared.js';
import { generatePracticeText, parsePracticeSeconds, PRACTICE_DURATIONS } from '../core/words.js';

export async function freePracticePage({ query }) {
  const seconds = parsePracticeSeconds(query.get('time'));
  const text = generatePracticeText({ wordCount: 90 });
  let payload;
  try {
    payload = await api.startFreeSession({ text, mode: 'flow' });
  } catch (error) {
    return h('p.error-box', { role: 'alert' }, error.message);
  }
  return buildFreePracticeView(payload, { seconds });
}

function buildFreePracticeView(payload, { seconds }) {
  const state = {
    payload,
    segments: payload.segments,
    stats: { wpm: 0, accuracy: 100, errors: 0, elapsedMs: 0 },
    finished: false,
    busy: false,
    startedAt: null,
    remainingMs: seconds * 1000,
    timer: null,
    position: 0,
  };

  const textEl = h('div.typing-text.arena-text', { 'aria-label': 'Target text', 'aria-live': 'off' });
  const surface = h('div.typing-surface.arena-surface', { onClick: () => input.focus() }, textEl);
  const liveWpm = h('div.arena-live', null, '');
  const resultHost = h('div.arena-result');

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
        textEl.appendChild(h('span', { class: `ch ${segment.state}` }, ch === ' ' ? '\u00a0' : ch));
      }
    }
  }

  function paintCharacters(indices) {
    const targets = new Set((indices ?? []).filter((i) => i >= 0));
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
          }
        }
        index += 1;
      }
    }
  }

  const durationBar = h(
    'div.arena-modes',
    { role: 'tablist', 'aria-label': 'Practice duration' },
    h('span.arena-mode-label', null, 'time'),
    PRACTICE_DURATIONS.map((value) =>
      h(
        `button.arena-chip${value === seconds ? '.is-active' : ''}`,
        {
          type: 'button',
          onClick: () => navigate(`/practice?time=${value}`),
        },
        String(value),
      ),
    ),
  );

  function formatRemaining(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    return String(total);
  }

  liveWpm.textContent = formatRemaining(state.remainingMs);

  function tickTimer() {
    if (!state.startedAt || state.finished) return;
    const elapsed = Date.now() - state.startedAt;
    state.remainingMs = Math.max(0, seconds * 1000 - elapsed);
    liveWpm.textContent = state.startedAt
      ? `${state.stats.wpm}  ·  ${formatRemaining(state.remainingMs)}`
      : formatRemaining(state.remainingMs);
    if (state.remainingMs <= 0) finishRun();
  }

  async function sendKey(key) {
    if (state.finished || state.busy) return;
    if (typeof key !== 'string' || key.length !== 1) return;
    state.busy = true;
    try {
      const before = state.position;
      const result = await api.press(key);
      if (!state.startedAt) state.startedAt = Date.now();
      state.segments = result.segments;
      state.stats = result.stats;
      state.position = result.progress?.position ?? before;
      paintCharacters([before, state.position]);
      if (result.finished) await finishRun();
    } catch (error) {
      toast(error.message);
    } finally {
      state.busy = false;
    }
  }

  async function finishRun() {
    if (state.finished) return;
    state.finished = true;
    clearInterval(state.timer);
    try {
      const result = await api.finish();
      const m = result.record.metrics;
      clear(resultHost);
      resultHost.appendChild(
        h(
          'div.arena-score',
          null,
          h('div.arena-score-num', null, String(m.wpm)),
          h('div.arena-score-label', null, 'wpm'),
          h('div.arena-score-num', null, `${m.accuracy}%`),
          h('div.arena-score-label', null, 'acc'),
          h('p.arena-hint', null, 'tab to restart'),
        ),
      );
    } catch (error) {
      toast(error.message);
    }
  }

  function restart() {
    navigate(`/practice?time=${seconds}`);
  }

  const onDocumentKeydown = (event) => {
    const tag = event.target?.tagName;
    if (tag === 'INPUT' && event.target !== input) return;
    if (tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === 'Tab') {
      event.preventDefault();
      restart();
      return;
    }
    if (state.finished) return;
    if (event.key === 'Backspace' || event.key === 'Delete') {
      event.preventDefault();
      toast('Backspace is disabled during practice — mistakes are part of the record.', 1600);
      return;
    }
    if (event.key.length === 1) {
      event.preventDefault();
      sendKey(event.key);
    }
  };

  document.addEventListener('keydown', onDocumentKeydown);
  const detach = () => {
    document.removeEventListener('keydown', onDocumentKeydown);
    clearInterval(state.timer);
  };
  window.addEventListener('hashchange', detach, { once: true });
  window.addEventListener('beforeunload', detach, { once: true });

  input.addEventListener('beforeinput', (event) => {
    if (event.inputType === 'insertText' && event.data && event.data.length === 1) {
      event.preventDefault();
      sendKey(event.data);
    }
  });
  input.addEventListener('paste', (event) => {
    event.preventDefault();
    toast('Typing practice is keyboard only — paste is disabled.');
  });

  paintText();
  state.timer = setInterval(tickTimer, 200);
  queueMicrotask(() => input.focus());

  return h(
    'div.arena',
    null,
    durationBar,
    liveWpm,
    surface,
    input,
    resultHost,
    h('p.arena-footer', null, 'tab · restart'),
  );
}
