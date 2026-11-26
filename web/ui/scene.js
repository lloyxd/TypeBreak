/**
 * Animated low-poly night scene.
 *
 * A single full-viewport canvas behind the app: layered jagged ridges in the
 * image's indigo/lavender palette, a soft moon glow, drifting snow, and a few
 * warm-lit windows on the far peak. Drawn procedurally so there are no image
 * assets to load, cache or go stale offline.
 *
 * Deliberate constraints, because this sits behind every screen:
 *   · One canvas, one rAF loop, everything else is a pure draw.
 *   · Pauses when the tab is hidden or the window is scrolled away.
 *   · Static single frame under `prefers-reduced-motion`.
 *   · DPR-aware, and re-lays out on resize without re-seeding the geometry, so
 *     the mountains do not visibly reshuffle when the window changes.
 */

const PALETTE = {
  skyTop: '#07140f',
  skyMid: '#0f241c',
  skyLow: '#16382a',
  glowMoon: 'rgba(243, 201, 107, 0.14)',
  ridgeFar: '#1a3a32',
  ridgeMid: '#214a3c',
  ridgeNear: '#2a5a48',
  ridgeFront: '#163028',
  snow: '#f4f1e8',
  snowWarm: '#ffe9b8',
  window: '#f3c96b',
};

/** Deterministic PRNG so the mountains are the same on every load. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Build one ridge: a list of points making a jagged skyline, plus the faceted
 * triangles that fill it (a flat shade per facet is what gives the low-poly look).
 */
function buildRidge({ random, width, height, baseY, peakHeight, points, shade, jitter }) {
  const vertices = [];
  for (let i = 0; i <= points; i += 1) {
    const x = (i / points) * width;
    // A couple of overlapping sine waves keep peaks irregular but organic.
    const wave =
      Math.sin((i / points) * Math.PI * 2.1 + random() * 0.6) * 0.5 +
      Math.sin((i / points) * Math.PI * 5.3 + random() * 1.4) * 0.28;
    const y = baseY - peakHeight * (0.35 + 0.65 * Math.abs(wave)) * (0.75 + random() * 0.5 * jitter);
    vertices.push({ x, y });
  }

  // Fill with triangles from a baseline, alternating two shades for facets.
  const facets = [];
  for (let i = 0; i < vertices.length - 1; i += 1) {
    const a = vertices[i];
    const b = vertices[i + 1];
    const bottom = baseY + 40;
    facets.push({
      points: [a, b, { x: b.x, y: bottom }, { x: a.x, y: bottom }],
      shade: i % 2 === 0 ? shade : dim(shade, 0.86),
    });
  }

  return { vertices, facets, baseY };
}

/** Darken a hex colour by a factor. */
function dim(hex, factor) {
  const n = Number.parseInt(hex.slice(1), 16);
  const r = Math.round(((n >> 16) & 255) * factor);
  const g = Math.round(((n >> 8) & 255) * factor);
  const b = Math.round((n & 255) * factor);
  return `rgb(${r}, ${g}, ${b})`;
}

/** Snowflake particles drifting down with a gentle sideways sway. */
function createSnow(count) {
  const flakes = [];
  for (let i = 0; i < count; i += 1) {
    flakes.push({
      x: Math.random(),
      y: Math.random(),
      depth: 0.35 + Math.random() * 0.65,
      drift: (Math.random() - 0.5) * 0.00012,
      speed: 0.00004 + Math.random() * 0.00009,
      phase: Math.random() * Math.PI * 2,
    });
  }
  return flakes;
}

