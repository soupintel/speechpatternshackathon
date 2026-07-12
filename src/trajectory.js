// trajectory.js — the artwork's data model since the 3D pivot: the path the
// voice traces through acoustic feature space.
//
// Each accepted audio frame becomes one point:
//   X = spectral centroid (Hz)      "brightness"
//   Y = spectral spread   (Hz)      "narrow hum … wide hiss"
//   Z = log(spectral crest)         "noisy … pure-tone"  (log because crest
//       spans ~3× to ~100×; raw, the vowels would crush everything else
//       into the cube's floor — Phase A measured crest ≈ 38 on a plain vowel)
//
// Raw features are stored, not screen positions. The axis BOUNDS auto-
// calibrate: once a second we take the 5th–95th percentile of everything
// said so far and ease the bounds toward it, so the cube always frames the
// middle 90% of this session's voice. The renderer normalizes raw → [-1,1]
// through these bounds every frame, which means the whole constellation
// gently re-frames itself as the instrument learns the speaker's range.

// Accept at most one point per MIN_GAP_MS (~20/sec). Speech doesn't change
// meaningfully faster, and a 2-minute session stays ~2,400 points instead of
// 7,200 — well inside what canvas can sort and draw per frame.
const MIN_GAP_MS = 50;

// A silence longer than this "lifts the pen": the next point starts a new
// stroke instead of drawing a long straight chord across the cube.
const GAP_BREAK_MS = 500;

// Light exponential smoothing on the raw features (0 = frozen, 1 = raw).
// Per-frame FFT estimates jitter; smoothing turns scribble into a path.
const SMOOTH = 0.35;

// Auto-calibration: recompute percentile bounds this often, once there is
// enough data to make percentiles meaningful, easing by CAL_EASE per step.
const CAL_INTERVAL_MS = 1000;
const CAL_MIN_POINTS = 24;
const P_LO = 0.05;
const P_HI = 0.95;
const CAL_EASE = 0.25;

// Hard cap so a very long session can't grow unbounded; oldest points fall
// off the tail (the artwork "forgets" only after ~3.5 min of pure speech).
const MAX_POINTS = 4000;

// Provisional bounds used until enough real data arrives (from Phase A logs).
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
    this.points = [];
    // Deep copy so a session can't mutate the defaults for the next one.
    this.bounds = {
      cent: { ...INITIAL_BOUNDS.cent },
      sprd: { ...INITIAL_BOUNDS.sprd },
      zlog: { ...INITIAL_BOUNDS.zlog },
    };
    this.lastAddAt = -Infinity;
    this.lastCalAt = 0;
    this._ema = null; // smoothed feature state, reset across stroke breaks
  }

  // Feed one audio frame. spectral is null during silence (see spectral.js).
  // Returns true if a point was added.
  addFrame(nowMs, spectral, pitchHz) {
    if (!spectral) return false;
    if (nowMs - this.lastAddAt < MIN_GAP_MS) return false;

    const gapBefore =
      this.points.length > 0 && nowMs - this.lastAddAt > GAP_BREAK_MS;

    const raw = {
      cent: spectral.centroidHz,
      sprd: spectral.spreadHz,
      zlog: Math.log(spectral.crest),
    };
    // Restart smoothing after a break — the voice really did jump.
    if (!this._ema || gapBefore) {
      this._ema = { ...raw };
    } else {
      this._ema.cent += SMOOTH * (raw.cent - this._ema.cent);
      this._ema.sprd += SMOOTH * (raw.sprd - this._ema.sprd);
      this._ema.zlog += SMOOTH * (raw.zlog - this._ema.zlog);
    }

    this.points.push({
      cent: this._ema.cent,
      sprd: this._ema.sprd,
      zlog: this._ema.zlog,
      flux: spectral.flux, // not an axis yet; kept for color/mode later
      pitchHz,
      t: nowMs,
      gapBefore,
    });
    if (this.points.length > MAX_POINTS) {
      this.points.splice(0, this.points.length - MAX_POINTS);
      this.points[0].gapBefore = false; // new oldest point starts its stroke
    }
    this.lastAddAt = nowMs;

    if (
      this.points.length >= CAL_MIN_POINTS &&
      nowMs - this.lastCalAt >= CAL_INTERVAL_MS
    ) {
      this._recalibrate();
      this.lastCalAt = nowMs;
    }
    return true;
  }

  // Ease each axis's bounds toward the 5th–95th percentile of all stored
  // values. Percentiles (not min/max) so one squeal or thump early in the
  // session can't permanently squash the whole artwork into a corner.
  _recalibrate() {
    for (const key of ['cent', 'sprd', 'zlog']) {
      const values = this.points.map((p) => p[key]).sort((a, b) => a - b);
      const lo = values[Math.floor(P_LO * (values.length - 1))];
      const hi = values[Math.floor(P_HI * (values.length - 1))];
      const b = this.bounds[key];
      b.min += CAL_EASE * (lo - b.min);
      b.max += CAL_EASE * (hi - b.max);
      // Degenerate guard: a monotone voice could collapse an axis to a point.
      if (b.max - b.min < 1e-6) b.max = b.min + 1e-6;
    }
  }
}
