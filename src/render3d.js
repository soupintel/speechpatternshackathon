// render3d.js — draws the voice's trajectory through feature space inside a
// slowly rotating axis cube. Phase C: the visual language from the 2D
// constellation, rebuilt for 3D:
//
//   GLOW — pre-rendered radial-gradient sprites stamped per point in
//     'lighter' (additive) mode. NOT shadowBlur: that was fine for dozens of
//     nodes, but at thousands of points it stalls the GPU; a cached sprite
//     costs one drawImage. Sprites are tinted per pitch BUCKET (24 steps
//     across the palette) so the cache stays tiny.
//   COMET TRAIL — no translucent-veil trick this time: the camera rotates,
//     so a veil would smear the entire scene into mud. Instead the newest
//     ~2.5 s of the path is drawn again, brighter, fading with age — a comet
//     head at the live end that works at any rotation speed.
//   DEPTH CUEING — near points draw larger (perspective) AND brighter; far
//     points recede. This contrast is what makes the rotation read as a 3D
//     body instead of a flat scribble.
//   AGING — points settle toward a dim floor over a minute, so recent speech
//     is bright and old speech becomes the constellation's background.
//   COLOR — pitch, through the same palette as the 2D build. Pitch is the
//     one meaningful feature that is NOT an axis, so color carries it.
//   ANNOTATIONS — the axis labels show their LIVE calibrated ranges (the
//     instrument displays its own calibration), and the head point gets a
//     technical callout whose digits settle in, ported from the 2D build.
//
// Draw order each frame:
//   1. solid clear   2. cube + labeled axes   3. base path (time order)
//   4. comet overlay + glows (additive)   5. core dots (true color, near
//   over far)   6. head callout.

import { project, CAMERA_DIST } from './projection.js';
import { pitchT, pitchToColor, UNVOICED_COLOR } from './palette.js';
import { PITCH_COLOR_MIN, PITCH_COLOR_MAX } from './palette.js';

const BACKGROUND = '#050505';
const ROTATE_SPEED = 0.00022; // radians per ms ≈ one full turn every ~48 s

// Framing: the cube is fitted into the space BELOW the HUD strip and scaled
// so nothing can ever leave the screen at any rotation angle. How far the
// cube can reach from its center is not symmetric — the tilt hangs the near
// corners low, and perspective magnifies exactly those — so instead of
// guessing, the constructor MEASURES the reach by sweeping one full
// rotation (see measureReach below).
const HUD_CLEARANCE = 150; // px reserved for the HUD strip at the top
const EDGE_MARGIN = 20; // px breathing room at the other screen edges

const CUBE_COLOR = 'rgba(255, 255, 255, 0.10)';
const AXIS_COLOR = 'rgba(78, 250, 192, 0.35)'; // the three labeled edges
const LABEL_COLOR = 'rgba(78, 250, 192, 0.7)';
const RANGE_COLOR = 'rgba(78, 250, 192, 0.4)'; // live calibration readouts
const LINE_ALPHA = 0.2; // the base path, constant and cheap
const LINE_COLOR = `rgba(150, 180, 255, ${LINE_ALPHA})`;

const POINT_RADIUS = 2.1; // px at perspective scale 1

// Depth cue: map the perspective scale (known min/max inside the cube) to a
// brightness factor, so distance is encoded twice — size and light.
const PERSP_MIN = CAMERA_DIST / (CAMERA_DIST + Math.sqrt(3));
const PERSP_MAX = CAMERA_DIST / (CAMERA_DIST - Math.sqrt(3));
const DEPTH_FLOOR = 0.3; // brightness of the farthest point

// Aging: brightness multiplier decays 1 → floor over AGE_MS.
const AGE_MS = 60000;
const AGE_FLOOR = 0.35;

// Comet trail: the path's newest span redrawn brighter, fading with age.
const TRAIL_MS = 2500;
const TRAIL_ALPHA = 0.75;

