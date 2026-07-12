// spectral.js — Phase A spectral feature engine for the 3D trajectory pivot.
//
// Every animation frame, audio.js hands us the analyser's magnitude spectrum
// (the FFT the browser already computed). From it we derive four numbers that
// describe the SHAPE of the sound at that instant:
//
//   CENTROID (Hz) — the spectrum's center of mass: where the energy "sits".
//                   Bright, sharp sounds ("s", "ee") score high; dark, boomy
//                   sounds ("oo", a hum) score low.
//   SPREAD   (Hz) — standard deviation of energy around the centroid: is the
//                   energy packed into a narrow band (a pure hum) or smeared
//                   across the spectrum (hiss, breath)?
//   FLUX     (/s) — how fast the spectrum's shape is changing, per second.
//                   Near zero during a steady vowel; spikes at the transition
//                   from one sound to the next.
//   CREST    (×)  — tallest bin ÷ average bin. A pure tone towers over its
//                   average (high crest); flat noise barely rises above it
//                   (low crest). This is the "tonal vs noisy" meter.
//
// These become the 3D axes (and color data) of the trajectory in later phases.
// Nothing here draws or touches the DOM — pure math over one Float32Array.

// Only analyse the band where speech lives. Below ~80 Hz is rumble/mains hum;
// above ~5 kHz is mostly mic hiss. Without this cut, that hiss (dozens of
// near-empty bins) drags the centroid far above anything the voice is doing.
const BAND_LO_HZ = 80;
const BAND_HI_HZ = 5000;

// Silence gate: if the average magnitude across the band is below this, the
// "spectrum" is just the noise floor and every feature would be meaningless
// jitter — so we report "no reading" instead. (Speech lands around 1e-3..1e-2
// mean magnitude; an idle room is ~1e-4 or less. Tune during Phase A if the
// gate opens on room noise or stays shut on quiet speech.)
const SILENCE_MEAN_MAG = 2e-4;

// If the previous frame is older than this, the tab was likely backgrounded
// (rAF paused) — the spectrum legitimately changed a lot, but calling that
// "flux" would spike the reading. Treat it as having no previous frame.
const MAX_FLUX_GAP_MS = 250;

export class SpectralAnalyzer {
  constructor(sampleRate, fftSize) {
    // Each FFT bin covers this many Hz; bin i is centred at i × binHz.
    this.binHz = sampleRate / fftSize;
    this.loBin = Math.max(1, Math.round(BAND_LO_HZ / this.binHz)); // skip DC bin
    this.hiBin = Math.round(BAND_HI_HZ / this.binHz);

    const bandSize = this.hiBin - this.loBin + 1;
    this.mags = new Float32Array(bandSize); // linear magnitudes (this frame)
    this.shape = new Float32Array(bandSize); // magnitudes normalized to sum 1
    this.prevShape = new Float32Array(bandSize); // last voiced frame's shape
    this.hasPrev = false; // is prevShape valid?
    this.prevTime = 0; // when prevShape was captured (ms)
  }

  // dbBins: the analyser's getFloatFrequencyData output (decibels, mostly
  // negative). nowMs: caller's clock, used only for flux timing.
  // Returns { centroidHz, spreadHz, flux, crest } or null during silence.
  // flux is null (not 0) on the first voiced frame after silence — a change
  // rate needs two consecutive readings to exist.
  analyze(dbBins, nowMs) {
    const lo = this.loBin;
    const hi = Math.min(this.hiBin, dbBins.length - 1);
    const n = hi - lo + 1;

    // Decibels → linear magnitude (10^(dB/20)). All the statistics below are
    // weighted means, and weights must be linear energy — averaging raw dB
    // values would be averaging exponents.
    let total = 0;
    let max = 0;
    for (let i = 0; i < n; i++) {
      const db = dbBins[lo + i];
      const m = db > -160 ? Math.pow(10, db / 20) : 0; // -Infinity guard
      this.mags[i] = m;
      total += m;
      if (m > max) max = m;
    }

    const mean = total / n;
    if (mean < SILENCE_MEAN_MAG) {
      // Noise floor. Also forget the previous shape: flux across a silence
      // (last word → next word) is not a real "rate of change of the sound".
      this.hasPrev = false;
      return null;
    }

    // CENTROID — magnitude-weighted mean frequency.
    let centroidHz = 0;
    for (let i = 0; i < n; i++) {
      centroidHz += (lo + i) * this.binHz * this.mags[i];
    }
    centroidHz /= total;

    // SPREAD — magnitude-weighted standard deviation around the centroid.
    let variance = 0;
    for (let i = 0; i < n; i++) {
      const d = (lo + i) * this.binHz - centroidHz;
      variance += d * d * this.mags[i];
    }
    const spreadHz = Math.sqrt(variance / total);

    // CREST — peak over mean. mean > 0 is guaranteed by the silence gate.
    const crest = max / mean;

    // FLUX — compare this frame's SHAPE (magnitudes scaled to sum to 1)
    // against the previous frame's. Normalizing first makes flux measure how
    // the sound's character changes, not how its loudness changes — otherwise
    // every syllable's volume swell would read as spectral change. The sum of
    // absolute differences is divided by the elapsed time so the reading is a
    // rate (per second), independent of how steady requestAnimationFrame is.
    for (let i = 0; i < n; i++) this.shape[i] = this.mags[i] / total;
    let flux = null;
    const dtMs = nowMs - this.prevTime;
    if (this.hasPrev && dtMs > 0 && dtMs <= MAX_FLUX_GAP_MS) {
      let diff = 0;
      for (let i = 0; i < n; i++) {
        diff += Math.abs(this.shape[i] - this.prevShape[i]);
      }
      flux = diff / (dtMs / 1000);
    }

    // This frame's shape becomes the next frame's "previous" (buffer swap —
    // no allocation in the per-frame path).
    const swap = this.prevShape;
    this.prevShape = this.shape;
    this.shape = swap;
    this.hasPrev = true;
    this.prevTime = nowMs;

    return { centroidHz, spreadHz, flux, crest };
  }
}
