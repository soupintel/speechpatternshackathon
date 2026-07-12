// trajectory.js — the artwork's data model since the 3D pivot: the path the
// voice traces through acoustic feature space, stored as a RECURRENCE GRAPH.
//
// Each accepted audio frame lands at a 3D position:
//   X = spectral centroid (Hz)      "brightness"
//   Y = spectral spread   (Hz)      "narrow hum … wide hiss"
//   Z = log(spectral crest)         "noisy … pure-tone"  (log because crest
//       spans ~3× to ~100×; raw, the vowels would crush everything else
//       into the cube's floor)
//
// RECURRENCE: if the new frame lands within MERGE_RADIUS of an existing
// node, that node is REVISITED — its weight grows, its position eases toward
// the running average of its visits, and the connection walked to reach it
// strengthens — instead of spawning a near-duplicate point. This is how
// bird-song visualizers work: repeating a sound re-lights the same part of
// the constellation rather than fogging it with copies. (Measurement noise
// means a repeated sound never lands on the exact same coordinates, so
// without the radius no node would ever be reused.)
//
// The graph therefore holds:
//   nodes[]  — places the voice has been: raw features + visit weight/times
//   edges[]  — transitions between places, with a use count
//   recent[] — the last few seconds of the walk, for the comet trail
//
// Raw features are stored, not screen positions. The axis BOUNDS auto-
// calibrate: once a second they ease toward the 5th–95th percentile of all
// nodes, PLUS headroom padding, so the cube frames the voice with margin —
// extreme sounds land inside the walls instead of flattening onto them.

// Accept at most one frame per MIN_GAP_MS (~20/sec). Speech doesn't change
// meaningfully faster, and it bounds the graph's growth rate.
const MIN_GAP_MS = 50;

// A silence longer than this "lifts the pen": the next node starts a new
// stroke, with no edge drawn across the gap.
const GAP_BREAK_MS = 500;

// Light exponential smoothing on the raw features (0 = frozen, 1 = raw).
// Per-frame FFT estimates jitter; smoothing turns scribble into a path.
const SMOOTH = 0.35;

// Merge radius, in NORMALIZED cube space (each axis spans 2). 0.16 ≈ 8% of
// an axis: about the scatter that mic noise puts on a repeated sound.
// Smaller = more duplicate nodes; larger = distinct sounds start merging.
const MERGE_RADIUS = 0.16;

// Auto-calibration: recompute percentile bounds this often, once there is
// enough data, easing by CAL_EASE per step. BOUND_PAD adds headroom beyond
// the percentiles so points rarely clamp flat onto the cube faces.
const CAL_INTERVAL_MS = 1000;
const CAL_MIN_POINTS = 24;
const P_LO = 0.05;
const P_HI = 0.95;
const CAL_EASE = 0.25;
const BOUND_PAD = 0.15; // fraction of the percentile span added to each side

// Node cap: past this the graph stops creating nodes and only reuses the
// nearest existing one — the artwork saturates instead of growing unbounded.
// (With merging, ordinary speech takes a very long time to get here.)
const MAX_NODES = 4000;

// Comet-trail memory: how many walk steps to remember (~6 s at 20/s).
const RECENT_MAX = 120;

// Provisional bounds used until enough real data arrives (Phase A logs).
const INITIAL_BOUNDS = {
  cent: { min: 300, max: 2500 },
  sprd: { min: 200, max: 1500 },
  zlog: { min: Math.log(4), max: Math.log(60) },
};

export class Trajectory {
  constructor() {
    this.clear();
  }

  clear() {
    this.nodes = [];
    this.edges = [];
    this._edgeMap = new Map(); // "a-b" (a<b) → edge, for O(1) reuse lookup
    this.recent = []; // { idx, t, gap } — the walk, newest last
    // Deep copy so a session can't mutate the defaults for the next one.
    this.bounds = {
      cent: { ...INITIAL_BOUNDS.cent },
      sprd: { ...INITIAL_BOUNDS.sprd },
      zlog: { ...INITIAL_BOUNDS.zlog },
    };
    this.lastAddAt = -Infinity;
    this.lastCalAt = 0;
    this._ema = null; // smoothed feature state, reset across stroke breaks
    this._prevIdx = -1; // node the walk is currently standing on
  }

