// render.js — draws the constellation onto a full-screen canvas, every frame.
//
// Visual system:
//   TRAILS — instead of hard-clearing, each frame paints a translucent black
//     veil over the last one, so motion leaves fading comet trails.
//   GLOW — halos and edges draw in 'lighter' composite mode (colors ADD where
//     they overlap, like real light). The node DISC itself draws normally, so
//     its pitch color stays true instead of blowing out to white.
//   EXPOSURE CONTROL — anything additive that repaints every frame must be
//     drawn at (intended brightness × TRAIL_FADE). The veil removes TRAIL_FADE
//     of the old frame while we add one new coat, so brightness converges to
//     exactly the intended level instead of stacking up ~1/TRAIL_FADE times
//     over-bright (the bug that washed everything to white).
//   EDGES CARRY DATA — chain edges brighten when units were spoken
//     back-to-back; similarity edges take the shared pitch's color, opacity =
//     how similar. Both fade with age: recent speech is bright, old speech
//     recedes into the background web.
//   RIPPLE — a newborn node emits an expanding ring, so every word visibly
//     lands in the artwork.
//   SIGNAL EFFECTS — new edges carry a traveling spark (pulse), new nodes
//     burst in with an overshoot scale + white flash, recently-active edges
//     breathe, edges show a drifting dash "flow", and Hz labels count up
//     before landing. Every one of these is a pure function of node/link age
//     (bornAt vs now) — no effect objects exist, so nothing needs cleanup and
//     nothing can pile up over a long session.
//   ANNOTATIONS — the newest few nodes get technical callouts (id + Hz) that
//     fade out as they age, keeping the "machine decoding speech" detail
//     without letting labels pile up into clutter.
//
// The render loop is the app's single timing source: it advances the physics
// one step, then paints the result.

import { pitchToColor, UNVOICED_COLOR } from './palette.js';

const BACKGROUND = '#050505';
const TRAIL_FADE = 0.22; // veil strength: 0 = infinite trails, 1 = no trails

// Halo (the additive glow around a disc). Intended steady brightness, before
// the TRAIL_FADE exposure scaling described above.
const HALO_BRIGHTNESS = 0.9;
const HALO_SIZE = 1.9; // shadowBlur radius as a multiple of node radius
const SHADOW_OFFSET = 4096; // draw the halo's source shape far off-screen

// Hot core: small and faint — just enough to suggest a light source without
// erasing the pitch color (the overexposure complaint from review).
const CORE_RADIUS = 0.3; // × node radius
const CORE_ALPHA = 0.16;

// Edge aging: alpha multiplier decays from 1 → floor over EDGE_AGE_MS.
const EDGE_AGE_MS = 45000;
const EDGE_AGE_FLOOR = 0.3;

const RIPPLE_MS = 650; // how long a newborn node's ring lives

// Signal effects (all driven purely by node/link age — see header note).
const PULSE_MS = 350; // spark travel time along a newborn edge
const BIRTH_MS = 260; // newborn disc scales 0 → ~1.15 → 1 over this window
const FLASH_MS = 320; // newborn white flash fade time
const BREATHE_RECENT_MS = 4000; // edges touching nodes younger than this breathe
const BREATHE_DEPTH = 0.22; // ± swing of the breathing (alpha and width)
const BREATHE_SPEED = 1 / 600; // radians per ms ≈ one slow cycle every ~3.8s
const FLOW_DASH = [3, 9]; // dash pattern of the directional-flow overlay
const FLOW_SPEED = 0.018; // dash drift in px/ms, source → target
const FLOW_BRIGHTNESS = 0.5; // overlay alpha as a fraction of the edge's own
const SETTLE_MS = 180; // Hz labels count up to their real value over this

// Labels: only the newest few nodes, fading out over LABEL_FADE_MS.
const LABEL_FADE_MS = 6000;
const LABEL_RECENT = 3; // always label the N newest regardless of age

// Scale curve for a newborn disc: starts at 0, overshoots slightly past 1,
// then settles back ("ease-out-back"). BACK sets the overshoot (~1.15 max).
const BACK = 2.4;
function birthScale(age) {
  if (age >= BIRTH_MS) return 1;
  const u = age / BIRTH_MS - 1; // runs -1 → 0
  return 1 + u * u * ((BACK + 1) * u + BACK);
}

// An edge's color + steady-state alpha, shared by the base stroke, the flow
// overlay, and the pulse spark so they always agree on what an edge looks like.
function edgeAppearance(link) {
  if (link.kind === 'seq') {
    return {
      color: 'rgb(190, 205, 255)',
      intended: 0.25 + 0.45 * (link.closeness ?? 0.5),
    };
  }
  const pitch = (link.source.unit.avgPitchHz + link.target.unit.avgPitchHz) / 2;
  return {
    color: pitchToColor(pitch),
    intended: 0.12 + 0.3 * (link.similarity ?? 0.5),
  };
}

