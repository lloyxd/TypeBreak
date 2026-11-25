/**
 * Settings — practice preferences, backup and restore, local data control.
 *
 * The backup section is the whole point of a local-first app: the user's data
 * exists only in this browser, so export has to be obvious and import has to be
 * careful (validate, preview, then choose merge or replace).
 */

import { h, card, section, pill, clear, mount } from '../dom.js';
import { client } from '../client.js';
import { pageHead, toast, confirmDialog } from './shared.js';
import { navigate } from '../router.js';
import { storageBanner } from '../ui/storage.js';

export async function settingsPage() {
  const settings = client.settings();
  const usage = await client.storageUsage();
  const info = client.backupInfo();
  const storage = client.storage();

  const save = (patch, message) => {
    client.updateSettings(patch);
    toast(message);
  };

  /* ---------- practice ---------- */

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

  const practiceCard = card(
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
  );

  /* ---------- backup ---------- */

  const exportButton = h(
    'button.primary',
    {
      onClick: () => {
        const backup = client.createBackup();
        downloadText(backup.filename, backup.text);
        toast(`Exported ${backup.summary.attempts} attempts to ${backup.filename}`, 3200);
      },
    },
    'Export progress',
  );

  const exportCard = card(
    h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '12px', flexWrap: 'wrap' } },
      h('h3', { style: { margin: 0 } }, 'Export'),
      h('span.faint', { style: { fontSize: '11.5px' } }, `format ${info.exportVersion} · schema ${info.schemaVersion}`),
    ),
    h('p.prose', { style: { margin: '8px 0 12px' } },
      'Download everything as a single JSON file: every exercise attempt, lesson progress, weaknesses and daily plans. Keep it as a backup, or import it on another device to continue exactly where you left off.'),
    h('div', { style: { display: 'flex', gap: '20px', flexWrap: 'wrap', marginBottom: '12px', fontSize: '12.5px' } },
      fact('Attempts', String(info.summary.attempts)),
      fact('Lessons practised', String(info.summary.lessons)),
      fact('Practice time', formatDuration(info.summary.practiceMs)),
      fact('Last attempt', info.summary.lastAttemptAt ? shortDate(info.summary.lastAttemptAt) : '—'),
    ),
    exportButton,
    info.summary.attempts === 0
      ? h('p.faint', { style: { fontSize: '11.5px', margin: '10px 0 0' } },
          'You have no recorded attempts yet, so the export will contain an empty history.')
      : null,
  );

  /* ---------- import ---------- */

  const importHost = h('div');
  const fileInput = h('input', {
    type: 'file',
    accept: 'application/json,.json',
    style: { display: 'none' },
    onChange: async (event) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;
      await handleFile(file, importHost);
    },
  });

  const importButton = h(
    'button',
    { onClick: () => fileInput.click() },
    'Choose a file…',
  );

  const importCard = card(
    h('h3', null, 'Import'),
    h('p.prose', { style: { margin: '0 0 12px' } },
      'Restore a progress file. The file is checked and summarised first — nothing is written until you choose how to apply it.'),
    importButton,
    fileInput,
    importHost,
  );

  /* ---------- data ---------- */

  const resetBtn = h(
    'button.danger',
    {
      onClick: async () => {
        if (!confirmDialog('Delete all progress from this browser? This removes every attempt, streak and plan. Export a backup first if you might want it back.')) return;
        await api_reset();
      },
    },
    'Delete all progress',
  );

  async function api_reset() {
    try {
      await client.reset();
      toast('Progress deleted');
      navigate('/');
    } catch (error) {
      toast(error.message);
    }
  }

  const usageLabel = usage
    ? `${formatBytes(usage.usage)} used${usage.quota ? ` of ~${formatBytes(usage.quota)} available` : ''}`
    : 'Storage usage unavailable in this browser';

  const dataCard = card(
    h('h3', null, 'Where your progress lives'),
    h('p.prose', { style: { margin: '0 0 10px' } },
      'All progress is stored in this browser, in IndexedDB. Nothing is sent to a server — there is no server. That also means clearing your browser data, or using a different browser or device, starts from scratch unless you import a backup.'),
    h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '12px' } },
      pill('This browser only'),
      pill('No account'),
      pill('No network'),
    ),
    h('div', { style: { fontSize: '12.5px', color: 'var(--text-dim)', marginBottom: '12px' } }, usageLabel),
    h('div', { style: { height: '4px' } }),
    h('h3', null, 'Reset'),
    h('p.prose', { style: { margin: '0 0 10px' } },
      'Permanently deletes every recorded attempt from this browser and starts a fresh profile.'),
    resetBtn,
  );

  return [
    pageHead('Settings', 'Preferences, backup and local data.'),
    storage.available ? null : storageBanner(storage.error),
    section('Practice', practiceCard),
    section('Backup and restore', h('div.grid.grid-2', null, exportCard, importCard)),
    section('Local data', dataCard),
  ].filter(Boolean);
}

/* ------------------------------------------------------------------ *
 * Import flow
 * ------------------------------------------------------------------ */

async function handleFile(file, host) {
  if (file.size > 32 * 1024 * 1024) {
    mount(host, errorPanel(['That file is far larger than a progress backup should be. Check you picked the right file.']));
    return;
  }

  let text;
  try {
    text = await file.text();
  } catch {
    mount(host, errorPanel(['The file could not be read.']));
    return;
  }

  let inspection;
  try {
    inspection = client.inspectImport(text);
  } catch (error) {
    mount(host, errorPanel([error.message]));
    return;
  }

  if (!inspection.ok) {
    mount(host, errorPanel(inspection.errors, inspection.warnings));
    return;
  }

  mount(host, importPreview(inspection, file.name, text, host));
}

