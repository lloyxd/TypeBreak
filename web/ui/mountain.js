/**
 * Mountain path — the progression map.
 *
 * The reference image's whole idea is *climbing*: a jagged peak with waypoints
 * up it. This renders the lesson library as a trail of nodes scaling a mountain,
 * ordered by level, so progress reads as altitude rather than a checklist.
 *
 * Reads as a game without lying about the data:
 *   · a passed lesson is a lit waypoint,
 *   · the frontier (lowest level with unpassed lessons) gets a beacon,
 *   · unpassed lessons above the frontier are dimmer, but still fully clickable —
 *     the brief requires that no lesson is ever locked.
 *
 * Pure SVG, no canvas, so it is crisp, accessible and cheap to re-render.
 */

import { h } from '../dom.js';
import { navigate } from '../router.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Build an element in the SVG namespace. */
function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    el.setAttribute(key, String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return el;
}

/**
 * Lay lessons out along a switchback trail climbing the mountain.
 *
 * Lessons are grouped by level, and each level becomes a horizontal "terrace" on
 * the mountain. Within a terrace the nodes spread evenly; consecutive terraces
 * alternate direction so the trail zig-zags upward like a real switchback path.
 *
 * The terrace spacing is proportional to the largest level group, so a level with
 * twelve lessons gets the same horizontal room as one with three — otherwise the
 * dense levels would collapse into overlapping dots.
 */
function layout(lessons, { width, height, padding }) {
  const byLevel = new Map();
  for (const lesson of lessons) {
    if (!byLevel.has(lesson.level)) byLevel.set(lesson.level, []);
    byLevel.get(lesson.level).push(lesson);
  }

  const levels = [...byLevel.keys()].sort((a, b) => a - b);
  const usableW = width - padding.left - padding.right;
  const usableH = height - padding.top - padding.bottom;

  // Terrace height: enough vertical room that rings never touch.
  const terraceGap = levels.length <= 1 ? 0 : usableH / (levels.length - 1);
  const nodes = [];

  levels.forEach((level, levelIndex) => {
    const group = byLevel.get(level);
    // Highest level sits near the summit.
    const y = padding.top + usableH * (1 - (levels.length <= 1 ? 0.5 : levelIndex / (levels.length - 1)));
    const forwards = levelIndex % 2 === 0;

    group.forEach((lesson, i) => {
      const t = group.length === 1 ? 0.5 : i / (group.length - 1);
      // Alternate direction, and inset the ends so nodes do not sit on the edge.
      const along = forwards ? t : 1 - t;
      const x = padding.left + usableW * (0.04 + along * 0.92);
      // A slight vertical stagger stops a long terrace reading as a ruler.
      const stagger = group.length > 6 ? (i % 2 === 0 ? -1 : 1) * Math.min(6, terraceGap * 0.12) : 0;

      nodes.push({ lesson, level, x, y: y + stagger, levelIndex, indexInLevel: i, groupSize: group.length, forwards });
    });
  });

  return { nodes, levels, byLevel, terraceGap };
}

/**
 * @param {object} params
 * @param {Array} params.lessons        full library
 * @param {(id:string)=>object} params.progressOf  lesson progress lookup
 * @param {string} [params.height]
 */
