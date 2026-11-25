/**
 * Terminal presentation helpers.
 *
 * Kept separate from command logic so the colours can be disabled wholesale
 * (pipes, CI, `NO_COLOR`) and the CLI logic stays readable.
 */

const ESC = '\u001b[';

export function supportsColor(stream = process.stdout) {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  if (process.env.TERM === 'dumb') return false;
  return Boolean(stream.isTTY);
}

export function createTheme({ enabled = supportsColor() } = {}) {
  const wrap = (open, close) => (text) => (enabled ? `${ESC}${open}m${text}${ESC}${close}m` : String(text));

  return {
    enabled,
    bold: wrap('1', '22'),
    dim: wrap('2', '22'),
    italic: wrap('3', '23'),
    underline: wrap('4', '24'),
    red: wrap('31', '39'),
    green: wrap('32', '39'),
    yellow: wrap('33', '39'),
    blue: wrap('34', '39'),
    magenta: wrap('35', '39'),
    cyan: wrap('36', '39'),
    white: wrap('37', '39'),
    gray: wrap('90', '39'),
    bgGreen: wrap('42', '49'),
    bgRed: wrap('41', '49'),
    bgBlue: wrap('44', '49'),
    inverse: wrap('7', '27'),
    strike: wrap('9', '29'),
  };
}

/** Visible width of a string, ignoring ANSI escapes. */
export function visibleLength(str) {
  return String(str).replace(/\u001b\[[0-9;]*m/g, '').length;
}

/** Pad to width based on visible length. */
export function padEnd(str, width, char = ' ') {
  const pad = width - visibleLength(str);
  return pad > 0 ? `${str}${char.repeat(pad)}` : str;
}

export function padStart(str, width, char = ' ') {
  const pad = width - visibleLength(str);
  return pad > 0 ? `${char.repeat(pad)}${str}` : str;
}

/** A horizontal rule that respects the terminal width. */
export function rule(theme, width = terminalWidth(), char = '─') {
  return theme.gray(char.repeat(Math.max(0, Math.min(width, 100))));
}

export function terminalWidth() {
  return process.stdout.columns || 80;
}

/**
 * A labelled progress bar, e.g. `Left ring  ███████░░░  72%`.
 */
export function progressBar(value, { width = 20, max = 100, theme = createTheme() } = {}) {
  const ratio = Math.max(0, Math.min(1, max === 0 ? 0 : value / max));
  const filled = Math.round(ratio * width);
  const empty = width - filled;
  const hue = ratio >= 0.85 ? theme.green : ratio >= 0.6 ? theme.yellow : theme.red;
  return `${hue('█'.repeat(filled))}${theme.gray('░'.repeat(empty))}`;
}

/** Render a table with aligned columns. */
export function table(rows, { headers = null, theme = createTheme(), align = [] } = {}) {
  const all = headers ? [headers, ...rows] : rows;
  const widths = [];
  for (const row of all) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, visibleLength(cell));
    });
  }
  const build = (row) =>
    row
      .map((cell, i) => {
        const padded = align[i] === 'right' ? padStart(cell, widths[i]) : padEnd(cell, widths[i]);
        return padded;
      })
      .join('  ')
      .replace(/\s+$/, '');

  const lines = [];
  if (headers) {
    lines.push(theme.bold(build(headers)));
    lines.push(theme.gray('─'.repeat(widths.reduce((a, b) => a + b, 0) + 2 * (widths.length - 1))));
  }
  for (const row of rows) lines.push(build(row));
  return lines.join('\n');
}

/** Big two-line banner used on the home screen. */
export function banner(theme) {
  const art = [
    '  ████████╗██╗   ██╗██████╗ ███████╗',
    '  ╚══██╔══╝╚██╗ ██╔╝██╔══██╗██╔════╝',
    '     ██║    ╚████╔╝ ██████╔╝█████╗  ',
    '     ██║     ╚██╔╝  ██╔═══╝ ██╔══╝  ',
    '     ██║      ██║   ██║     ███████╗',
    '     ╚═╝      ╚═╝   ╚═╝     ╚══════╝',
  ];
  const word = [
    '  ██████╗ ██████╗ ███████╗ █████╗ ██╗  ██╗',
    '  ██╔══██╗██╔══██╗██╔════╝██╔══██╗██║ ██╔╝',
    '  ██████╔╝██████╔╝█████╗  ███████║█████╔╝ ',
    '  ██╔══██╗██╔══██╗██╔══╝  ██╔══██║██╔═██╗ ',
    '  ██████╔╝██████╔╝███████╗██║  ██║██║  ██╗',
    '  ╚═════╝ ╚═════╝ ╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝',
  ];
  const color = (line) => theme.cyan(line);
  return [...art.map(color), ...word.map(color)].join('\n');
}

/** Short coloured key hint, e.g. `[1] Dashboard`. */
export function hint(theme, key, label) {
  return `${theme.bold(theme.cyan(`[${key}]`))} ${label}`;
}

/** Status colour for an accuracy figure. */
export function accuracyColor(theme, value) {
  if (value === null || value === undefined) return theme.gray;
  if (value >= 96) return theme.green;
  if (value >= 92) return theme.yellow;
  return theme.red;
}

/** Status colour for a trend. */
export function trendBadge(theme, trend) {
  switch (trend) {
    case 'improving':
      return theme.green('▲ improving');
    case 'declining':
      return theme.red('▼ declining');
    case 'stable':
      return theme.gray('► stable');
    default:
      return theme.gray('· no data');
  }
}

/** Human duration from ms, e.g. `1h 04m`, `4m 12s`, `38s`. */
export function humanDuration(ms) {
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/** Clear the visible screen without polluting scrollback excessively. */
export function clearScreen() {
  if (process.stdout.isTTY) process.stdout.write(`${ESC}2J${ESC}H`);
}

/** Word-wrap plain text to a width. */
export function wrap(text, width = terminalWidth()) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    if (line.length + word.length + 1 > width && line.length) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}
