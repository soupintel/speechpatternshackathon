// render3d.js — Phase B renderer: the trajectory as plain points and lines
// inside a slowly rotating wireframe axis cube. DELIBERATELY unstyled — the
// job of this phase is to verify the projection and the motion, so any bug
// is a geometry bug, not a glow hiding one. The visual language (glow,
// trails, HUD annotations) returns in Phase C on top of this.
//
// Draw order each frame:
//   1. solid background clear (no trails yet)
//   2. wireframe cube + axis labels (behind everything, it's the "room")
//   3. the trajectory polyline, oldest → newest, lifting the pen at breaks
//   4. the points, depth-sorted far → near so near dots overdraw far ones
//
// The render loop is the app's single timing source (same rule as the 2D
// renderer had): it advances the camera angle by real elapsed time.

import { project } from './projection.js';

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
const LINE_COLOR = 'rgba(150, 180, 255, 0.45)';
const POINT_COLOR = 'rgb(230, 235, 255)';
const POINT_RADIUS = 2.2; // px at scale 1, before perspective

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

// The three edges leaving corner 0 (-1,-1,-1) are the labeled axes.
const AXES = [
  { to: 1, label: 'CENTROID →', tip: [1.28, -1, -1] }, // +X
  { to: 2, label: 'SPREAD →', tip: [-1, 1.22, -1] }, // +Y
  { to: 4, label: 'CREST →', tip: [-1, -1, 1.28] }, // +Z
];

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
    this._order = []; // point indices, sorted far → near
    this._out = { x: 0, y: 0, scale: 0, depth: 0 }; // project() target
    this._reach = measureReach(); // {side, up, down} in cube units

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
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, w, h);

    // -- 2. Wireframe cube + axis labels -------------------------------------
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

    ctx.strokeStyle = AXIS_COLOR;
    ctx.fillStyle = LABEL_COLOR;
    ctx.font = '10px Consolas, monospace';
    for (const axis of AXES) {
      ctx.beginPath();
      ctx.moveTo(cxs[0], cys[0]);
      ctx.lineTo(cxs[axis.to], cys[axis.to]);
      ctx.stroke();
      const [tx, ty, tz] = axis.tip;
      project(tx, ty, tz, cosA, sinA, cx, cy, viewScale, out);
      ctx.fillText(axis.label, out.x - 20, out.y);
    }

    // -- Project every trajectory point --------------------------------------
    const { points, bounds } = this.trajectory;
    const n = points.length;
    if (n === 0) return;
    if (this._px.length < n) {
      const cap = Math.max(n, this._px.length * 2);
      this._px = new Float32Array(cap);
      this._py = new Float32Array(cap);
      this._ps = new Float32Array(cap);
      this._pd = new Float32Array(cap);
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
    }

    // -- 3. The trajectory line, in time order -------------------------------
    ctx.strokeStyle = LINE_COLOR;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      if (i === 0 || points[i].gapBefore) ctx.moveTo(this._px[i], this._py[i]);
      else ctx.lineTo(this._px[i], this._py[i]);
    }
    ctx.stroke();

    // -- 4. The points, far → near --------------------------------------------
    if (this._order.length !== n) {
      this._order = Array.from({ length: n }, (_, i) => i);
    }
    const pd = this._pd;
    this._order.sort((a, b) => pd[b] - pd[a]); // biggest depth = farthest = first
    ctx.fillStyle = POINT_COLOR;
    for (const i of this._order) {
      const r = POINT_RADIUS * this._ps[i];
      ctx.beginPath();
      ctx.arc(this._px[i], this._py[i], r, 0, Math.PI * 2);
      ctx.fill();
    }
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