export function mountainPath({ lessons, progressOf, height = 420 }) {
  const width = 900;
  // Left padding is wider to leave room for the per-level labels.
  const padding = 46;
  const labelSpace = 44;
  const { nodes, levels, byLevel } = layout(lessons, {
    width,
    height,
    padding: { top: 30, bottom: 24, left: padding + labelSpace, right: padding },
  });

  // The frontier: lowest level that still has unpassed lessons.
  const frontierLevel = levels.find((level) => byLevel.get(level).some((l) => !progressOf(l.id)?.passed)) ?? null;

  const passedCount = lessons.filter((l) => progressOf(l.id)?.passed).length;

  const svg = s(
    'svg',
    {
      viewBox: `0 0 ${width} ${height}`,
      class: 'mountain-svg',
      role: 'img',
      'aria-label': `Progression map: ${passedCount} of ${lessons.length} lessons passed`,
      preserveAspectRatio: 'xMidYMid meet',
    },
  );

  /* ---- the mountain silhouette the path climbs ---- */

  const grad = s('defs', {},
    s('linearGradient', { id: 'peakFill', x1: '0', y1: '0', x2: '0', y2: '1' },
      s('stop', { offset: '0%', 'stop-color': '#3b4a8f', 'stop-opacity': '0.5' }),
      s('stop', { offset: '100%', 'stop-color': '#111a3e', 'stop-opacity': '0.15' }),
    ),
    s('linearGradient', { id: 'trailLit', x1: '0', y1: '1', x2: '1', y2: '0' },
      s('stop', { offset: '0%', 'stop-color': '#7fd8ff', 'stop-opacity': '0.65' }),
      s('stop', { offset: '100%', 'stop-color': '#ffd45c', 'stop-opacity': '0.9' }),
    ),
    s('radialGradient', { id: 'beacon' },
      s('stop', { offset: '0%', 'stop-color': '#ffd45c', 'stop-opacity': '0.55' }),
      s('stop', { offset: '100%', 'stop-color': '#ffd45c', 'stop-opacity': '0' }),
    ),
  );
  svg.appendChild(grad);

  // A coarse faceted peak: a few triangles reading as low-poly, matching the
  // background scene without competing with it.
  svg.appendChild(
    s('path', {
      d: `M ${width * 0.02} ${height} L ${width * 0.3} ${height * 0.52} L ${width * 0.44} ${height * 0.66} L ${width * 0.58} ${height * 0.2} L ${width * 0.72} ${height * 0.6} L ${width * 0.86} ${height * 0.42} L ${width * 0.98} ${height} Z`,
      fill: 'url(#peakFill)',
      stroke: 'rgba(168, 196, 255, 0.22)',
      'stroke-width': '1.4',
    }),
  );
  svg.appendChild(
    s('path', {
      d: `M ${width * 0.58} ${height * 0.2} L ${width * 0.5} ${height * 0.42} L ${width * 0.66} ${height * 0.44} Z`,
      fill: 'rgba(200, 220, 255, 0.2)',
    }),
  );

  /* ---- the trail ---- */

  // Draw the path as two parts: within each terrace (a simple run) and between
  // terraces (one connector from the last node of one level to the first of the
  // next). Drawing a curve through all 55 nodes at once produced a hairball.
  const passedIds = new Set(lessons.filter((l) => progressOf(l.id)?.passed).map((l) => l.id));

  const trailSegments = [];
  levels.forEach((level, levelIndex) => {
    const group = byLevel.get(level);
    // Order each terrace in the direction the trail travels.
    const ordered = levelIndex % 2 === 0 ? group : [...group].reverse();
    const points = ordered.map((lesson) => nodes.find((n) => n.lesson.id === lesson.id));

    for (let i = 0; i < points.length - 1; i += 1) {
      trailSegments.push([points[i], points[i + 1], passedIds.has(points[i].lesson.id) && passedIds.has(points[i + 1].lesson.id)]);
    }

    // Connect the end of this terrace to the start of the next.
    const nextGroup = byLevel.get(levels[levelIndex + 1]);
    if (nextGroup) {
      const from = points[points.length - 1];
      const nextOrdered = (levelIndex + 1) % 2 === 0 ? nextGroup : [...nextGroup].reverse();
      const to = nodes.find((n) => n.lesson.id === nextOrdered[0].id);
      trailSegments.push([from, to, passedIds.has(from.lesson.id) && passedIds.has(to.lesson.id)]);
    }
  });

  for (const [a, b, lit] of trailSegments) {
    svg.appendChild(
      s('line', {
        x1: a.x.toFixed(1),
        y1: a.y.toFixed(1),
        x2: b.x.toFixed(1),
        y2: b.y.toFixed(1),
        stroke: lit ? 'url(#trailLit)' : 'rgba(168, 196, 255, 0.15)',
        'stroke-width': lit ? 3 : 1.6,
        'stroke-linecap': 'round',
      }),
    );
  }

  /* ---- terrace labels ---- */

  for (const level of levels) {
    const group = byLevel.get(level);
    const first = nodes.find((n) => n.lesson.id === group[0].id);
    const done = group.filter((l) => progressOf(l.id)?.passed).length;
    svg.appendChild(
      s('text', {
        x: 8,
        y: first.y + 3.5,
        class: 'terrace-label',
      }, `L${level}`),
    );
    svg.appendChild(
      s('text', {
        x: 8,
        y: first.y + 14,
        class: 'terrace-count',
      }, `${done}/${group.length}`),
    );
  }

  /* ---- waypoints ---- */

  const tooltip = h('div.mountain-tip', { 'aria-hidden': 'true' });

  for (const node of nodes) {
    const progress = progressOf(node.lesson.id);
    const passed = Boolean(progress?.passed);
    const isFrontier = node.level === frontierLevel && !passed;
    const attempts = progress?.attempts ?? 0;

    const group = s('g', {
      class: `waypoint${passed ? ' passed' : ''}${isFrontier ? ' frontier' : ''}${attempts > 0 && !passed ? ' started' : ''}`,
      tabindex: '0',
      role: 'link',
      'aria-label': `${node.lesson.name}. Level ${node.lesson.level}. ${passed ? `Passed, best ${progress.bestAccuracy}%` : attempts ? `${attempts} attempts, not yet passed` : 'Not started'}.`,
    });

    if (isFrontier) {
      group.appendChild(s('circle', { cx: node.x, cy: node.y, r: 22, fill: 'url(#beacon)', class: 'beacon' }));
    }

    // Outer ring + inner disc. Radius grows slightly with level for a sense of
    // scale without breaking the layout.
    const r = 7 + Math.min(3, node.level * 0.3);
    group.appendChild(s('circle', { cx: node.x, cy: node.y, r: r + 3.5, class: 'wp-ring' }));
    group.appendChild(s('circle', { cx: node.x, cy: node.y, r, class: 'wp-core' }));

    if (passed) {
      // A small tick, drawn as a path so it needs no font.
      group.appendChild(
        s('path', {
          d: `M ${node.x - 3.2} ${node.y} L ${node.x - 0.8} ${node.y + 2.6} L ${node.x + 3.4} ${node.y - 2.4}`,
          class: 'wp-tick',
          fill: 'none',
        }),
      );
    }

    const open = () => navigate(`/lesson/${encodeURIComponent(node.lesson.id)}`);
    group.addEventListener('click', open);
    group.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        open();
      }
    });

    // Hover card, positioned in the wrapper's coordinate space.
    group.addEventListener('pointerenter', () => {
      tooltip.textContent = '';
      tooltip.append(
        h('strong', null, node.lesson.name),
        h('span', { class: 'tip-meta' },
          `Level ${node.lesson.level} · `,
          passed ? `passed · best ${progress.bestAccuracy}%` : attempts ? `${attempts} attempt${attempts === 1 ? '' : 's'}` : 'not started'),
      );
      const rect = svg.getBoundingClientRect();
      const scale = rect.width / width;
      tooltip.style.left = `${node.x * scale}px`;
      tooltip.style.top = `${node.y * scale}px`;
      tooltip.classList.add('visible');
    });
    group.addEventListener('pointerleave', () => tooltip.classList.remove('visible'));
    group.addEventListener('focus', () => {
      const rect = svg.getBoundingClientRect();
      const scale = rect.width / width;
      tooltip.textContent = node.lesson.name;
      tooltip.style.left = `${node.x * scale}px`;
      tooltip.style.top = `${node.y * scale}px`;
      tooltip.classList.add('visible');
    });
    group.addEventListener('blur', () => tooltip.classList.remove('visible'));

    svg.appendChild(group);
  }

  /* ---- summit label ---- */

  if (levels.length) {
    const topY = Math.min(...nodes.map((n) => n.y));
    svg.appendChild(
      s('text', {
        x: width - 12,
        y: Math.max(14, topY - 20),
        class: 'summit-label',
        'text-anchor': 'end',
      }, `Summit · level ${levels[levels.length - 1]}`),
    );
  }

  const legend = h(
    'div.mountain-legend',
    null,
    h('span', null, h('i.ml-dot.ml-passed'), 'Passed'),
    h('span', null, h('i.ml-dot.ml-frontier'), 'Your frontier'),
    h('span', null, h('i.ml-dot.ml-open'), 'Available now'),
  );

  return h(
    'div.mountain-wrap',
    null,
    h('div.mountain-head', null,
      h('h2', { style: { margin: 0 } }, 'The climb'),
      h('span.faint', { style: { fontSize: '12px' } }, `${passedCount} of ${lessons.length} waypoints reached`),
    ),
    h('div.mountain-stage', null, svg, tooltip),
    legend,
  );
}
