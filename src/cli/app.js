/**
 * TypeBreak terminal application.
 *
 * A readline-driven menu over the shared `AppService`. The CLI holds no
 * learning logic of its own: it asks the service for a plan, renders it, and
 * hands keystrokes to the shared typing session.
 *
 *   npm start           interactive menu
 *   npm start -- --help list non-interactive commands
 */

import readline from 'node:readline';
import { AppService } from '../core/service.js';
import { SESSION_MODES } from '../core/engine.js';
import { FINGER_INFO, MOVEMENTS, fingerLabel, movementLabel } from '../core/keyboard.js';
import {
  createTheme,
  banner,
  hint,
  rule,
  table,
  progressBar,
  terminalWidth,
  wrap,
  humanDuration,
  accuracyColor,
  trendBadge,
  clearScreen,
  padEnd,
  padStart,
} from './ui.js';
import { runLesson } from './drill.js';

const theme = createTheme();

export class Cli {
  constructor({ service } = {}) {
    this.service = service ?? new AppService();
    this.rl = null;
  }

  /* ---------------- input ---------------- */

  open() {
    this.rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return this;
  }

  close() {
    this.rl?.close();
    this.rl = null;
  }

  ask(question, { defaultValue = '' } = {}) {
    return new Promise((resolve) => {
      const suffix = defaultValue ? theme.gray(` (${defaultValue})`) : '';
      this.rl.question(`${theme.cyan('?')} ${question}${suffix} `, (answer) => {
        resolve((answer ?? '').trim() || defaultValue);
      });
    });
  }

  async confirm(question, defaultValue = true) {
    const marker = defaultValue ? 'Y/n' : 'y/N';
    const answer = await this.ask(`${question} ${theme.gray(`[${marker}]`)}`, { defaultValue: '' });
    if (!answer) return defaultValue;
    return /^y(es)?$/i.test(answer);
  }

  async choose(prompt, options) {
    options.forEach((opt, i) => {
      process.stdout.write(`  ${theme.bold(theme.cyan(String(i + 1)))}. ${opt}\n`);
    });
    const raw = await this.ask(prompt);
    const index = Number.parseInt(raw, 10) - 1;
    if (Number.isInteger(index) && options[index] !== undefined) return raw;
    return raw;
  }

  async pause(message = 'Press Enter to continue') {
    await this.ask(theme.gray(message), { defaultValue: '' });
  }

  /* ---------------- rendering primitives ---------------- */

  header(title, subtitle = '') {
    const width = Math.min(terminalWidth(), 100);
    process.stdout.write('\n');
    process.stdout.write(`${theme.bold(theme.cyan(title))}${subtitle ? `  ${theme.gray(subtitle)}` : ''}\n`);
    process.stdout.write(`${rule(theme, width)}\n`);
  }

  section(title) {
    process.stdout.write(`\n${theme.bold(title)}\n`);
  }

  line(text = '') {
    process.stdout.write(`${text}\n`);
  }

  /* ---------------- screens ---------------- */

  async home() {
    clearScreen();
    this.line(banner(theme));
    const stats = this.service.stats();
    const assessment = this.service.assessment();

    this.line('');
    this.line(
      `  ${theme.gray('Streak')} ${theme.bold(`${stats.streak.current}d`)}  ${theme.gray('·')}  ` +
        `${theme.gray('Accuracy')} ${accuracyColor(theme, stats.accuracy)(`${stats.accuracy}%`)}  ${theme.gray('·')}  ` +
        `${theme.gray('WPM')} ${theme.bold(String(stats.wpm))}  ${theme.gray('·')}  ` +
        `${theme.gray('Lessons')} ${theme.bold(`${stats.lessonsPassed}/${stats.lessonsTotal}`)}`,
    );
    this.line(
      `  ${theme.gray('Overall')} ${progressBar(stats.overallPercent, { width: 24, theme })} ${theme.bold(`${stats.overallPercent}%`)}`,
    );

    this.section('Today');
    for (const item of assessment.plan.items) {
      const lesson = this.service.lesson(item.lessonId);
      const kindHue = item.kind === 'weakness' ? theme.red : item.kind === 'progression' ? theme.blue : theme.gray;
      const progress = this.service.getState().__progress?.lessonProgress?.[item.lessonId];
      void progress;
      this.line(
        `  ${theme.bold(String(item.order))}. ${padEnd(lesson.name, 40)} ${kindHue(`[${item.kind}]`)} ${theme.gray(`L${item.level}`)}`,
      );
    }

    const tasks = this.service.todaysTasks();
    this.line('');
    this.line(
      `  ${theme.gray('Tasks')} ${theme.bold(`${tasks.completed}/${tasks.total}`)}  ${progressBar(
        (tasks.completed / Math.max(1, tasks.total)) * 100,
        { width: 20, theme },
      )}`,
    );

    this.section('Menu');
    this.line(
      [
        hint(theme, '1', 'Start today’s plan'),
        hint(theme, '2', 'Browse lessons'),
        hint(theme, '3', 'Daily tasks'),
        hint(theme, '4', 'Performance'),
        hint(theme, '5', 'Finger progress'),
        hint(theme, '6', 'History'),
        hint(theme, '7', 'Weaknesses'),
        hint(theme, '8', 'Adaptive learning'),
        hint(theme, 's', 'Settings'),
        hint(theme, 'q', 'Quit'),
      ].join('   '),
    );
    this.line('');
  }

