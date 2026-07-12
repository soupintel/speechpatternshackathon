// audio.js — Phase 1 signal engine for Speech Constellation.
//
// Responsibilities:
//   1. Capture the microphone with the Web Audio API.
//   2. Every animation frame, measure VOLUME (RMS) and PITCH (autocorrelation).
//   3. Watch the volume envelope to segment the stream into speech "units"
//      (a word/phrase surrounded by pauses) using a small state machine.
//
// It emits two kinds of events via callbacks so the UI stays decoupled:
//   onFrame(frame)  -> fired ~60x/sec with the live measurement
//   onUnit(unit)    -> fired once each time a completed speech unit is detected
//
// Since the 3D-trajectory pivot, each frame also carries `spectral` — the
// frequency-domain features (centroid/spread/flux/crest) from spectral.js,
// or null while the room is silent.
//
// Nothing here draws to the screen; that is main.js's job.

import { SpectralAnalyzer } from './spectral.js';

// ---- Tuning constants (all in one place so they are easy to explain/adjust) ----

// Human voice pitch lives roughly between these bounds. Anything outside is
// treated as "not a real pitch" and rejected — this kills most noise/harmonic errors.
const MIN_PITCH_HZ = 70;
const MAX_PITCH_HZ = 500;

// Volume gate with hysteresis: we need a louder level to START a unit than to
// keep it going, so a wobble around the threshold doesn't rapidly flip states.
// These are BASE values at sensitivity 1.0 — the engine divides them by its
// `sensitivity` setting, so a quiet mic can be compensated from the UI without
// editing code. (Normal conversational speech on a laptop mic is often only
// ~0.005–0.02 RMS, so the gates must sit well below that.)
const BASE_VOICE_ON_VOLUME = 0.006; // rise above this (0..1 RMS) to begin a unit
const BASE_VOICE_OFF_VOLUME = 0.004; // fall below this to be considered a pause

// A pause only "ends" a unit once it has lasted at least this long. Too small and
// every syllable becomes its own unit; too big and whole sentences merge into one.
const MIN_SILENCE_MS = 160;

// Safety cap: if someone holds one continuous sound, split it so nodes keep forming.
const MAX_UNIT_MS = 1800;

// Ignore blips shorter than this (clicks, lip smacks) so they don't spawn units.
const MIN_UNIT_MS = 90;

const FFT_SIZE = 2048; // time-domain window size handed to the analyser

export class AudioEngine {
  constructor({ onFrame, onUnit, onError } = {}) {
    this.onFrame = onFrame || (() => {});
    this.onUnit = onUnit || (() => {});
    this.onError = onError || (() => {});

    this.audioContext = null;
    this.analyser = null;
    this.mediaStream = null;
    this.rafId = null;
    this.running = false;

    this.timeBuffer = null; // reused Float32Array for time-domain samples
    this.freqBuffer = null; // reused Float32Array for the magnitude spectrum
    this.spectral = null; // SpectralAnalyzer, created once the context exists
    this.startTime = 0; // performance.now() at start, so unit times are relative

    // Mic sensitivity multiplier (1 = base thresholds). Higher = registers
    // quieter speech. Adjustable live from the UI via setSensitivity().
    this.sensitivity = 1;

    // Unit-segmentation state machine.
    this._resetSegmentation();
  }

  _resetSegmentation() {
    this.inUnit = false; // are we currently inside a speech unit?
    this.unitIndex = 0;
    this.currentUnit = null; // accumulator for the in-progress unit
    this.silenceStartedAt = null; // when the current pause began (ms), or null
  }

