/**
 * Typing feedback effects.
 *
 * The game feel lives here: a sparkle burst on every correct character, a
 * shake-and-red flash on a miss, milestone banners for combos, and a floating
 * "+1" style score pop. All canvas-based on one overlay so hundreds of particles
 * cost one draw loop rather than hundreds of DOM nodes.
 *
 * Everything degrades to nothing under `prefers-reduced-motion`, and the
 * container is `pointer-events: none` so it never intercepts typing.
 */

const GOLD = '#ffd45c';
const CYAN = '#7fd8ff';
const LAVENDER = '#b9a4ff';
const ROSE = '#ff7d9c';
const GREEN = '#6ee7a0';

const SPARK_COLORS = [GOLD, CYAN, LAVENDER, GREEN];

export function createEffects(container, { reducedMotion = false } = {}) {
  const canvas = document.createElement('canvas');
  canvas.className = 'fx-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  container.appendChild(canvas);

  const ctx = canvas.getContext('2d');
  const layer = document.createElement('div');
  layer.className = 'fx-layer';
  layer.setAttribute('aria-hidden', 'true');
  container.appendChild(layer);

  let width = 0;
  let height = 0;
  let dpr = 1;
  let particles = [];
  let raf = 0;
  let last = 0;

  const resize = () => {
    const rect = container.getBoundingClientRect();
    width = Math.max(320, rect.width);
    height = Math.max(320, rect.height);
    dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  /** Spawn a ring of sparks at a viewport point. */
  const burst = (x, y, { count = 10, power = 1, colors = SPARK_COLORS, spread = Math.PI * 2, angle = -Math.PI / 2 } = {}) => {
    if (reducedMotion) return;
    for (let i = 0; i < count; i += 1) {
      const theta = angle + (Math.random() - 0.5) * spread;
      const speed = (1.4 + Math.random() * 3.2) * power;
      particles.push({
        x,
        y,
        vx: Math.cos(theta) * speed,
        vy: Math.sin(theta) * speed,
        life: 1,
        decay: 0.012 + Math.random() * 0.018,
        size: 1.6 + Math.random() * 2.8,
        color: colors[Math.floor(Math.random() * colors.length)],
        // Half the sparks are little angular shards rather than circles.
        shard: Math.random() > 0.45,
        spin: (Math.random() - 0.5) * 0.35,
        rot: Math.random() * Math.PI,
        gravity: 0.028 + Math.random() * 0.03,
      });
    }
    start();
  };

  /** Screen position of an element's centre, in container-relative coords. */
  const centerOf = (el) => {
    if (!el) return null;
    const box = el.getBoundingClientRect();
    const root = container.getBoundingClientRect();
    return {
      x: box.left - root.left + box.width / 2,
      y: box.top - root.top + box.height / 2,
      width: box.width,
      height: box.height,
    };
  };

  const start = () => {
    if (raf) return;
    last = performance.now();
    raf = requestAnimationFrame(tick);
  };

  function tick(now) {
    const dt = Math.min(48, now - last);
    last = now;

    ctx.clearRect(0, 0, width, height);

    const alive = [];
    for (const p of particles) {
      p.life -= p.decay * (dt / 16.67);
      if (p.life <= 0) continue;

      p.x += p.vx * (dt / 16.67);
      p.y += p.vy * (dt / 16.67);
      p.vy += p.gravity * (dt / 16.67);
      p.vx *= 0.985;
      p.vy *= 0.985;
      p.rot += p.spin;

      ctx.globalAlpha = Math.max(0, Math.min(1, p.life));
      ctx.fillStyle = p.color;

      if (p.shard) {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        const s = p.size * 1.5;
        ctx.beginPath();
        ctx.moveTo(0, -s);
        ctx.lineTo(s * 0.6, 0);
        ctx.lineTo(0, s);
        ctx.lineTo(-s * 0.6, 0);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      } else {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2);
        ctx.fill();
      }

      alive.push(p);
    }

    ctx.globalAlpha = 1;
    particles = alive;

    if (particles.length) raf = requestAnimationFrame(tick);
    else raf = 0;
  }

  /* ---------------- public feedback API ---------------- */

  /**
   * A correct keystroke: a small burst at the character, colour-shifted by the
   * current combo so a long streak visibly changes character.
   */
  const correct = (el, combo = 0) => {
    const pos = centerOf(el);
    if (!pos) return;
    const tier = Math.min(3, Math.floor(combo / 10));
    const colors = tier >= 2 ? [GOLD, '#fff1b8', ROSE] : tier === 1 ? [GOLD, CYAN, GREEN] : SPARK_COLORS;
    burst(pos.x, pos.y, {
      count: 5 + tier * 3,
      power: 0.7 + tier * 0.18,
      colors,
      spread: Math.PI * 1.5,
    });
  };

  /** A wrong keystroke: a short red scatter, no gravity, feels like a recoil. */
  const wrong = (el) => {
    const pos = centerOf(el);
    if (!pos) return;
    burst(pos.x, pos.y, {
      count: 8,
      power: 1.15,
      colors: ['#ff5f6d', '#ff8a6b', '#ffb3a7'],
      spread: Math.PI * 2,
    });
    const surface = document.querySelector('.typing-surface');
    if (surface && !reducedMotion) {
      surface.classList.remove('shake');
      // Force a reflow so the animation restarts on consecutive misses.
      void surface.offsetWidth;
      surface.classList.add('shake');
    }
  };

  /** An exercise completed: a wide celebratory shower from the top. */
  const celebrate = () => {
    if (reducedMotion) return;
    for (let i = 0; i < 5; i += 1) {
      setTimeout(() => {
        burst(width * (0.2 + Math.random() * 0.6), height * (0.15 + Math.random() * 0.2), {
          count: 18,
          power: 1.5,
          colors: [GOLD, '#fff1b8', CYAN, LAVENDER, GREEN],
          spread: Math.PI * 2,
        });
      }, i * 110);
    }
  };

  /** A floating text pop, e.g. "Combo x12" or "+40 WPM". */
  const pop = (text, { tone = 'gold', at = null } = {}) => {
    if (reducedMotion) return;
    const pos = at ?? { x: width / 2, y: height * 0.32 };
    const el = document.createElement('div');
    el.className = `fx-pop fx-${tone}`;
    el.textContent = text;
    el.style.left = `${pos.x}px`;
    el.style.top = `${pos.y}px`;
    layer.appendChild(el);
    // Remove after the animation; a timer is more reliable than animationend
    // when the element is inside a layer that may be reparented.
    setTimeout(() => el.remove(), 1200);
  };

  /** Milestone banner for a combo tier. */
  const banner = (text, tone = 'gold') => {
    const el = document.createElement('div');
    el.className = `fx-banner fx-${tone}`;
    el.textContent = text;
    layer.appendChild(el);
    setTimeout(() => el.remove(), 1400);
  };

  const observer = new ResizeObserver(resize);
  observer.observe(container);
  resize();

  return {
    correct,
    wrong,
    celebrate,
    pop,
    banner,
    burst,
    destroy() {
      cancelAnimationFrame(raf);
      observer.disconnect();
      canvas.remove();
      layer.remove();
    },
  };
}

/**
 * Combo tracker.
 *
 * Turns a stream of hits and misses into a combo counter with tiers, which is
 * what drives escalating feedback. Kept separate from rendering so it can be
 * unit-tested and so the scoring rules are readable in one place.
 */
export class ComboTracker {
  constructor({ tierSize = 10 } = {}) {
    this.tierSize = tierSize;
    this.count = 0;
    this.best = 0;
    this.tier = 0;
  }

  /** Record a correct keystroke. Returns the new count and any tier crossed. */
  hit() {
    this.count += 1;
    this.best = Math.max(this.best, this.count);
    const tier = Math.floor(this.count / this.tierSize);
    const tierUp = tier > this.tier ? tier : 0;
    this.tier = Math.max(this.tier, tier);
    return { count: this.count, tier, tierUp };
  }

  /** Record a miss. Breaks the run; returns the run that was lost. */
  miss() {
    const lost = this.count;
    this.count = 0;
    this.tier = 0;
    return { lost };
  }

  reset() {
    this.count = 0;
    this.tier = 0;
  }
}
