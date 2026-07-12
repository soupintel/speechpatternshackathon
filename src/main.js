// main.js — wires everything together.
//
//   AudioEngine (audio.js)  --frames-->  Trajectory (trajectory.js)
//                                             |
//                             Renderer3D (render3d.js) paints it every frame
//
// (The pre-pivot 2D constellation — graph.js + render.js — lives intact on
// the `2d-constellation` branch as the fallback.)
//
// This file owns the DOM: buttons, sensitivity slider, and the HUD readouts.

import './style.css';
import { AudioEngine } from './audio.js';
import { Trajectory } from './trajectory.js';
import { Renderer3D } from './render3d.js';

// ---- DOM references ----
const micButton = document.getElementById('micButton');
const clearButton = document.getElementById('clearButton');
const statusEl = document.getElementById('status');
const pitchValueEl = document.getElementById('pitchValue');
const dbValueEl = document.getElementById('dbValue');
const voicedValueEl = document.getElementById('voicedValue');
const unitCountEl = document.getElementById('unitCount');
const sensitivitySlider = document.getElementById('sensitivity');
const sensValueEl = document.getElementById('sensValue');
const canvas = document.getElementById('constellation');

// Phase A spectral bench (temporary — see index.html).
const centValueEl = document.getElementById('centValue');
const sprdValueEl = document.getElementById('sprdValue');
const fluxValueEl = document.getElementById('fluxValue');
const crestValueEl = document.getElementById('crestValue');

// ---- The artwork ----
// Trajectory = the voice's path through feature space; Renderer3D = projects
// and paints it. The render loop runs from page load so the cube keeps
// rotating even while the mic is stopped (the artwork never resets on stop).
const trajectory = new Trajectory();
const renderer = new Renderer3D(canvas, trajectory);
renderer.start();

// ---- Engine wiring ----
let engine = null;

function setStatus(text, kind) {
  statusEl.textContent = `[ ${text} ]`;
  statusEl.className = `status status--${kind}`;
}

let lastPitchHz = 0; // header F0 holds the last detected pitch instead of
// flashing "—" the instant the gate closes (pitch only exists while voicing)
let pitchLockAt = -Infinity; // when the voicing gate last reopened
let wasPitched = false;
const F0_SETTLE_MS = 180; // F0 readout counts up briefly on gate reopen,
// mirroring the node labels' settle-in (see render.js)

// ---- Phase A: spectral bench + range logging -------------------------------
// Goal of this phase is VERIFICATION, not visuals: show the four spectral
// features live so known sounds can be checked against expectations
// ("ssss" → high centroid / low crest; a hum → low centroid / high crest),
// and log each feature's observed range — those ranges become the axis
// normalization in Phase B.

const LOG_LINE_MS = 250; // compact live line, 4×/sec while sound is present
const LOG_RANGE_MS = 5000; // observed-ranges summary cadence

// Running min/max per feature over the whole session.
const ranges = {
  centroidHz: null, // each becomes { min, max } after the first reading
  spreadHz: null,
  flux: null,
  crest: null,
};
let lastLineLog = 0;
let lastRangeLog = 0;

function trackRange(key, value) {
  if (value === null || !isFinite(value)) return;
  const r = ranges[key];
  if (!r) ranges[key] = { min: value, max: value };
  else {
    r.min = Math.min(r.min, value);
    r.max = Math.max(r.max, value);
  }
}