  async mainLoop() {
    this.open();
    let running = true;
    while (running) {
      await this.home();
      const choice = (await this.ask('Choice')).toLowerCase();
      try {
        switch (choice) {
          case '1':
            await this.startPlan();
            break;
          case '2':
            await this.browseLessons();
            break;
          case '3':
            await this.dailyTasks();
            break;
          case '4':
            await this.performance();
            break;
          case '5':
            await this.fingerProgress();
            break;
          case '6':
            await this.history();
            break;
          case '7':
            await this.weaknesses();
            break;
          case '8':
            await this.adaptive();
            break;
          case 's':
            await this.settings();
            break;
          case 'q':
          case 'quit':
          case 'exit':
            running = false;
            break;
          case '':
            break;
          default:
            await this.pause(theme.red(`Unknown option "${choice}". Press Enter.`));
        }
      } catch (error) {
        this.line(theme.red(`\n  Error: ${error.message}`));
        await this.pause();
      }
    }
    this.close();
    this.line(theme.gray('  Keep your fingers on home row. See you tomorrow.'));
  }

  /* ---------------- actions ---------------- */

  async startPlan({ force = false } = {}) {
    const assessment = this.service.assessment({ forcePlan: force });
    clearScreen();
    this.header("Today's plan", assessment.date);
    this.line('');
    for (const line of wrap(assessment.plan.explanation, Math.min(terminalWidth(), 92))) {
      this.line(`  ${theme.gray(line)}`);
    }
    this.line('');

    assessment.plan.items.forEach((item, i) => {
      const lesson = this.service.lesson(item.lessonId);
      const kindHue = item.kind === 'weakness' ? theme.red : item.kind === 'progression' ? theme.blue : theme.gray;
      this.line(`  ${theme.bold(theme.cyan(String(i + 1)))}. ${theme.bold(lesson.name)} ${theme.gray(`· L${lesson.level}`)} ${kindHue(`[${item.kind}]`)}`);
      this.line(`     ${theme.gray(item.reasons[0])}`);
    });

    this.line('');
    this.line(`  ${theme.gray('Enter a lesson number, "a" for all in order, or Enter to go back.')}`);
    const answer = (await this.ask('Lesson')).toLowerCase();
    if (!answer) return;

    if (answer === 'a') {
      for (const item of assessment.plan.items) {
        const lesson = this.service.lesson(item.lessonId);
        await this.practiseLesson(lesson);
      }
      return;
    }

    const index = Number.parseInt(answer, 10) - 1;
    const item = assessment.plan.items[index];
    if (!item) {
      this.line(theme.red('  No such lesson in today’s plan.'));
      await this.pause();
      return;
    }
    await this.practiseLesson(this.service.lesson(item.lessonId));
  }