// Glow sprites.
const PITCH_BUCKETS = 24;
const SPRITE_PX = 64; // sprite bitmap resolution (scaled at draw time)
const GLOW_EXTENT = 4.5; // glow radius as a multiple of the point radius
const GLOW_ALPHA = 0.5;

// Head-point theatrics, ported from the 2D build: scale-in with a slight
// overshoot, a white flash, and digits that count up as they "lock on".
const BIRTH_MS = 260;
const FLASH_MS = 320;
const SETTLE_MS = 180;
const BACK = 2.4;
function birthScale(age) {
  if (age >= BIRTH_MS) return 1;
  const u = age / BIRTH_MS - 1; // runs -1 → 0
  return 1 + u * u * ((BACK + 1) * u + BACK);
}

// The 8 corners of the [-1,1]³ cube and the 12 edges between them
// (each corner index is a 3-bit number: bit0 = x+, bit1 = y+, bit2 = z+;
// an edge connects corners that differ in exactly one bit).
const CORNERS = [];
for (let i = 0; i < 8; i++) {
  CORNERS.push([(i & 1) * 2 - 1, ((i >> 1) & 1) * 2 - 1, ((i >> 2) & 1) * 2 - 1]);
}
const EDGES = [];
for (let a = 0; a < 8; a++) {
  for (const bit of [1, 2, 4]) {
    const b = a ^ bit;
    if (a < b) EDGES.push([a, b]);
  }
}

// The three edges leaving corner 0 (-1,-1,-1) are the labeled axes. `key`
// picks which trajectory bound this axis reports as its live range.
const AXES = [
  { to: 1, label: 'CENTROID →', tip: [1.28, -1, -1], key: 'cent' },
  { to: 2, label: 'SPREAD →', tip: [-1, 1.22, -1], key: 'sprd' },
  { to: 4, label: 'CREST →', tip: [-1, -1, 1.28], key: 'zlog' },
];

// One quantized color per pitch bucket (plus unvoiced), computed once. The
// bucket center pitch inverts the palette's log mapping. Quantized colors
// mean zero string allocation per frame and one cached sprite per bucket.
const BUCKET_COLORS = [];
for (let i = 0; i < PITCH_BUCKETS; i++) {
  const t = i / (PITCH_BUCKETS - 1);
  const pitch =
    Math.exp(
      Math.log(PITCH_COLOR_MIN) +
        t * (Math.log(PITCH_COLOR_MAX) - Math.log(PITCH_COLOR_MIN)),
    );
  BUCKET_COLORS.push(pitchToColor(pitch));
}
function bucketOf(pitchHz) {
  if (!(pitchHz > 0)) return -1; // unvoiced
  return Math.round(pitchT(pitchHz) * (PITCH_BUCKETS - 1));
}

export class Renderer3D {
  constructor(canvas, trajectory) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.trajectory = trajectory;
    this.rafId = null;
    this.dpr = 1;
    this.angle = 0;
    this.lastNow = 0;

    // Scratch buffers reused every frame (grown on demand) so the render
    // loop allocates nothing — same discipline as spectral.js/audio.js.
    this._px = new Float32Array(256); // projected screen x, per point
    this._py = new Float32Array(256);
    this._ps = new Float32Array(256); // perspective scale
    this._pd = new Float32Array(256); // depth (for sorting)
    this._pa = new Float32Array(256); // depth-cue brightness factor
    this._order = []; // point indices, sorted far → near
    this._out = { x: 0, y: 0, scale: 0, depth: 0 }; // project() target
    this._reach = measureReach(); // {side, up, down} in cube units

    // Glow sprites, one per pitch bucket + one for unvoiced, built lazily
    // (most sessions only ever touch a handful of buckets).
    this._sprites = new Array(PITCH_BUCKETS).fill(null);
    this._unvoicedSprite = null;

