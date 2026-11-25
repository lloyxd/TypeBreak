/**
 * Minimal DOM helpers.
 *
 * No framework, no virtual DOM. `h` builds real elements, and a couple of
 * helpers cover the common shapes (bars, pills, tables) so pages stay declarative.
 * Text is always set via textContent, so user or library content can never be
 * interpreted as HTML.
 */

/**
 * Create an element.
 *
 * @param {string} tag           e.g. 'div.card.grid-2' or 'button.primary'
 * @param {object|null} attrs    properties/attributes; `on*` keys become listeners
 * @param {...(Node|string|null|undefined|Array)} children
 */
export function h(tag, attrs = null, ...children) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');

  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') {
        el.className = `${el.className} ${value}`.trim();
      } else if (key === 'style' && typeof value === 'object') {
        Object.assign(el.style, value);
      } else if (key === 'dataset' && typeof value === 'object') {
        Object.assign(el.dataset, value);
      } else if (key.startsWith('on') && typeof value === 'function') {
        el.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (key === 'html') {
        // Reserved for our own trusted SVG markup only.
        el.innerHTML = value;
      } else if (key in el && key !== 'list' && typeof value !== 'object') {
        el[key] = value;
      } else {
        el.setAttribute(key, String(value));
      }
    }
  }

  append(el, children);
  return el;
}

/** Append children, flattening arrays and skipping nullish/false. */
export function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false || child === true) continue;
    el.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function mount(el, ...children) {
  clear(el);
  append(el, children);
  return el;
}

/* ---------- shared components ---------- */

/** A labelled horizontal bar. */
export function barRow(label, value, { max = 100, suffix = '%', tone = null, hint = null } = {}) {
  const pct = max === 0 ? 0 : Math.max(0, Math.min(100, (value / max) * 100));
  const color = tone ?? (pct >= 96 ? 'green' : pct >= 88 ? 'yellow' : 'red');
  const display = value === null || value === undefined ? '—' : `${Math.round(value)}${suffix}`;

  return h(
    'div.bar-row',
    null,
    h('div', { title: hint ?? undefined }, label),
    h('div.bar', { role: 'progressbar', 'aria-valuenow': Math.round(pct), 'aria-valuemin': 0, 'aria-valuemax': 100 }, h(`div.bar-fill.${color}`, { style: { width: `${pct}%` } })),
    h('div.val', null, display),
  );
}

/** A bare bar, no labels. */
export function bar(value, { max = 100, tone = null } = {}) {
  const pct = max === 0 ? 0 : Math.max(0, Math.min(100, (value / max) * 100));
  const color = tone ?? (pct >= 96 ? 'green' : pct >= 88 ? 'yellow' : 'red');
  return h('div.bar', { role: 'progressbar', 'aria-valuenow': Math.round(pct), 'aria-valuemin': 0, 'aria-valuemax': 100 }, h(`div.bar-fill.${color}`, { style: { width: `${pct}%` } }));
}

export function pill(text, variant = '') {
  return h(`span.pill${variant ? `.${variant}` : ''}`, null, text);
}

export function statCard(label, value, sub = null, tone = null) {
  return h('div.stat', null, h('div.stat-label', null, label), h(`div.stat-value${tone ? `.${tone}` : ''}`, null, value), sub ? h('div.stat-sub', null, sub) : null);
}

export function statsStrip(items) {
  return h('div.stats-strip', null, items.map((item) => statCard(item.label, item.value, item.sub, item.tone)));
}

export function card(...children) {
  return h('div.card', null, ...children);
}

export function section(title, ...children) {
  return h('div.section', null, title ? h('h2', null, title) : null, ...children);
}

export function empty(message) {
  return h('div.empty', null, message);
}

/** A compact data table. `columns` = [{ label, align }] */
export function dataTable(columns, rows) {
  return h(
    'div.table-wrap',
    null,
    h(
      'table',
      null,
      h('thead', null, h('tr', null, columns.map((c) => h(`th${c.align === 'right' ? '.num' : ''}`, { scope: 'col' }, c.label)))),
      h(
        'tbody',
        null,
        rows.map((row) => h('tr', null, row.map((cell, i) => h(`td${columns[i]?.align === 'right' ? '.num' : ''}`, null, cell)))),
      ),
    ),
  );
}

/** Coloured number for an accuracy figure. */
export function accuracyLabel(value) {
  if (value === null || value === undefined) return h('span.faint', null, '—');
  const tone = value >= 96 ? 'var(--green)' : value >= 92 ? 'var(--yellow)' : 'var(--red)';
  return h('span', { style: { color: tone } }, `${value}%`);
}