  async browseLessons() {
    clearScreen();
    this.header('Lesson library', `${this.service.libraryOverview().size} lessons`);
    this.line('');
    this.line(
      `  ${theme.gray('Filter by:')} ${hint(theme, 'f', 'finger')} ${hint(theme, 'm', 'movement')} ${hint(theme, 'c', 'category')} ${hint(theme, 'l', 'level')} ${hint(theme, 'a', 'all')}`,
    );
    this.line('');

    const filters = {};
    let filtering = true;
    while (filtering) {
      const lessons = this.service.lessons(filters);
      const rows = lessons.slice(0, 40).map((lesson, i) => [
        String(i + 1),
        `L${lesson.level}`,
        lesson.name,
        theme.gray(lesson.fingers.map((f) => FINGER_INFO[f].short).join(',')),
        theme.gray(lesson.movements.map((m) => movementLabel(m)).join(', ').slice(0, 34)),
      ]);

      clearScreen();
      const active = Object.entries(filters)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ');
      this.header('Lesson library', `${lessons.length} shown${active ? ` · ${active}` : ''}`);
      this.line('');
      this.line(table(rows, { headers: ['#', 'Lvl', 'Lesson', 'Fingers', 'Movements'], theme }));
      if (lessons.length > 40) this.line(theme.gray(`  …and ${lessons.length - 40} more; narrow the filter to see them.`));
      this.line('');
      this.line(
        `  ${hint(theme, 'f', 'finger')} ${hint(theme, 'm', 'movement')} ${hint(theme, 'c', 'category')} ${hint(theme, 'l', 'level')} ${hint(theme, 'x', 'clear')} ${hint(theme, 'Enter', 'pick a lesson')}`,
      );

      const answer = (await this.ask('Pick or filter')).toLowerCase();
      if (!answer || answer === 'b') {
        filtering = false;
        break;
      }
      if (answer === 'x') {
        for (const key of Object.keys(filters)) delete filters[key];
        continue;
      }
      if (answer === 'f') {
        this.line('');
        Object.keys(FINGER_INFO).forEach((finger, i) => {
          this.line(`  ${theme.bold(String(i + 1))}. ${fingerLabel(finger)}`);
        });
        const pick = await this.ask('Finger');
        const finger = Object.keys(FINGER_INFO)[Number.parseInt(pick, 10) - 1];
        if (finger) filters.finger = finger;
        continue;
      }
      if (answer === 'm') {
        this.line('');
        const movements = Object.values(MOVEMENTS);
        movements.forEach((m, i) => {
          this.line(`  ${theme.bold(String(i + 1))}. ${m.label} ${theme.gray(`(${m.kind})`)}`);
        });
        const pick = await this.ask('Movement');
        const movement = movements[Number.parseInt(pick, 10) - 1];
        if (movement) filters.movement = movement.id;
        continue;
      }
      if (answer === 'c') {
        const cats = this.service.libraryOverview().facets.categories;
        this.line('');
        cats.forEach((c, i) => this.line(`  ${theme.bold(String(i + 1))}. ${c.label} (${c.count})`));
        const pick = await this.ask('Category');
        const cat = cats[Number.parseInt(pick, 10) - 1];
        if (cat) filters.category = cat.id;
        continue;
      }
      if (answer === 'l') {
        const levels = this.service.libraryOverview().facets.levels;
        this.line('');
        this.line(`  ${levels.map((l) => `L${l.level}(${l.count})`).join('  ')}`);
        const pick = await this.ask('Level');
        const level = Number.parseInt(pick, 10);
        if (Number.isInteger(level)) filters.difficulty = level;
        continue;
      }

      const index = Number.parseInt(answer, 10) - 1;
      const lesson = lessons[index];
      if (lesson) {
        await this.showLesson(lesson);
        filtering = false;
      }
    }
  }

  async showLesson(lesson) {
    clearScreen();
    this.header(lesson.name, `Level ${lesson.level} · ${lesson.category}`);
    this.line('');
    for (const line of wrap(lesson.description, Math.min(terminalWidth(), 92))) this.line(`  ${line}`);
    this.line('');
    this.line(`  ${theme.gray('Fingers')}   ${lesson.fingers.map(fingerLabel).join(', ')}`);
    this.line(`  ${theme.gray('Movements')} ${lesson.movements.map(movementLabel).join(', ')}`);
    this.line(`  ${theme.gray('Outcome')}   ${lesson.outcome}`);
    this.line(
      `  ${theme.gray('Targets')}   ${theme.bold(`${lesson.criteria.minAccuracy}% accuracy`)}${lesson.criteria.speedIsAdvisory ? theme.gray(` (${lesson.criteria.minWpm} WPM advisory)`) : ''}`,
    );
    this.line('');
    this.section('Exercises');
    lesson.exercises.forEach((ex, i) => {
      this.line(`  ${theme.gray(`${i + 1}.`)} ${ex.text}`);
    });

    const progress = this.service.lessonProgress().find((p) => p.lessonId === lesson.id);
    if (progress?.attempts) {
      this.line('');
      this.line(
        `  ${theme.gray('Your history')} ${progress.attempts} attempt${progress.attempts === 1 ? '' : 's'} · best ${accuracyColor(theme, progress.bestAccuracy)(`${progress.bestAccuracy}%`)} · ${progress.passed ? theme.green('passed') : theme.yellow('not yet passed')}`,
      );
    }

    this.line('');
    if (await this.confirm('Practise this lesson?', true)) {
      await this.practiseLesson(lesson);
    }
  }