    this._resize = this._resize.bind(this);
    window.addEventListener('resize', this._resize);
    this._resize();
  }

  _resize() {
    this.dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); // CSS-pixel coords
  }

  start() {
    if (this.rafId !== null) return;
    this.lastNow = performance.now();
    const loop = () => {
      this.draw();
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  stop() {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  _spriteFor(bucket) {
    if (bucket < 0) {
      if (!this._unvoicedSprite) {
        this._unvoicedSprite = makeGlowSprite(UNVOICED_COLOR);
      }
      return this._unvoicedSprite;
    }
    if (!this._sprites[bucket]) {
      this._sprites[bucket] = makeGlowSprite(BUCKET_COLORS[bucket]);
    }
    return this._sprites[bucket];
  }

  draw() {
    const ctx = this.ctx;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const now = performance.now();

    // Advance the camera by real elapsed time so rotation speed doesn't
    // depend on the display's frame rate.
    this.angle += ROTATE_SPEED * (now - this.lastNow);
    this.lastNow = now;
    const cosA = Math.cos(this.angle);
    const sinA = Math.sin(this.angle);

    // Fit the measured reach into the available area; whichever dimension is
    // tighter sets the scale, and the cube is centred in the leftover space.
    const reach = this._reach;
    const availH = h - HUD_CLEARANCE - 2 * EDGE_MARGIN;
    const viewScale = Math.min(
      availH / (reach.up + reach.down),
      (w / 2 - EDGE_MARGIN) / reach.side,
    );
    const cx = w / 2;
    const cy =
      HUD_CLEARANCE +
      EDGE_MARGIN +
      (availH - (reach.up + reach.down) * viewScale) / 2 +
      reach.up * viewScale;
    const out = this._out;

    // -- 1. Clear ------------------------------------------------------------
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, w, h);

    // -- 2. Wireframe cube + labeled axes with live calibration ranges -------
    const cxs = [];
    const cys = [];
    for (let i = 0; i < 8; i++) {
      const c = CORNERS[i];
      project(c[0], c[1], c[2], cosA, sinA, cx, cy, viewScale, out);
      cxs.push(out.x);
      cys.push(out.y);
    }
    ctx.lineWidth = 1;
    ctx.strokeStyle = CUBE_COLOR;
    ctx.beginPath();
    for (const [a, b] of EDGES) {
      ctx.moveTo(cxs[a], cys[a]);
      ctx.lineTo(cxs[b], cys[b]);
    }
    ctx.stroke();

    const bounds = this.trajectory.bounds;
    ctx.strokeStyle = AXIS_COLOR;
    ctx.font = '10px Consolas, monospace';
    for (const axis of AXES) {
      ctx.beginPath();
      ctx.moveTo(cxs[0], cys[0]);
      ctx.lineTo(cxs[axis.to], cys[axis.to]);
      ctx.stroke();
      const [tx, ty, tz] = axis.tip;
      project(tx, ty, tz, cosA, sinA, cx, cy, viewScale, out);
      ctx.fillStyle = LABEL_COLOR;
      ctx.fillText(axis.label, out.x - 20, out.y);
      // Live range: the axes show what the instrument has calibrated to.
      const b = bounds[axis.key];
      const range =
        axis.key === 'zlog'
          ? `${Math.exp(b.min).toFixed(0)}…${Math.exp(b.max).toFixed(0)}×`
          : `${b.min.toFixed(0)}…${b.max.toFixed(0)}Hz`;
      ctx.fillStyle = RANGE_COLOR;
      ctx.fillText(range, out.x - 20, out.y + 12);
    }

    // -- Project every trajectory point --------------------------------------
    const { points } = this.trajectory;
    const n = points.length;
    if (n === 0) return;
    if (this._px.length < n) {
      const cap = Math.max(n, this._px.length * 2);
      this._px = new Float32Array(cap);
      this._py = new Float32Array(cap);
      this._ps = new Float32Array(cap);
      this._pd = new Float32Array(cap);
      this._pa = new Float32Array(cap);
    }
    // Normalize raw features → [-1,1] through the live auto-calibrated
    // bounds (clamped: out-of-range values pin to the cube face rather than
    // drawing outside the room).
    const bc = bounds.cent;
    const bs = bounds.sprd;
    const bz = bounds.zlog;
    for (let i = 0; i < n; i++) {
      const p = points[i];
      const x = norm(p.cent, bc);
      const y = norm(p.sprd, bs);
      const z = norm(p.zlog, bz);
      project(x, y, z, cosA, sinA, cx, cy, viewScale, out);
      this._px[i] = out.x;
      this._py[i] = out.y;
      this._ps[i] = out.scale;
      this._pd[i] = out.depth;
      // Depth cue factor: nearest = 1, farthest = DEPTH_FLOOR.
      const dt = (out.scale - PERSP_MIN) / (PERSP_MAX - PERSP_MIN);
      this._pa[i] = DEPTH_FLOOR + (1 - DEPTH_FLOOR) * Math.min(1, Math.max(0, dt));
    }

    // -- 3. Base path, oldest → newest, lifting the pen at breaks ------------
    ctx.strokeStyle = LINE_COLOR;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      if (i === 0 || points[i].gapBefore) ctx.moveTo(this._px[i], this._py[i]);
      else ctx.lineTo(this._px[i], this._py[i]);
    }
    ctx.stroke();

    // -- 4. Additive light: comet overlay, then glows -------------------------
    ctx.globalCompositeOperation = 'lighter';

    // Comet: walk back from the head while segments are young enough.
    ctx.lineWidth = 1.6;
    for (let i = n - 1; i > 0; i--) {
      const age = now - points[i].t;
      if (age >= TRAIL_MS) break;
      if (points[i].gapBefore) continue; // pen was lifted — no segment here
      const bucket = bucketOf(points[i].pitchHz);
      ctx.strokeStyle = bucket < 0 ? UNVOICED_COLOR : BUCKET_COLORS[bucket];
      ctx.globalAlpha =
        TRAIL_ALPHA * (1 - age / TRAIL_MS) * this._pa[i];
      ctx.beginPath();
      ctx.moveTo(this._px[i - 1], this._py[i - 1]);
      ctx.lineTo(this._px[i], this._py[i]);
      ctx.stroke();
    }
    ctx.lineWidth = 1;

    // Depth-sort far → near, shared by the glow and dot passes.
    if (this._order.length !== n) {
      this._order = Array.from({ length: n }, (_, i) => i);
    }
    const pd = this._pd;
    this._order.sort((a, b) => pd[b] - pd[a]); // biggest depth = farthest first

    // Glows: one sprite stamp per point.
    for (const i of this._order) {
      const p = points[i];
      const age = now - p.t;
      const ageFactor = AGE_FLOOR + (1 - AGE_FLOOR) * Math.max(0, 1 - age / AGE_MS);
      const r =
        POINT_RADIUS * GLOW_EXTENT * this._ps[i] * (i === n - 1 ? birthScale(age) : 1);
      ctx.globalAlpha = GLOW_ALPHA * this._pa[i] * ageFactor;
      ctx.drawImage(this._spriteFor(bucketOf(p.pitchHz)), this._px[i] - r, this._py[i] - r, r * 2, r * 2);
    }

    // -- 5. Core dots: true color, normal compositing, near over far ---------
    ctx.globalCompositeOperation = 'source-over';
    for (const i of this._order) {
      const p = points[i];
      const age = now - p.t;
      const ageFactor = AGE_FLOOR + (1 - AGE_FLOOR) * Math.max(0, 1 - age / AGE_MS);
      const bucket = bucketOf(p.pitchHz);
      const r = POINT_RADIUS * this._ps[i] * (i === n - 1 ? birthScale(age) : 1);
      ctx.fillStyle = bucket < 0 ? UNVOICED_COLOR : BUCKET_COLORS[bucket];
      ctx.globalAlpha = Math.min(1, (0.35 + 0.65 * this._pa[i]) * (0.5 + 0.5 * ageFactor));
      ctx.beginPath();
      ctx.arc(this._px[i], this._py[i], r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // -- 6. Head callout: the newest reading, digits settling in -------------
    const head = n - 1;
    const hp = points[head];
    const headAge = now - hp.t;

    // Birth flash — a brief white pop as the newest point lands.
    if (headAge < FLASH_MS) {
      const t = headAge / FLASH_MS;
      ctx.fillStyle = 'rgb(255, 255, 255)';
      ctx.globalAlpha = (1 - t) * (1 - t) * 0.55;
      ctx.beginPath();
      ctx.arc(
        this._px[head],
        this._py[head],
        POINT_RADIUS * this._ps[head] * (1.2 + t),
        0,
        Math.PI * 2,
      );
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // Callout text: count up toward the real centroid with a little jitter,
    // so the digits read like the instrument locking onto its measurement.
    const settle = Math.min(1, headAge / SETTLE_MS);
    const ease = 1 - (1 - settle) * (1 - settle);
    let shown = hp.cent * ease;
    if (settle < 1) shown += (Math.floor(headAge * 0.9) % 7) - 3;
    const tag = `P${String(head).padStart(4, '0')} ${Math.max(0, shown).toFixed(0)}Hz`;
    const lx = this._px[head] + 9;
    const ly = this._py[head] - 9;
    ctx.font = '9px Consolas, monospace';
    ctx.fillStyle = 'rgba(78, 250, 192, 0.9)';
    ctx.fillText(tag, lx, ly);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
    ctx.beginPath();
    ctx.moveTo(this._px[head] + 3, this._py[head] - 3);
    ctx.lineTo(lx - 2, ly + 2);
    ctx.stroke();
  }
}

// value → [-1, 1] through {min, max}, clamped.
function norm(value, b) {
  const t = (value - b.min) / (b.max - b.min);
  return Math.max(-1, Math.min(1, t * 2 - 1));
}

// Sweep one full camera rotation and record the farthest any cube corner or
// axis-label tip lands from the screen center (projected at viewScale 1).
// Runs once at startup; the result makes the framing exact instead of a
// guess, and stays correct if the tilt or camera distance is ever retuned.
function measureReach() {
  const pts = CORNERS.concat(AXES.map((a) => a.tip));
  const out = { x: 0, y: 0, scale: 0, depth: 0 };
  let side = 0;
  let up = 0;
  let down = 0;
  const STEPS = 256;
  for (let k = 0; k < STEPS; k++) {
    const a = (k / STEPS) * Math.PI * 2;
    const cosA = Math.cos(a);
    const sinA = Math.sin(a);
    for (const [x, y, z] of pts) {
      project(x, y, z, cosA, sinA, 0, 0, 1, out);
      side = Math.max(side, Math.abs(out.x));
      up = Math.max(up, -out.y); // screen-up is negative y
      down = Math.max(down, out.y);
    }
  }
  // A hair of slack for the point radius / label text height.
  return { side: side * 1.02, up: up * 1.02, down: down * 1.02 };
}

// A soft round glow: bright tinted center falling off to transparent. Drawn
// once to a small offscreen canvas; the render loop just stamps it scaled.
function makeGlowSprite(color) {
  const c = document.createElement('canvas');
  c.width = SPRITE_PX;
  c.height = SPRITE_PX;
  const g = c.getContext('2d');
  const half = SPRITE_PX / 2;
  const grad = g.createRadialGradient(half, half, 0, half, half, half);
  grad.addColorStop(0, withAlpha(color, 0.85));
  grad.addColorStop(0.3, withAlpha(color, 0.35));
  grad.addColorStop(1, withAlpha(color, 0));
  g.fillStyle = grad;
  g.fillRect(0, 0, SPRITE_PX, SPRITE_PX);
  return c;
}

// Add an alpha to the two color formats the palette produces:
// 'hsl(h, s%, l%)' strings and '#rgb'/'#rrggbb' hex.
function withAlpha(color, alpha) {
  if (color.startsWith('hsl(')) {
    return `hsla(${color.slice(4, -1)}, ${alpha})`;
  }
  let hex = color.slice(1);
  if (hex.length === 3) hex = hex.replace(/./g, (ch) => ch + ch);
  const num = parseInt(hex, 16);
  return `rgba(${(num >> 16) & 255}, ${(num >> 8) & 255}, ${num & 255}, ${alpha})`;
}