  // Feed one audio frame. spectral is null during silence (see spectral.js).
  // Returns true if the graph changed (node created OR revisited).
  addFrame(nowMs, spectral, pitchHz) {
    if (!spectral) return false;
    if (nowMs - this.lastAddAt < MIN_GAP_MS) return false;

    const gap = this.nodes.length > 0 && nowMs - this.lastAddAt > GAP_BREAK_MS;
    this.lastAddAt = nowMs;

    const raw = {
      cent: spectral.centroidHz,
      sprd: spectral.spreadHz,
      zlog: Math.log(spectral.crest),
    };
    // Restart smoothing after a break — the voice really did jump.
    if (!this._ema || gap) {
      this._ema = { ...raw };
    } else {
      this._ema.cent += SMOOTH * (raw.cent - this._ema.cent);
      this._ema.sprd += SMOOTH * (raw.sprd - this._ema.sprd);
      this._ema.zlog += SMOOTH * (raw.zlog - this._ema.zlog);
    }

    // -- Recurrence check: has the voice been (near) here before? ----------
    let idx = this._nearestWithin(this._ema, MERGE_RADIUS);
    if (idx < 0 && this.nodes.length >= MAX_NODES) {
      idx = this._nearestWithin(this._ema, Infinity); // saturated: reuse anyway
    }

    if (idx >= 0) {
      // Revisit: strengthen the node and ease it toward the running average
      // of everywhere its visits actually landed.
      const node = this.nodes[idx];
      node.weight += 1;
      node.lastAt = nowMs;
      node.cent += (this._ema.cent - node.cent) / node.weight;
      node.sprd += (this._ema.sprd - node.sprd) / node.weight;
      node.zlog += (this._ema.zlog - node.zlog) / node.weight;
      if (pitchHz > 0) node.pitchHz = pitchHz; // keep the freshest pitch
    } else {
      // New territory: a new node.
      idx = this.nodes.length;
      this.nodes.push({
        cent: this._ema.cent,
        sprd: this._ema.sprd,
        zlog: this._ema.zlog,
        pitchHz,
        bornAt: nowMs,
        lastAt: nowMs,
        weight: 1,
      });
    }

    // -- Edge: the step that got us here (not across silences/self-loops) --
    if (this._prevIdx >= 0 && !gap && this._prevIdx !== idx) {
      const a = Math.min(this._prevIdx, idx);
      const b = Math.max(this._prevIdx, idx);
      const key = `${a}-${b}`;
      let edge = this._edgeMap.get(key);
      if (!edge) {
        edge = { a, b, count: 0, lastAt: nowMs };
        this._edgeMap.set(key, edge);
        this.edges.push(edge);
      }
      edge.count += 1;
      edge.lastAt = nowMs;
    }
    this._prevIdx = idx;

    // -- Walk memory for the comet trail ------------------------------------
    this.recent.push({ idx, t: nowMs, gap });
    if (this.recent.length > RECENT_MAX) this.recent.shift();

    if (
      this.nodes.length >= CAL_MIN_POINTS &&
      nowMs - this.lastCalAt >= CAL_INTERVAL_MS
    ) {
      this._recalibrate();
      this.lastCalAt = nowMs;
    }
    return true;
  }

  // Index of the nearest node within `radius` (normalized-space distance
  // through the CURRENT bounds), or -1. Linear scan: even at the node cap
  // this is a few thousand subtractions, 20× a second — nothing.
  _nearestWithin(f, radius) {
    const { cent, sprd, zlog } = this.bounds;
    const fx = normUnclamped(f.cent, cent);
    const fy = normUnclamped(f.sprd, sprd);
    const fz = normUnclamped(f.zlog, zlog);
    let best = -1;
    let bestD2 = radius * radius;
    for (let i = 0; i < this.nodes.length; i++) {
      const n = this.nodes[i];
      const dx = normUnclamped(n.cent, cent) - fx;
      const dy = normUnclamped(n.sprd, sprd) - fy;
      const dz = normUnclamped(n.zlog, zlog) - fz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = i;
      }
    }
    return best;
  }

  // Ease each axis's bounds toward the 5th–95th percentile of all nodes,
  // widened by BOUND_PAD headroom. Percentiles (not min/max) so one squeal
  // or thump can't permanently squash the artwork into a corner; the padding
  // keeps ordinary extremes off the cube walls instead of clamped flat
  // against them.
  _recalibrate() {
    for (const key of ['cent', 'sprd', 'zlog']) {
      const values = this.nodes.map((n) => n[key]).sort((a, b) => a - b);
      const lo = values[Math.floor(P_LO * (values.length - 1))];
      const hi = values[Math.floor(P_HI * (values.length - 1))];
      const pad = (hi - lo) * BOUND_PAD;
      const b = this.bounds[key];
      b.min += CAL_EASE * (lo - pad - b.min);
      b.max += CAL_EASE * (hi + pad - b.max);
      // Degenerate guard: a monotone voice could collapse an axis to a point.
      if (b.max - b.min < 1e-6) b.max = b.min + 1e-6;
    }
  }
}

// value → position through {min, max} on a [-1, 1] scale, NOT clamped —
// distances need honest geometry even slightly outside the cube.
function normUnclamped(value, b) {
  return ((value - b.min) / (b.max - b.min)) * 2 - 1;
}