  async start() {
    if (this.running) return;
    try {
      // Request the raw-est signal we can: turn OFF automatic gain control so that
      // loudness reflects real emphasis (critical — node size will map to volume).
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: false,
        },
      });
    } catch (err) {
      this.onError(err);
      return;
    }

    this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    // Some browsers start the context suspended until a user gesture resumes it.
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }

    const source = this.audioContext.createMediaStreamSource(this.mediaStream);
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = FFT_SIZE;
    // No time-averaging of the spectrum (default is 0.8). Spectral FLUX
    // measures exactly the frame-to-frame change that smoothing blurs away —
    // leaving it on would make flux read artificially low and laggy.
    this.analyser.smoothingTimeConstant = 0;
    source.connect(this.analyser);
    // Note: we deliberately do NOT connect the analyser to the destination, so the
    // user does not hear their own mic echoed back through the speakers.

    this.timeBuffer = new Float32Array(this.analyser.fftSize);
    this.freqBuffer = new Float32Array(this.analyser.frequencyBinCount);
    this.spectral = new SpectralAnalyzer(this.audioContext.sampleRate, FFT_SIZE);
    this.startTime = performance.now();
    this.running = true;
    this._resetSegmentation();
    this._tick();
  }

  stop() {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    // If a unit was in progress when we stopped, close it out so it isn't lost.
    if (this.inUnit) this._finishUnit(this._now());
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((t) => t.stop());
      this.mediaStream = null;
    }
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
    this.analyser = null;
  }

  _now() {
    return performance.now() - this.startTime;
  }

  // Effective thresholds after applying the sensitivity multiplier.
  get voiceOnVolume() {
    return BASE_VOICE_ON_VOLUME / this.sensitivity;
  }

  get voiceOffVolume() {
    return BASE_VOICE_OFF_VOLUME / this.sensitivity;
  }

  setSensitivity(value) {
    // Clamp to a sane range so the gate can't reach zero (always-on) or absurdity.
    this.sensitivity = Math.min(16, Math.max(0.25, value));
  }

  // Main per-frame loop.
  _tick() {
    if (!this.running) return;
    this.analyser.getFloatTimeDomainData(this.timeBuffer);

    const volume = rms(this.timeBuffer);
    const db = volume > 0 ? 20 * Math.log10(volume) : -Infinity;
    const pitchHz = detectPitch(this.timeBuffer, this.audioContext.sampleRate, volume);
    const voiced = volume >= this.voiceOnVolume;
    const now = this._now();

    // Frequency-domain read of the same window: the shape features that will
    // position points in the 3D trajectory. Null while the room is silent.
    this.analyser.getFloatFrequencyData(this.freqBuffer);
    const spectral = this.spectral.analyze(this.freqBuffer, now);

    this._updateSegmentation(now, volume, pitchHz);

    this.onFrame({ time: now, pitchHz, volume, db, voiced, spectral });

    this.rafId = requestAnimationFrame(() => this._tick());
  }

  // The unit state machine: decide when a speech unit starts and ends based on the
  // volume envelope, and accumulate stats (avg pitch, peak volume) while inside one.
  _updateSegmentation(now, volume, pitchHz) {
    const loudEnoughToStart = volume >= this.voiceOnVolume;
    const quietEnoughToPause = volume < this.voiceOffVolume;

    if (!this.inUnit) {
      if (loudEnoughToStart) {
        // A new unit begins.
        this.inUnit = true;
        this.silenceStartedAt = null;
        this.currentUnit = {
          index: this.unitIndex,
          startMs: now,
          maxVolume: volume,
          _pitchSum: 0,
          _pitchCount: 0,
        };
        this._accumulatePitch(pitchHz);
      }
      return;
    }

    // We are inside a unit — keep collecting measurements.
    this.currentUnit.maxVolume = Math.max(this.currentUnit.maxVolume, volume);
    this._accumulatePitch(pitchHz);

    if (quietEnoughToPause) {
      // Start (or continue) timing a pause.
      if (this.silenceStartedAt === null) this.silenceStartedAt = now;
      const silenceMs = now - this.silenceStartedAt;
      if (silenceMs >= MIN_SILENCE_MS) {
        // Pause held long enough — the unit ended when the pause began.
        this._finishUnit(this.silenceStartedAt);
      }
    } else {
      // Loud again before the pause matured — it was just a dip, not a boundary.
      this.silenceStartedAt = null;
      // Safety split for a very long continuous sound.
      if (now - this.currentUnit.startMs >= MAX_UNIT_MS) {
        this._finishUnit(now);
      }
    }
  }

  _accumulatePitch(pitchHz) {
    if (pitchHz > 0) {
      this.currentUnit._pitchSum += pitchHz;
      this.currentUnit._pitchCount += 1;
    }
  }

  _finishUnit(endMs) {
    const u = this.currentUnit;
    const durationMs = Math.max(0, endMs - u.startMs);
    // Reset state first so we're ready for the next unit regardless of what happens.
    this.inUnit = false;
    this.currentUnit = null;
    this.silenceStartedAt = null;

    if (durationMs < MIN_UNIT_MS) return; // too short — discard as a blip

    const unit = {
      index: u.index,
      startMs: Math.round(u.startMs),
      endMs: Math.round(endMs),
      durationMs: Math.round(durationMs),
      avgPitchHz: u._pitchCount > 0 ? u._pitchSum / u._pitchCount : 0,
      maxVolume: u.maxVolume,
    };
    this.unitIndex += 1;
    this.onUnit(unit);
  }
}