function importPreview(inspection, filename, text, host) {
  const { preview, warnings } = inspection;
  const incoming = preview.incoming;

  const details = h(
    'div',
    { style: { fontSize: '12.5px' } },
    h('div', { style: { marginBottom: '8px' } },
      h('strong', null, filename),
      h('span.faint', null, ` · ${incoming.attempts} attempts · ${incoming.lessons} lessons`)),
    h('div', { style: { color: 'var(--text-dim)', marginBottom: '10px' } },
      `${formatDuration(incoming.practiceMs)} of practice`,
      incoming.firstAttemptAt ? ` · ${shortDate(incoming.firstAttemptAt)} → ${shortDate(incoming.lastAttemptAt)}` : ''),
    h('div', { style: { display: 'flex', gap: '16px', flexWrap: 'wrap', marginBottom: '12px' } },
      fact('New attempts', String(preview.newAttempts)),
      fact('Already present', String(preview.duplicateAttempts)),
      fact('Your attempts now', String(preview.current.attempts)),
    ),
  );

  const warningPanel = warnings.length
    ? h('div.verdict.fail', { style: { marginBottom: '12px' } },
        'Some records will be skipped',
        h('ul', { style: { margin: '6px 0 0', paddingLeft: '18px' } },
          warnings.map((w) => h('li', { style: { fontSize: '12px' } }, w))))
    : null;

  const mergeButton = h(
    'button.primary',
    {
      onClick: async (event) => {
        await applyImport({ text, mode: 'merge', host, button: event.currentTarget, label: 'Merge' });
      },
    },
    preview.newAttempts > 0 ? `Merge ${preview.newAttempts} new attempt${preview.newAttempts === 1 ? '' : 's'}` : 'Merge (nothing new)',
  );

  const replaceButton = h(
    'button',
    {
      onClick: async () => {
        const loss = preview.wouldLoseAttempts;
        const message = loss > 0
          ? `Replace your current progress with this file? ${loss} attempt${loss === 1 ? '' : 's'} in your browser are not in this file and will be permanently lost.`
          : 'Replace your current progress with this file? Your current attempts are all present in the file, so nothing will be lost.';
        if (!confirmDialog(message)) return;
        await applyImport({ text, mode: 'replace', host, button: replaceButton, label: 'Replace' });
      },
    },
    'Replace instead…',
  );

  const cancel = h('button.ghost', { onClick: () => clear(host) }, 'Cancel');

  return h(
    'div.card',
    { style: { marginTop: '12px' } },
    h('h3', null, 'Preview'),
    details,
    warningPanel,
    preview.wouldLoseAttempts > 0
      ? h('p', { style: { fontSize: '11.5px', color: 'var(--yellow)', marginBottom: '10px' } },
          `Merging is safe and adds nothing you already have. Replacing would discard ${preview.wouldLoseAttempts} attempt${preview.wouldLoseAttempts === 1 ? '' : 's'} that exist only in this browser.`)
      : null,
    h('div.btn-row', null, mergeButton, replaceButton, cancel),
  );
}

async function applyImport({ text, mode, host, button, label }) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = `${label}…`;

  try {
    const result = await client.applyImport({ text, mode });

    const parts = [];
    if (mode === 'replace') parts.push(`Replaced with ${result.totalAttempts} attempts`);
    else {
      parts.push(`Added ${result.added} attempt${result.added === 1 ? '' : 's'}`);
      if (result.duplicates) parts.push(`${result.duplicates} already present`);
    }

    mount(
      host,
      h('div.verdict.pass', { role: 'status' },
        `Import complete — ${parts.join(', ')}.`,
        h('p', null, `Your progress now holds ${result.totalAttempts} attempt${result.totalAttempts === 1 ? '' : 's'}. Recommendations and today's plan use this history immediately.`),
        result.warnings.length
          ? h('ul', { style: { margin: '8px 0 0', paddingLeft: '18px', color: 'var(--text-dim)' } },
              result.warnings.map((w) => h('li', { style: { fontSize: '12px' } }, w)))
          : null,
      ),
    );
    toast(`Import complete · ${result.totalAttempts} attempts total`, 3000);
    // Other screens (dashboard, adaptive) now hold stale numbers.
    window.dispatchEvent(new CustomEvent('typebreak:progress-changed'));
  } catch (error) {
    mount(host, errorPanel(error.details ?? [error.message]));
    button.disabled = false;
    button.textContent = original;
  }
}

function errorPanel(errors, warnings = []) {
  return h(
    'div.error-box',
    { role: 'alert', style: { marginTop: '12px' } },
    h('strong', null, 'This file could not be imported.'),
    h('ul', { style: { margin: '6px 0 0', paddingLeft: '18px' } },
      errors.map((e) => h('li', { style: { fontSize: '12px' } }, e))),
    warnings.length
      ? h('ul', { style: { margin: '6px 0 0', paddingLeft: '18px', opacity: 0.8 } },
          warnings.map((w) => h('li', { style: { fontSize: '12px' } }, w)))
      : null,
  );
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function fact(label, value) {
  return h('div', null,
    h('div', { style: { fontSize: '10.5px', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-faint)' } }, label),
    h('div', { style: { fontWeight: '600', fontVariantNumeric: 'tabular-nums' } }, value),
  );
}

/** Save text as a file the user chooses where to put. */
function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoke on the next tick so the download has definitely started.
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function formatDuration(ms) {
  const total = Math.round((ms ?? 0) / 1000);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function shortDate(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