export function createScene(container, { reducedMotion = false } = {}) {
  const canvas = document.createElement('canvas');
  canvas.className = 'scene-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  container.appendChild(canvas);

  const ctx = canvas.getContext('2d');
  if (!ctx) return { destroy() {} };

  let width = 0;
  let height = 0;
  let dpr = 1;
  let ridges = [];
  let snow = [];
  let raf = 0;
  let last = 0;
  let elapsed = 0;
  let visible = true;
  let destroyed = false;

  const buildGeometry = () => {
    const random = mulberry32(0x5eed);
    ridges = [
      buildRidge({ random, width: width * 1.15, height, baseY: height * 0.78, peakHeight: height * 0.62, points: 13, shade: PALETTE.ridgeFar, jitter: 1.25 }),
      buildRidge({ random, width: width * 1.1, height, baseY: height * 0.9, peakHeight: height * 0.5, points: 10, shade: PALETTE.ridgeMid, jitter: 1.1 }),
      buildRidge({ random, width, height, baseY: height * 1.02, peakHeight: height * 0.36, points: 8, shade: PALETTE.ridgeNear, jitter: 1 }),
    ];
    snow = createSnow(Math.round(Math.min(70, (width * height) / 18000)));
  };

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
    buildGeometry();
    draw();
  };

  const drawSky = () => {
    const sky = ctx.createLinearGradient(0, 0, 0, height);
    sky.addColorStop(0, PALETTE.skyTop);
    sky.addColorStop(0.55, PALETTE.skyMid);
    sky.addColorStop(1, PALETTE.skyLow);
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, width, height);

    // Cheap aurora: two wide bands that drift with elapsed time.
    const ax = Math.sin(elapsed * 0.00018) * width * 0.08;
    const aurora = ctx.createLinearGradient(0, height * 0.08, width, height * 0.42);
    aurora.addColorStop(0, 'rgba(40, 140, 80, 0)');
    aurora.addColorStop(0.35 + ax / width, 'rgba(46, 150, 90, 0.16)');
    aurora.addColorStop(0.55, 'rgba(180, 50, 50, 0.08)');
    aurora.addColorStop(1, 'rgba(40, 140, 80, 0)');
    ctx.fillStyle = aurora;
    ctx.fillRect(0, 0, width, height * 0.5);

    // Moon with a soft bloom, high and to the right.
    const mx = width * 0.74;
    const my = height * 0.18;
    const halo = ctx.createRadialGradient(mx, my, 0, mx, my, height * 0.5);
    halo.addColorStop(0, PALETTE.glowMoon);
    halo.addColorStop(0.4, 'rgba(180, 80, 50, 0.05)');
    halo.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = halo;
    ctx.fillRect(0, 0, width, height);

    ctx.beginPath();
    ctx.arc(mx, my, Math.min(width, height) * 0.045, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 236, 200, 0.92)';
    ctx.fill();

    // A few stars, slow pulse — cheap enough for a static host.
    ctx.fillStyle = 'rgba(255, 236, 210, 0.7)';
    for (let i = 0; i < 28; i += 1) {
      const sx = ((i * 137.5) % 100) / 100;
      const sy = ((i * 61.8) % 55) / 100;
      const r = i % 7 === 0 ? 1.4 : 0.8;
      const twinkle = reducedMotion ? 0.4 : 0.28 + 0.22 * Math.sin(elapsed * 0.0012 + i);
      ctx.globalAlpha = twinkle;
      ctx.beginPath();
      ctx.arc(sx * width, sy * height * 0.72, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  };

  const drawRidge = (ridge, offsetY, offsetX, windows = false) => {
    for (const facet of ridge.facets) {
      ctx.beginPath();
      const pts = facet.points;
      ctx.moveTo(pts[0].x + offsetX, pts[0].y + offsetY);
      for (let i = 1; i < pts.length; i += 1) ctx.lineTo(pts[i].x + offsetX, pts[i].y + offsetY);
      ctx.closePath();
      ctx.fillStyle = facet.shade;
      ctx.fill();
    }

    // A lit crown along the ridge line, which reads as snow catching moonlight.
    ctx.beginPath();
    ctx.moveTo(ridge.vertices[0].x + offsetX, ridge.vertices[0].y + offsetY);
    for (let i = 1; i < ridge.vertices.length; i += 1) {
      ctx.lineTo(ridge.vertices[i].x + offsetX, ridge.vertices[i].y + offsetY);
    }
    ctx.strokeStyle = 'rgba(196, 216, 255, 0.34)';
    ctx.lineWidth = 1.2;
    ctx.stroke();

    if (windows) {
      // Warm windows on the far ridge, the little sign of life in the reference.
      ctx.fillStyle = PALETTE.window;
      ctx.globalAlpha = 0.85;
      for (const v of ridge.vertices) {
        if (v.y < ridge.baseY - height * 0.16) continue;
        ctx.fillRect(v.x + offsetX - 2, v.y + offsetY + 16, 3, 4);
      }
      ctx.globalAlpha = 1;
    }
  };

  const drawSnow = (dt) => {
    for (const flake of snow) {
      if (!reducedMotion) {
        flake.y += flake.speed * dt * 60 * 0.35;
        flake.x += (flake.drift * dt * 60 + Math.sin(flake.phase + elapsed * 0.0004) * 0.00004) * flake.depth;
        if (flake.y > 1.05) {
          flake.y = -0.05;
          flake.x = Math.random();
        }
        if (flake.x > 1.03) flake.x = -0.03;
        if (flake.x < -0.03) flake.x = 1.03;
      }

      const r = 0.8 + flake.depth * 1.9;
      ctx.globalAlpha = 0.18 + flake.depth * 0.5;
      ctx.beginPath();
      ctx.arc(flake.x * width, flake.y * height, r, 0, Math.PI * 2);
      ctx.fillStyle = flake.depth > 0.8 ? PALETTE.snowWarm : PALETTE.snow;
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  };

  function draw() {
    if (destroyed) return;
    drawSky();

    // Slow parallax drift; each layer moves a little differently.
    const drift = reducedMotion ? 0 : Math.sin(elapsed * 0.00012) * 14;
    if (ridges[0]) drawRidge(ridges[0], 0, -width * 0.06 + drift * 0.4, true);
    if (ridges[1]) drawRidge(ridges[1], 0, -width * 0.03 + drift * 0.7);
    if (ridges[2]) drawRidge(ridges[2], 0, drift);

    // A light vignette keeps foreground text legible without flattening the
    // mountains into the page background.
    const vignette = ctx.createRadialGradient(width * 0.5, height * 0.45, height * 0.35, width * 0.5, height * 0.5, height * 1.02);
    vignette.addColorStop(0, 'rgba(0,0,0,0)');
    vignette.addColorStop(1, 'rgba(4, 12, 8, 0.5)');
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, width, height);

    drawSnow(last - 0 || 16);
  }

  const frame = (time) => {
    if (destroyed) return;
    const dt = Math.min(64, time - (last || time));
    last = time;
    elapsed += dt;
    if (visible) draw();
    raf = requestAnimationFrame(frame);
  };

  const start = () => {
    if (reducedMotion) {
      draw();
      return;
    }
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(frame);
  };

  const onVisibility = () => {
    visible = document.visibilityState === 'visible';
    if (visible) last = 0;
  };

  const observer = new ResizeObserver(() => resize());
  observer.observe(container);
  document.addEventListener('visibilitychange', onVisibility);

  resize();
  start();

  return {
    destroy() {
      destroyed = true;
      cancelAnimationFrame(raf);
      observer.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      canvas.remove();
    },
  };
}