// ---- Pure DSP helpers (no side effects; easy to reason about and test) ----

// Root-mean-square: the standard measure of a signal's loudness over a window.
export function rms(buffer) {
  let sum = 0;
  for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
  return Math.sqrt(sum / buffer.length);
}

// Pitch detection by NORMALIZED autocorrelation.
//
// Idea: a periodic sound (a voiced vowel) looks similar to a copy of itself shifted
// by one period. We slide the signal against itself at every possible shift ("lag")
// and find the lag where the overlap is strongest. That lag is the period, and
// frequency = sampleRate / period.
//
// Crucially, the correlation is divided by the signal's total energy so the curve
// lands on a ~0..1 scale NO MATTER HOW LOUD the speech is. (Raw correlation scales
// with amplitude squared — with an absolute threshold, quiet-but-voiced speech gets
// silently rejected. That bug produced "no pitch" on quiet units.)
//
// Returns frequency in Hz, or -1 if the frame is too quiet or not clearly periodic.

let corrScratch = null; // reused between frames to avoid re-allocating 60x/sec

export function detectPitch(buffer, sampleRate, volume) {
  // Silence guard — don't try to find pitch in the noise floor. Fixed low bar
  // (independent of sensitivity) since autocorrelation needs *some* signal.
  if (volume < 0.002) return -1;

  const size = buffer.length;
  // Only search lags that correspond to plausible human pitches.
  const minLag = Math.floor(sampleRate / MAX_PITCH_HZ);
  const maxLag = Math.min(Math.floor(sampleRate / MIN_PITCH_HZ), size - 2);

  // Total energy of the window, used as the normalizer.
  let energy = 0;
  for (let i = 0; i < size; i++) energy += buffer[i] * buffer[i];
  if (energy <= 0) return -1;

  if (!corrScratch || corrScratch.length < maxLag + 2) {
    corrScratch = new Float32Array(maxLag + 2);
  }

  // Normalized autocorrelation over the plausible range; track the global peak.
  let bestLag = -1;
  let bestCorr = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = 0; i < size - lag; i++) {
      sum += buffer[i] * buffer[i + lag];
    }
    // Scale the normalizer down to the overlap length so long lags (low pitches)
    // aren't unfairly penalized for having fewer samples to correlate.
    const c = sum / (energy * ((size - lag) / size));
    corrScratch[lag] = c;
    if (c > bestCorr) {
      bestCorr = c;
      bestLag = lag;
    }
  }

  // Voiced speech is strongly self-similar (normalized peak near 1); breath,
  // fricatives ("s", "f") and room noise are not. Below this bar, the honest
  // answer is "this frame has no pitch".
  if (bestLag < 0 || bestCorr < 0.35) return -1;

  // Octave guard: if HALF the winning period is nearly as strong a peak, the
  // winner was a subharmonic and the true pitch is one octave up — prefer it.
  const half = Math.round(bestLag / 2);
  if (half >= minLag) {
    let halfLag = -1;
    let halfCorr = 0;
    for (let l = Math.max(minLag, half - 2); l <= Math.min(maxLag, half + 2); l++) {
      if (corrScratch[l] > halfCorr) {
        halfCorr = corrScratch[l];
        halfLag = l;
      }
    }
    if (halfLag > 0 && halfCorr > 0.9 * bestCorr) {
      bestLag = halfLag;
      bestCorr = halfCorr;
    }
  }

  // Parabolic interpolation around the best lag for sub-sample precision.
  const yLeft = bestLag - 1 >= minLag ? corrScratch[bestLag - 1] : corrScratch[bestLag];
  const yRight = bestLag + 1 <= maxLag ? corrScratch[bestLag + 1] : corrScratch[bestLag];
  const refined = parabolicPeak(yLeft, corrScratch[bestLag], yRight, bestLag);

  const freq = sampleRate / refined;
  if (freq < MIN_PITCH_HZ || freq > MAX_PITCH_HZ) return -1;
  return freq;
}

// Given three samples straddling a peak (at x-1, x, x+1), estimate the true peak x.
function parabolicPeak(yLeft, yCenter, yRight, xCenter) {
  const denom = yLeft - 2 * yCenter + yRight;
  if (denom === 0) return xCenter;
  const offset = (0.5 * (yLeft - yRight)) / denom;
  return xCenter + offset;
}