  async practiseLesson(lesson) {
    const mode = this.service.settings().mode ?? 'flow';
    this.service.todaysPlan(); // ensure today's plan exists for task tracking

    const results = await runLesson({ service: this.service, lesson, mode, theme, ask: async (t, q) => (await this.confirm(q, true)) ? 'y' : 'n' });

    if (results.length) {
      const passed = results.filter((r) => r.verdict.passed).length;
      this.line(`${theme.bold('Session complete')} — ${passed}/${results.length} exercises met the criteria.`);
      const progress = this.service.lessonProgress().find((p) => p.lessonId === lesson.id);
      if (progress) {
        this.line(
          `  ${theme.gray('Lesson status')} ${progress.passed ? theme.green('passed') : theme.yellow('in progress')} · best ${theme.bold(`${progress.bestAccuracy}%`)}`,
        );
      }
    }
    await this.pause();
  }

  async dailyTasks() {
    clearScreen();
    const tasks = this.service.todaysTasks();
    this.header('Daily tasks', tasks.date);
    this.line('');
    for (const task of tasks.tasks) {
      const mark = task.done ? theme.green('✔') : theme.gray('○');
      const bar =
        task.unit === '%'
          ? progressBar(task.progress, { width: 16, max: 100, theme })
          : progressBar(task.progress, { width: 16, max: task.target, theme });
      this.line(`  ${mark} ${theme.bold(task.title)}`);
      this.line(`     ${bar} ${theme.gray(`${task.progress}/${task.target}${task.unit === '%' ? '%' : ` ${task.unit}`}`)}`);
      this.line(`     ${theme.gray(task.description)}`);
    }
    this.line('');
    this.line(
      `  ${theme.bold(`${tasks.completed}/${tasks.total}`)} complete${tasks.allDone ? theme.green(' — all done for today.') : ''}`,
    );
    await this.pause();
  }

  async performance() {
    clearScreen();
    const stats = this.service.stats();
    const history = this.service.history({ days: 14 });
    this.header('Performance');
    this.line('');
    this.line(`  ${theme.gray('Lifetime WPM')}      ${theme.bold(String(stats.wpm))}`);
    this.line(`  ${theme.gray('Lifetime accuracy')} ${accuracyColor(theme, stats.accuracy)(`${stats.accuracy}%`)}`);
    this.line(`  ${theme.gray('Practice time')}     ${theme.bold(stats.practiceLabel)}`);
    this.line(`  ${theme.gray('Exercises')}         ${theme.bold(String(stats.attempts))}`);
    this.line(`  ${theme.gray('Lessons passed')}    ${theme.bold(`${stats.lessonsPassed}/${stats.lessonsTotal}`)}`);
    this.line(`  ${theme.gray('Streak')}            ${theme.bold(`${stats.streak.current} day(s)`)} ${theme.gray(`(best ${stats.streak.best})`)}`);
    this.line('');
    this.line(`  ${theme.gray('Overall')} ${progressBar(stats.overallPercent, { width: 30, theme })} ${theme.bold(`${stats.overallPercent}%`)}`);

    this.section('Last 14 days');
    const activeDays = history.days.filter((d) => d.attempts > 0);
    if (!activeDays.length) {
      this.line(theme.gray('  No practice in this window yet.'));
    } else {
      const rows = activeDays.map((d) => [
        d.date,
        String(d.attempts),
        `${d.wpm} WPM`,
        accuracyColor(theme, d.accuracy)(`${d.accuracy}%`),
        humanDuration(d.practiceMs),
        progressBar(d.accuracy, { width: 12, theme }),
      ]);
      this.line(table(rows, { headers: ['Date', 'Ex', 'Speed', 'Accuracy', '', ], theme }));
    }

    this.section('Recent attempts');
    const recent = history.recent.slice(0, 10);
    if (!recent.length) {
      this.line(theme.gray('  No attempts recorded yet.'));
    } else {
      const rows = recent.map((a) => [
        (a.finishedAt ?? '').slice(5, 16).replace('T', ' '),
        a.lessonName.slice(0, 32),
        `${a.wpm} WPM`,
        accuracyColor(theme, a.accuracy)(`${a.accuracy}%`),
        theme.gray(`${a.errors} err`),
      ]);
      this.line(table(rows, { headers: ['When', 'Lesson', 'Speed', 'Accuracy', ''], theme }));
    }
    await this.pause();
  }

