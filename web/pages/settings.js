/**
 * Settings page — typing mode, daily goals, data management.
 */

import { h, card, section, pill } from '../dom.js';
import { api } from '../api.js';
import { pageHead, toast, confirmDialog } from './shared.js';
import { navigate } from '../router.js';

export async function settingsPage() {
  const data = await api.bootstrap();
  const settings = data.settings ?? {};

  const save = async (patch, message) => {
    try {
      await api.updateSettings(patch);
      toast(message);
    } catch (error) {
      toast(error.message);
    }
  };

  const modeToggle = h(
    'div.btn-row',
    null,
    ['flow', 'strict'].map((mode) =>
      h(
        `button${settings.mode === mode ? '.primary' : ''}`,
        {
          onClick: (event) => {
            for (const btn of event.currentTarget.parentElement.children) btn.className = '';
            event.currentTarget.className = 'primary';
            save({ mode }, `Typing mode set to ${mode}`);
          },
        },
        mode === 'flow' ? 'Flow' : 'Strict',
      ),
    ),
  );

  const goalInput = h('input', {
    type: 'text',
    value: String(settings.dailyGoalExercises ?? 6),
    style: { width: '70px' },
    'aria-label': 'Daily exercise goal',
    onChange: (event) => {
      const value = Number.parseInt(event.target.value, 10);
      if (Number.isInteger(value) && value > 0 && value <= 50) {
        save({ dailyGoalExercises: value }, `Daily goal set to ${value} exercises`);
      } else {
        event.target.value = String(settings.dailyGoalExercises ?? 6);
        toast('Enter a number between 1 and 50');
      }
    },
  });

  const resetBtn = h(
    'button',
    {
      onClick: async () => {
        if (!confirmDialog('Delete all progress? This removes every attempt, streak and plan. It cannot be undone.')) return;
        try {
          await api.reset();
          toast('Progress deleted');
          navigate('/');
        } catch (error) {
          toast(error.message);
        }
      },
    },
    'Delete all progress',
  );

  return [
    pageHead('Settings', 'Preferences and local data.'),

    section(
      'Practice',
      card(
        h('h3', null, 'Typing mode'),
        h('p.prose', { style: { margin: '0 0 10px' } },
          'Flow records every mistake and lets you keep typing — best for measuring speed. Strict makes you fix each mistake before moving on — best for learning a new movement cleanly.'),
        modeToggle,
        h('div', { style: { height: '18px' } }),
        h('h3', null, 'Daily exercise goal'),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
          goalInput,
          h('span.faint', { style: { fontSize: '12px' } }, 'exercises per day'),
        ),
      ),
    ),

    section(
      'Data',
      card(
        h('h3', null, 'Where progress lives'),
        h('p.prose', { style: { margin: '0 0 10px' } },
          'All progress is stored in a single JSON file in this project’s data/ directory. The terminal app and this web app read and write the same file, so practising in one is immediately visible in the other.'),
        h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
          pill('data/state.json'),
          pill('shared by CLI and web'),
        ),
        h('div', { style: { height: '18px' } }),
        h('h3', null, 'Reset'),
        h('p.prose', { style: { margin: '0 0 10px' } }, 'Permanently deletes every recorded attempt and starts a fresh profile.'),
        resetBtn,
      ),
    ),

    section(
      'About',
      card(
        h('h3', null, 'TypeBreak'),
        h('p.prose', { style: { margin: 0 } },
          `${data.overview.counts.lessons} predefined lessons, ${data.overview.counts.exercises} exercises, covering all ten fingers and ${data.overview.coveredMovements.length} movement variations. Lessons are fixed; the BTS planner only selects, orders and combines them based on your measured performance.`),
      ),
    ),
  ];
}