export class Renderer {
  constructor(canvas, constellation) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.constellation = constellation;
    this.rafId = null;
    this.dpr = 1;

    this._resize = this._resize.bind(this);
    window.addEventListener('resize', this._resize);
    this._resize();
  }

  // Match the canvas backing store to the element's CSS size × devicePixelRatio
  // so the artwork is crisp on any display, then tell the physics where center is.
  _resize() {
    this.dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); // CSS-pixel coordinates
    this.constellation.setSize(w, h);
    // A resize wipes the canvas, so repaint the background solid once.
    this.ctx.fillStyle = BACKGROUND;
    this.ctx.fillRect(0, 0, w, h);
  }

  start() {
    if (this.rafId !== null) return;
    const loop = () => {
      this.constellation.tick(); // one physics step per painted frame
      this.draw();
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  stop() {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  draw() {
    const ctx = this.ctx;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const { nodes, links } = this.constellation;
    const now = performance.now();

    // -- Trail veil: fade the previous frame instead of erasing it ----------
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = `rgba(5, 5, 5, ${TRAIL_FADE})`;
    ctx.fillRect(0, 0, w, h);

    // -- Edges: additive light, exposure-scaled, aging toward the floor -----
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineWidth = 1;
    for (const link of links) {
      const age = now - (link.bornAt ?? now);
      const ageFactor =
        EDGE_AGE_FLOOR + (1 - EDGE_AGE_FLOOR) * Math.max(0, 1 - age / EDGE_AGE_MS);
      const { color, intended } = edgeAppearance(link);

      // Breathing: edges touching a recently-born node swell and relax slowly.
      // sin() is periodic, so bornAt works directly as a per-edge phase offset
      // (keeps the web from pulsing in unison). Old edges skip this entirely
      // and stay governed by the aging floor alone.
      let breathe = 0;
      if (
        now - link.source.bornAt < BREATHE_RECENT_MS ||
        now - link.target.bornAt < BREATHE_RECENT_MS
      ) {
        breathe = Math.sin(now * BREATHE_SPEED + link.bornAt) * BREATHE_DEPTH;
      }

      ctx.strokeStyle = color;
      ctx.lineWidth = 1 + breathe;
      ctx.globalAlpha = intended * (1 + breathe) * ageFactor * TRAIL_FADE; // exposure control
      ctx.beginPath();
      ctx.moveTo(link.source.x, link.source.y);
      ctx.lineTo(link.target.x, link.target.y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1;

    // -- Directional flow: dashed overlay drifting source → target ----------
    // The negative offset marches the dashes forward along the stroke
    // direction, i.e. from the older node toward the newer one — the order
    // the words were actually spoken. Edges past EDGE_AGE_MS are skipped, so
    // this pass's cost is bounded by recent activity, not session length.
    ctx.setLineDash(FLOW_DASH);
    ctx.lineDashOffset = -now * FLOW_SPEED;
    for (const link of links) {
      const age = now - (link.bornAt ?? now);
      if (age >= EDGE_AGE_MS) continue;
      const ageFactor = EDGE_AGE_FLOOR + (1 - EDGE_AGE_FLOOR) * (1 - age / EDGE_AGE_MS);
      const { color, intended } = edgeAppearance(link);
      ctx.strokeStyle = color;
      ctx.globalAlpha = intended * FLOW_BRIGHTNESS * ageFactor * TRAIL_FADE;
      ctx.beginPath();
      ctx.moveTo(link.source.x, link.source.y);
      ctx.lineTo(link.target.x, link.target.y);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    // -- Halos: additive glow drawn via the off-screen shadow trick ---------
    // The source shape sits SHADOW_OFFSET px off-canvas and only its blurred
    // shadow lands on screen — so the halo never stacks on the disc itself.
    // (shadow offset/blur are in device pixels, hence the dpr scaling.)
    for (const node of nodes) {
      const voiced = node.unit.avgPitchHz > 0;
      const color = voiced ? pitchToColor(node.unit.avgPitchHz) : UNVOICED_COLOR;
      // birthScale animates only the DRAWN radius; node.radius itself is
      // untouched so the physics (forceCollide) never feels the animation.
      const r = node.radius * birthScale(now - node.bornAt);
      ctx.shadowColor = color;
      ctx.shadowBlur = r * HALO_SIZE * this.dpr;
      ctx.shadowOffsetX = SHADOW_OFFSET * this.dpr;
      ctx.globalAlpha = HALO_BRIGHTNESS * TRAIL_FADE; // exposure control
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(node.x - SHADOW_OFFSET, node.y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.globalAlpha = 1;

    // -- Discs: normal compositing so the pitch color reads TRUE ------------
    ctx.globalCompositeOperation = 'source-over';
    for (const node of nodes) {
      const voiced = node.unit.avgPitchHz > 0;
      const r = node.radius * birthScale(now - node.bornAt); // drawn radius only
      ctx.fillStyle = voiced ? pitchToColor(node.unit.avgPitchHz) : UNVOICED_COLOR;
      ctx.beginPath();
      ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
      ctx.fill();

      // Faint hot core — suggests a light source without bleaching the color.
      ctx.fillStyle = `rgba(255, 255, 255, ${CORE_ALPHA})`;
      ctx.beginPath();
      ctx.arc(node.x, node.y, r * CORE_RADIUS, 0, Math.PI * 2);
      ctx.fill();
    }

    // -- Ripples: expanding ring on arrival (additive, transient) -----------
    ctx.globalCompositeOperation = 'lighter';
    for (const node of nodes) {
      const age = now - node.bornAt;
      if (age >= RIPPLE_MS) continue;
      const t = age / RIPPLE_MS;
      const voiced = node.unit.avgPitchHz > 0;
      ctx.strokeStyle = voiced ? pitchToColor(node.unit.avgPitchHz) : UNVOICED_COLOR;
      ctx.globalAlpha = (1 - t) * 0.6;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(node.x, node.y, node.radius + t * 44, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1;

    // -- Birth flash: a brief white burst as a node bursts into existence ----
    for (const node of nodes) {
      const age = now - node.bornAt;
      if (age >= FLASH_MS) continue;
      const t = age / FLASH_MS;
      ctx.fillStyle = 'rgb(255, 255, 255)';
      ctx.globalAlpha = (1 - t) * (1 - t) * 0.55; // bright, then a fast decay
      ctx.beginPath();
      ctx.arc(node.x, node.y, node.radius * (1.1 + t * 0.9), 0, Math.PI * 2);
      ctx.fill();
    }

    // -- Pulses: a spark travels each newborn edge, new node → other end -----
    // Every link's TARGET is the newer node (see graph.js addUnit), so the
    // spark lerps target → source. The trail veil leaves a comet tail behind
    // it for free. Links older than PULSE_MS cost one compare and a skip.
    for (const link of links) {
      const age = now - (link.bornAt ?? now);
      if (age >= PULSE_MS) continue;
      const t = age / PULSE_MS;
      const x = link.target.x + (link.source.x - link.target.x) * t;
      const y = link.target.y + (link.source.y - link.target.y) * t;
      const fade = 1 - t;
      // Soft colored bloom + hot white core (no shadowBlur — too costly here).
      ctx.fillStyle = edgeAppearance(link).color;
      ctx.globalAlpha = 0.35 * fade;
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgb(255, 255, 255)';
      ctx.globalAlpha = 0.9 * fade;
      ctx.beginPath();
      ctx.arc(x, y, 2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // -- Technical annotations: newest nodes only, fading with age ----------
    ctx.globalCompositeOperation = 'source-over';
    ctx.font = '9px Consolas, monospace';
    const recentFrom = Math.max(0, nodes.length - LABEL_RECENT);
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const age = now - node.bornAt;
      const isPinned = i >= recentFrom; // newest few never fade completely
      if (!isPinned && age >= LABEL_FADE_MS) continue;

      const fade = isPinned ? 1 : 1 - age / LABEL_FADE_MS;
      let hz = 'unv';
      if (node.unit.avgPitchHz > 0) {
        // Settle-in: count up toward the real value with a little jitter, so
        // the digits read like the instrument locking onto its measurement.
        const settle = Math.min(1, age / SETTLE_MS);
        const ease = 1 - (1 - settle) * (1 - settle); // fast start, soft landing
        let shown = node.unit.avgPitchHz * ease;
        if (settle < 1) shown += (Math.floor(age * 0.9) % 7) - 3; // digit scramble
        hz = `${Math.max(0, shown).toFixed(0)}Hz`;
      }
      const tag = `U${String(node.id).padStart(3, '0')} ${hz}`;
      const x = node.x + node.radius + 5;
      const y = node.y - node.radius - 3;
      // Newest node gets the instrument-green accent; the rest stay dim ink.
      ctx.fillStyle =
        i === nodes.length - 1
          ? `rgba(78, 250, 192, ${0.9 * fade})`
          : `rgba(255, 255, 255, ${0.34 * fade})`;
      ctx.fillText(tag, x, y);
      // A tiny leader line from disc edge to label, like a callout.
      ctx.strokeStyle = `rgba(255, 255, 255, ${0.14 * fade})`;
      ctx.beginPath();
      ctx.moveTo(node.x + node.radius * 0.75, node.y - node.radius * 0.75);
      ctx.lineTo(x - 2, y + 2);
      ctx.stroke();
    }
  }
}