  async fingerProgress() {
    clearScreen();
    const fingers = this.service.fingerProgress();
    this.header('Finger progress');
    this.line('');
    this.line(
      `  ${padEnd(theme.gray('Finger'), 16)} ${padEnd(theme.gray('Accuracy'), 30)} ${padEnd(theme.gray('Chars'), 10)} ${theme.gray('Trend')}`,
    );
    this.line(`  ${theme.gray('─'.repeat(Math.min(terminalWidth() - 4, 78)))}`);

    for (const finger of fingers) {
      const accuracyText = finger.accuracy === null ? theme.gray('—') : accuracyColor(theme, finger.accuracy)(`${finger.accuracy}%`);
      const bar = finger.accuracy === null ? theme.gray('░'.repeat(20)) : progressBar(finger.accuracy, { width: 20, theme });
      this.line(
        `  ${padEnd(FINGER_INFO[finger.finger].label, 16)} ${bar} ${padStart(accuracyText, 7)}   ` +
          `${padEnd(theme.gray(`${finger.correct}/${finger.total}`), 10)} ${trendBadge(theme, finger.trend)}`,
      );
    }

    const practised = fingers.filter((f) => f.total > 0);
    const untouched = fingers.filter((f) => f.total === 0);
    this.line('');
    this.line(`  ${theme.gray(`${practised.length} of 10 fingers practised`)}${untouched.length ? theme.gray(` · not yet: ${untouched.map((f) => f.label).join(', ')}`) : ''}`);

    this.section('Movements');
    const movements = this.service.movementProgress();
    if (!movements.length) {
      this.line(theme.gray('  No movement data yet.'));
    } else {
      for (const m of movements.sort((a, b) => (a.accuracy ?? 0) - (b.accuracy ?? 0))) {
        this.line(
          `  ${padEnd(m.label, 22)} ${progressBar(m.accuracy ?? 0, { width: 20, theme })} ${padStart(accuracyColor(theme, m.accuracy)(`${m.accuracy}%`), 7)}  ${theme.gray(`${m.total} chars`)}`,
        );
      }
    }
    await this.pause();
  }

  async history() {
    clearScreen();
    const data = this.service.history({ days: 30 });
    this.header('History', 'last 30 days');
    this.line('');
    const active = data.days.filter((d) => d.attempts > 0);
    if (!active.length) {
      this.line(theme.gray('  Nothing recorded yet.'));
      await this.pause();
      return;
    }

    // Simple ASCII sparkline of daily accuracy.
    const sparkChars = '▁▂▃▄▅▆▇█';
    const spark = data.days
      .map((d) => (d.attempts === 0 ? theme.gray('·') : sparkChars[Math.min(7, Math.floor((d.accuracy / 100) * 8))]))
      .join('');
    this.line(`  ${theme.gray('Accuracy by day')}`);
    this.line(`  ${spark}`);
    const first = data.days[0]?.date.slice(5);
    const last = data.days[data.days.length - 1]?.date.slice(5);
    this.line(`  ${theme.gray(`${first} → ${last}`)}`);

    this.line('');
    this.line(`  ${theme.gray('Practice')}  ${theme.bold(data.practiceTimeLabel)}`);
    this.line(`  ${theme.gray('Streak')}    ${theme.bold(`${data.streak.current} current`)} ${theme.gray(`· ${data.streak.best} best`)}`);
    this.line(`  ${theme.gray('Accuracy')}  ${accuracyColor(theme, data.totals.accuracy)(`${data.totals.accuracy}%`)} across ${data.totals.attempts} exercises`);

    this.section('Sessions');
    const rows = data.recent.slice(0, 15).map((a) => [
      (a.finishedAt ?? '').slice(0, 16).replace('T', ' '),
      a.lessonName.slice(0, 30),
      `${a.wpm}`,
      accuracyColor(theme, a.accuracy)(`${a.accuracy}%`),
    ]);
    this.line(table(rows, { headers: ['When', 'Lesson', 'WPM', 'Acc'], theme, align: ['left', 'left', 'right', 'right'] }));
    await this.pause();
  }