export function trendLabel(trend) {
  if (trend === 'improving') return h('span', { style: { color: 'var(--green)' } }, 'improving');
  if (trend === 'declining') return h('span', { style: { color: 'var(--red)' } }, 'declining');
  if (trend === 'stable') return h('span.faint', null, 'stable');
  return h('span.faint', null, 'no data');
}

/** Format ms as m:ss or Ns. */
export function duration(ms) {
  const total = Math.round((ms ?? 0) / 1000);
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m < 60) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** Relative "3 days ago" style label. */
export function relativeTime(iso) {
  if (!iso) return 'never';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'never';
  const diff = Date.now() - then;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

/**
 * Build an inline SVG line chart from series data.
 *
 * Hand-rolled rather than pulling in a charting library: the requirement is
 * "lightweight", and this is ~40 lines with full control over the axes.
 *
 * @param {object} opts
 * @param {Array<{label:string, color:string, points:Array<number|null>}>} opts.series
 * @param {string[]} opts.labels   x-axis labels, one per point
 * @param {string} opts.yLabel
 * @param {number} [opts.yMin]
 * @param {number} [opts.yMax]
 */
export function lineChart({ series, labels, yLabel, yMin = null, yMax = null, height = 160 }) {
  const width = 720;
  const padL = 38;
  const padR = 8;
  const padT = 10;
  const padB = 22;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const allValues = series.flatMap((s) => s.points).filter((v) => typeof v === 'number');
  if (!allValues.length) return empty('No data yet');

  const min = yMin ?? Math.max(0, Math.floor(Math.min(...allValues) - 4));
  const max = yMax ?? Math.ceil(Math.max(...allValues) + 4);
  const span = Math.max(1, max - min);

  const x = (i) => padL + (labels.length <= 1 ? plotW / 2 : (i / (labels.length - 1)) * plotW);
  const y = (v) => padT + plotH - ((v - min) / span) * plotH;

  const gridLines = 4;
  const grid = Array.from({ length: gridLines + 1 }, (_, i) => {
    const value = min + (span * i) / gridLines;
    const yy = y(value);
    return `<line x1="${padL}" y1="${yy}" x2="${width - padR}" y2="${yy}" stroke="var(--border)" stroke-width="1" />
      <text x="${padL - 6}" y="${yy + 3.5}" text-anchor="end" font-size="9" fill="var(--text-faint)">${Math.round(value)}</text>`;
  }).join('');

  const paths = series
    .map((s) => {
      // Break the path at gaps so missing days do not draw false lines.
      const segments = [];
      let current = [];
      s.points.forEach((v, i) => {
        if (typeof v === 'number') {
          current.push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`);
        } else if (current.length) {
          segments.push(current);
          current = [];
        }
      });
      if (current.length) segments.push(current);

      return segments
        .filter((seg) => seg.length > 1)
        .map((seg) => `<polyline fill="none" stroke="${s.color}" stroke-width="1.8" stroke-linejoin="round" points="${seg.join(' ')}" />`)
        .join('');
    })
    .join('');

  const dots = series
    .map((s) =>
      s.points
        .map((v, i) => (typeof v === 'number' ? `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="1.8" fill="${s.color}" />` : ''))
        .join(''),
    )
    .join('');

  // Show at most 6 x-axis labels to avoid crowding.
  const step = Math.max(1, Math.ceil(labels.length / 6));
  const xLabels = labels
    .map((label, i) =>
      i % step === 0 || i === labels.length - 1
        ? `<text x="${x(i).toFixed(1)}" y="${height - 6}" text-anchor="middle" font-size="9" fill="var(--text-faint)">${label}</text>`
        : '',
    )
    .join('');

  const svg = `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${yLabel} over time">
    <text x="${padL}" y="${padT - 1}" font-size="9" fill="var(--text-faint)">${yLabel}</text>
    ${grid}
    ${paths}
    ${dots}
    ${xLabels}
  </svg>`;

  const legend = h(
    'div.chart-legend',
    null,
    series.map((s) =>
      h('span', null, h('span.swatch', { style: { background: s.color } }), s.name ?? ''),
    ),
  );

  return h('div', null, h('div', { html: svg }), legend);
}

/** Bar sparkline for daily activity. */
export function sparkline(values, { height = 48 } = {}) {
  const max = Math.max(1, ...values);
  return h(
    'div.sparkline',
    { style: { height: `${height}px` } },
    values.map((v) =>
      h(`div.sparkline-bar${v === 0 ? '.empty' : ''}`, {
        style: { height: v === 0 ? '2px' : `${Math.max(6, (v / max) * height)}px` },
        title: String(v),
      }),
    ),
  );
}