function updateSpectralBench(s, now) {
  // The bench dims (is-stale) during silence but keeps its last value, the
  // same peak-hold behavior as the F0 readout.
  const stale = s === null;
  for (const el of [centValueEl, sprdValueEl, fluxValueEl, crestValueEl]) {
    el.parentElement.classList.toggle('is-stale', stale);
  }
  if (stale) return;

  centValueEl.textContent = s.centroidHz.toFixed(0);
  sprdValueEl.textContent = s.spreadHz.toFixed(0);
  // flux is null on the first voiced frame after silence (no previous frame
  // to compare against) — keep whatever the readout showed last.
  if (s.flux !== null) fluxValueEl.textContent = s.flux.toFixed(1);
  crestValueEl.textContent = s.crest.toFixed(1);

  trackRange('centroidHz', s.centroidHz);
  trackRange('spreadHz', s.spreadHz);
  trackRange('flux', s.flux);
  trackRange('crest', s.crest);

  if (now - lastLineLog >= LOG_LINE_MS) {
    lastLineLog = now;
    console.log(
      `[spectral] cent=${s.centroidHz.toFixed(0)}Hz ` +
        `sprd=${s.spreadHz.toFixed(0)}Hz ` +
        `flux=${s.flux === null ? '—' : s.flux.toFixed(1)}/s ` +
        `crest=${s.crest.toFixed(1)}×`,
    );
  }
  if (now - lastRangeLog >= LOG_RANGE_MS) {
    lastRangeLog = now;
    const fmt = (r, digits) =>
      r ? `${r.min.toFixed(digits)}…${r.max.toFixed(digits)}` : '—';
    console.log(
      `[spectral ranges] cent ${fmt(ranges.centroidHz, 0)}Hz | ` +
        `sprd ${fmt(ranges.spreadHz, 0)}Hz | ` +
        `flux ${fmt(ranges.flux, 1)}/s | ` +
        `crest ${fmt(ranges.crest, 1)}×`,
    );
  }
}

function handleFrame(frame) {
  const now = performance.now();
  updateSpectralBench(frame.spectral, now);
  if (trajectory.addFrame(now, frame.spectral, frame.pitchHz)) {
    unitCountEl.textContent = String(trajectory.nodes.length);
  }
  if (frame.pitchHz > 0 && !wasPitched) pitchLockAt = now; // gate reopened
  wasPitched = frame.pitchHz > 0;
  if (frame.pitchHz > 0) lastPitchHz = frame.pitchHz;

  // Count the readout up toward the live value instead of snapping. Audio
  // frames arrive every few ms, so the count-up animates without its own timer.
  const settle = Math.min(1, (now - pitchLockAt) / F0_SETTLE_MS);
  const shownHz = lastPitchHz * (1 - (1 - settle) * (1 - settle));
  pitchValueEl.textContent = lastPitchHz > 0 ? shownHz.toFixed(0) : '—';
  // Dim the readout when it's a held value rather than a live one.
  pitchValueEl.parentElement.classList.toggle('is-stale', frame.pitchHz <= 0);
  dbValueEl.textContent = isFinite(frame.db) ? frame.db.toFixed(1) : '—';
  voicedValueEl.textContent = frame.voiced ? 'OPEN' : 'SHUT';
  voicedValueEl.classList.toggle('is-voiced', frame.voiced);
}

function handleError(err) {
  console.error('Mic error:', err);
  if (err && err.name === 'NotAllowedError') {
    setStatus('mic permission denied — allow access and try again', 'error');
  } else if (err && err.name === 'NotFoundError') {
    setStatus('no microphone found', 'error');
  } else {
    setStatus(`mic error: ${err && err.message ? err.message : err}`, 'error');
  }
  micButton.textContent = 'START MIC';
}

// Sensitivity slider → engine threshold scaling, live.
sensitivitySlider.addEventListener('input', () => {
  const value = parseFloat(sensitivitySlider.value);
  sensValueEl.textContent = `${value.toFixed(1)}×`;
  if (engine) engine.setSensitivity(value);
});

// Clear wipes the artwork — explicit action only; stopping the mic never does.
clearButton.addEventListener('click', () => {
  trajectory.clear();
  unitCountEl.textContent = '0';
});

micButton.addEventListener('click', async () => {
  if (engine && engine.running) {
    engine.stop();
    engine = null;
    micButton.textContent = 'START MIC';
    setStatus('stopped — constellation kept', 'idle');
    return;
  }

  setStatus('requesting mic…', 'pending');
  engine = new AudioEngine({
    onFrame: handleFrame,
    onError: handleError,
  });
  engine.setSensitivity(parseFloat(sensitivitySlider.value));
  await engine.start();
  if (engine.running) {
    micButton.textContent = 'STOP MIC';
    setStatus('listening', 'live');
  }
});