  async weaknesses() {
    clearScreen();
    const assessment = this.service.weaknesses();
    this.header('Identified weaknesses');
    this.line('');
    this.line(`  ${theme.gray('Analysis is based on multiple attempts; one bad run cannot create a weakness.')}`);
    this.line('');

    if (!assessment.findings.length) {
      this.line(`  ${theme.green('✔ No weaknesses detected.')}`);
      if (!assessment.summary.hasEnoughData) {
        this.line(`  ${theme.gray('Keep practising — there is not enough data for a reliable assessment yet.')}`);
      }
    } else {
      for (const finding of assessment.findings.slice(0, 10)) {
        const severityHue = finding.severity > 55 ? theme.red : finding.severity > 30 ? theme.yellow : theme.gray;
        this.line(`  ${severityHue('●')} ${theme.bold(finding.title)} ${theme.gray(`(severity ${finding.severity})`)}`);
        for (const reason of finding.reasons.slice(0, 2)) {
          this.line(`     ${theme.gray(reason)}`);
        }
      }
    }

    this.section('Finger summary');
    for (const f of assessment.fingerEvals) {
      const label = FINGER_INFO[f.finger]?.label ?? f.finger;
      const statusHue =
        f.status === 'critical' ? theme.red : f.status === 'weak' ? theme.yellow : f.status === 'strong' ? theme.green : theme.gray;
      this.line(
        `  ${padEnd(label, 16)} ${padEnd(statusHue(f.status), 14)} ${f.accuracy === null ? theme.gray('—') : theme.bold(`${f.accuracy}%`)} ${theme.gray(`(${f.evidence} chars)`)}`,
      );
    }
    await this.pause();
  }

  async adaptive() {
    clearScreen();
    const assessment = this.service.assessment();
    this.header('Adaptive learning', 'BTS');
    this.line('');
    for (const line of wrap(assessment.plan.explanation, Math.min(terminalWidth(), 92))) {
      this.line(`  ${line}`);
    }

    this.section('Why these lessons today');
    for (const item of assessment.plan.items) {
      const lesson = this.service.lesson(item.lessonId);
      this.line(`  ${theme.bold(`${item.order}. ${lesson.name}`)} ${theme.gray(`[${item.kind}] score ${item.score}`)}`);
      for (const reason of item.reasons) {
        for (const wrapped of wrap(reason, Math.min(terminalWidth() - 10, 88))) {
          this.line(`     ${theme.gray(`· ${wrapped}`)}`);
        }
      }
    }

    this.section('Top recommendations');
    const recs = this.service.recommendations(6);
    recs.forEach((r, i) => {
      this.line(`  ${theme.bold(`${i + 1}. ${r.name}`)} ${theme.gray(`L${r.level} · ${r.kind} · score ${r.score}`)}`);
      this.line(`     ${theme.gray(r.reasons[0])}`);
    });

    this.line('');
    if (await this.confirm('Regenerate today’s plan with fresh scoring?', false)) {
      this.service.assessment({ forcePlan: true });
      this.line(theme.green('  Plan regenerated.'));
      await this.pause();
    }
  }

  async settings() {
    clearScreen();
    const settings = this.service.settings();
    this.header('Settings');
    this.line('');
    this.line(`  ${theme.gray('Typing mode')}        ${theme.bold(settings.mode)} ${theme.gray(`(${SESSION_MODES[settings.mode]?.description ?? ''})`)}`);
    this.line(`  ${theme.gray('Daily exercises')}   ${theme.bold(String(settings.dailyGoalExercises))}`);
    this.line(`  ${theme.gray('Daily minutes')}     ${theme.bold(String(settings.dailyGoalMinutes))}`);
    this.line(`  ${theme.gray('Lessons per plan')}  ${theme.bold(String(settings.sessionLessons))}`);
    this.line('');
    this.line(
      `  ${hint(theme, 'm', 'toggle typing mode')} ${hint(theme, 'g', 'daily exercise goal')} ${hint(theme, 'r', 'reset all progress')} ${hint(theme, 'Enter', 'back')}`,
    );

    const answer = (await this.ask('Action')).toLowerCase();
    if (answer === 'm') {
      const next = settings.mode === 'flow' ? 'strict' : 'flow';
      this.service.updateSettings({ mode: next });
      this.line(theme.green(`  Mode set to ${next}.`));
      await this.pause();
    } else if (answer === 'g') {
      const value = Number.parseInt(await this.ask('Exercises per day'), 10);
      if (Number.isInteger(value) && value > 0 && value <= 50) {
        this.service.updateSettings({ dailyGoalExercises: value });
        this.line(theme.green(`  Daily goal set to ${value}.`));
      } else {
        this.line(theme.red('  Enter a number between 1 and 50.'));
      }
      await this.pause();
    } else if (answer === 'r') {
      if (await this.confirm('Delete all progress? This cannot be undone.', false)) {
        this.service.resetProgress();
        this.line(theme.green('  Progress reset.'));
      }
      await this.pause();
    }
  }
}

/* ------------------------------------------------------------------ *
 * Non-interactive commands
 * ------------------------------------------------------------------ */

const HELP = `
TypeBreak — adaptive typing practice

Usage
  npm start                         interactive menu
  node src/cli/index.js <command>

Commands
  plan [--regen]        Show today's adaptive lesson plan
  tasks                 Show today's tasks
  lessons [--finger F] [--movement M] [--level N] [--search Q]
                        List the preset lesson library
  show <lessonId>       Show a lesson and its exercises
  practise <lessonId> [--mode flow|strict] [--exercise N]
                        Type a lesson in the terminal
  stats                 Performance summary
  fingers               Per-finger and per-movement progress
  history [--days N]    Daily history
  weaknesses            BTS weakness findings
  why <lessonId>        Explain why a lesson is recommended
  reset                 Delete all progress

Flags
  --no-color            Disable ANSI colour
  --help                Show this help
`.trim();

export async function runCommandLine(argv) {
  const args = argv.filter((a) => !a.startsWith('--') && !a.startsWith('-'));
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const getFlagValue = (name) => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };

  if (flags.has('--help') || args[0] === 'help') {
    console.log(HELP);
    return 0;
  }

  const service = new AppService();
  const command = args[0] ?? '';

  switch (command) {
    case 'plan': {
      const assessment = service.assessment({ forcePlan: flags.has('--regen') });
      console.log(`\n${theme.bold(`Today — ${assessment.date}`)}\n`);
      console.log(wrap(assessment.plan.explanation, 92).map((l) => theme.gray(l)).join('\n'));
      console.log('');
      for (const item of assessment.plan.items) {
        const lesson = service.lesson(item.lessonId);
        console.log(`${theme.bold(String(item.order))}. ${lesson.name} ${theme.gray(`[${item.kind}] L${lesson.level}`)}`);
        console.log(`   ${theme.gray(item.reasons[0])}`);
      }
      console.log('');
      return 0;
    }

    case 'tasks': {
      const tasks = service.todaysTasks();
      console.log(`\n${theme.bold('Daily tasks')} — ${tasks.completed}/${tasks.total}\n`);
      for (const task of tasks.tasks) {
        console.log(`${task.done ? theme.green('✔') : theme.gray('○')} ${task.title} ${theme.gray(`(${task.progress}/${task.target}${task.unit === '%' ? '%' : ''})`)}`);
      }
      console.log('');
      return 0;
    }

    case 'lessons': {
      const filters = {};
      const finger = getFlagValue('finger');
      const movement = getFlagValue('movement');
      const level = getFlagValue('level');
      const search = getFlagValue('search');
      if (finger) filters.finger = finger;
      if (movement) filters.movement = movement;
      if (level) filters.difficulty = Number.parseInt(level, 10);
      if (search) filters.search = search;
      const lessons = service.lessons(filters);
      console.log('');
      console.log(
        table(
          lessons.map((l) => [`L${l.level}`, l.id, l.name, theme.gray(l.fingers.map((f) => FINGER_INFO[f].short).join(','))]),
          { headers: ['Lvl', 'ID', 'Lesson', 'Fingers'], theme },
        ),
      );
      console.log(`\n${lessons.length} lessons\n`);
      return 0;
    }

    case 'show': {
      const lesson = service.lesson(args[1]);
      if (!lesson) {
        console.error(`Unknown lesson: ${args[1]}. Run "lessons" to list ids.`);
        return 1;
      }
      console.log(`\n${theme.bold(lesson.name)} ${theme.gray(`L${lesson.level}`)}\n`);
      console.log(wrap(lesson.description, 92).join('\n'));
      console.log(`\n${theme.gray('Fingers')}   ${lesson.fingers.map(fingerLabel).join(', ')}`);
      console.log(`${theme.gray('Movements')} ${lesson.movements.map(movementLabel).join(', ')}`);
      console.log(`${theme.gray('Targets')}   ${lesson.criteria.minAccuracy}% accuracy`);
      console.log(`\n${theme.bold('Exercises')}`);
      lesson.exercises.forEach((ex, i) => console.log(`  ${i + 1}. ${ex.text}`));
      console.log('');
      return 0;
    }

    case 'practise': {
      const lesson = service.lesson(args[1]);
      if (!lesson) {
        console.error(`Unknown lesson: ${args[1]}. Run "lessons" to list ids.`);
        return 1;
      }
      const mode = getFlagValue('mode') ?? service.settings().mode ?? 'flow';
      if (!SESSION_MODES[mode]) {
        console.error(`Unknown mode: ${mode}. Use flow or strict.`);
        return 1;
      }
      if (!process.stdin.isTTY) {
        console.error('Interactive practice requires a terminal. Run this command directly in your shell.');
        return 1;
      }
      clearScreen();
      const results = await runLesson({ service, lesson, mode, theme });
      return results.length ? 0 : 1;
    }

    case 'stats': {
      const s = service.stats();
      console.log('');
      console.log(`${theme.gray('WPM')}        ${theme.bold(String(s.wpm))}`);
      console.log(`${theme.gray('Accuracy')}   ${accuracyColor(theme, s.accuracy)(`${s.accuracy}%`)}`);
      console.log(`${theme.gray('Practice')}   ${theme.bold(s.practiceLabel)}`);
      console.log(`${theme.gray('Exercises')}  ${theme.bold(String(s.attempts))}`);
      console.log(`${theme.gray('Lessons')}    ${theme.bold(`${s.lessonsPassed}/${s.lessonsTotal}`)}`);
      console.log(`${theme.gray('Streak')}     ${theme.bold(`${s.streak.current}d`)} ${theme.gray(`(best ${s.streak.best})`)}`);
      console.log(`${theme.gray('Overall')}    ${progressBar(s.overallPercent, { width: 24, theme })} ${s.overallPercent}%`);
      console.log('');
      return 0;
    }

    case 'fingers': {
      const fingers = service.fingerProgress();
      console.log('');
      for (const f of fingers) {
        const acc = f.accuracy === null ? theme.gray('  —  ') : accuracyColor(theme, f.accuracy)(`${f.accuracy}%`.padStart(6));
        console.log(`  ${padEnd(FINGER_INFO[f.finger].label, 16)} ${progressBar(f.accuracy ?? 0, { width: 20, theme })} ${acc} ${trendBadge(theme, f.trend)}`);
      }
      const movements = service.movementProgress();
      if (movements.length) {
        console.log(`\n${theme.bold('Movements')}`);
        for (const m of movements.sort((a, b) => (a.accuracy ?? 0) - (b.accuracy ?? 0))) {
          console.log(`  ${padEnd(m.label, 22)} ${progressBar(m.accuracy ?? 0, { width: 20, theme })} ${accuracyColor(theme, m.accuracy)(`${m.accuracy}%`.padStart(6))}`);
        }
      }
      console.log('');
      return 0;
    }

    case 'history': {
      const days = Number.parseInt(getFlagValue('days') ?? '30', 10);
      const data = service.history({ days });
      console.log('');
      for (const day of data.days.filter((d) => d.attempts > 0)) {
        console.log(
          `  ${day.date}  ${String(day.attempts).padStart(2)} ex  ${String(day.wpm).padStart(5)} WPM  ${accuracyColor(theme, day.accuracy)(`${day.accuracy}%`.padStart(6))}  ${humanDuration(day.practiceMs)}`,
        );
      }
      console.log(`\n  Streak ${data.streak.current} (best ${data.streak.best}) · practice ${data.practiceTimeLabel}\n`);
      return 0;
    }

    case 'weaknesses': {
      const w = service.weaknesses();
      console.log('');
      if (!w.findings.length) {
        console.log(`  ${theme.green('No weaknesses detected.')}`);
        if (!w.summary.hasEnoughData) console.log(`  ${theme.gray('Not enough data yet.')}`);
      }
      for (const f of w.findings) {
        console.log(`  ${theme.bold(f.title)} ${theme.gray(`severity ${f.severity}`)}`);
        console.log(`    ${theme.gray(f.detail)}`);
      }
      console.log('');
      return 0;
    }

    case 'why': {
      const id = args[1];
      if (!id) {
        console.error('Usage: why <lessonId>');
        return 1;
      }
      const rec = service.recommendations(200).find((r) => r.lessonId === id);
      if (!rec) {
        console.error(`Unknown lesson: ${id}`);
        return 1;
      }
      console.log(`\n${theme.bold(rec.name)} ${theme.gray(`score ${rec.score} · ${rec.kind}`)}\n`);
      for (const reason of rec.reasons) console.log(`  · ${reason}`);
      console.log(`\n${theme.gray('Score components')}`);
      for (const s of rec.signals) console.log(`  ${padEnd(s.id, 20)} ${s.weight > 0 ? '+' : ''}${s.weight}`);
      console.log('');
      return 0;
    }

    case 'reset': {
      service.resetProgress();
      console.log('Progress reset.');
      return 0;
    }

    default: {
      const cli = new Cli({ service });
      await cli.mainLoop();
      return 0;
    }
  }
}
