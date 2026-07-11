// main.js — Phase 1 UI for Speech Constellation.
//
// Wires the AudioEngine (mic + analysis) to a debug interface:
//   - live pitch / volume / voiced-state readouts
//   - a scrolling "scope" canvas showing recent volume (bars) + pitch (dots)
//   - a list of detected speech units with their stats
//
// There is deliberately NO graph here yet. Phase 1 exists to prove that the
// numbers we will later turn into art are trustworthy.

import './style.css';
import { AudioEngine } from './audio.js';

// ---- DOM references ----
const micButton = document.getElementById('micButton');
const statusEl = document.getElementById('status');
const pitchValueEl = document.getElementById('pitchValue');
const dbValueEl = document.getElementById('dbValue');
const volumeBarEl = document.getElementById('volumeBar');
const voicedValueEl = document.getElementById('voicedValue');
const unitCountEl = document.getElementById('unitCount');
const unitListEl = document.getElementById('unitList');
const scopeCanvas = document.getElementById('scope');
const scopeCtx = scopeCanvas.getContext('2d');
const sensitivitySlider = document.getElementById('sensitivity');
const sensValueEl = document.getElementById('sensValue');

// Full-scale RMS for the volume meter/bars. Normal conversational speech on a
// laptop mic peaks around 0.05–0.15, so 0.08 makes the meter actually move.
const METER_FULL_SCALE = 0.08;

// ---- Scope history ----
// A ring of recent frames; drawn right-to-left so newest is at the right edge.
const HISTORY_LENGTH = 300; // ~5 seconds at 60fps
const history = []; // array of { pitchHz, volume }

// Pitch → color used by the scope dots. This same mapping will color the
// constellation nodes in Phase 3, so we get to preview and tune it now.
// Low pitch = deep blue, high pitch = hot pink/white, via a hue sweep.
const PITCH_COLOR_MIN = 70; // Hz — matches the engine's plausible-voice range
const PITCH_COLOR_MAX = 500;

function pitchToColor(pitchHz) {
  // Normalize on a log scale — pitch perception is logarithmic (octaves), so a
  // log mapping spreads typical voices across the gradient instead of bunching
  // everyone at the bottom.
  const t = Math.min(
    1,
    Math.max(
      0,
      (Math.log(pitchHz) - Math.log(PITCH_COLOR_MIN)) /
        (Math.log(PITCH_COLOR_MAX) - Math.log(PITCH_COLOR_MIN))
    )
  );
  // Hue sweep: 220° (blue) through violet to magenta as pitch rises.
  const hue = 220 + t * 100;
  const lightness = 45 + t * 25; // higher pitch also reads brighter
  return `hsl(${hue}, 90%, ${lightness}%)`;
}

// ---- Engine wiring ----
let engine = null;
let unitsDetected = 0;

function setStatus(text, kind) {
  statusEl.textContent = `[ ${text} ]`;
  statusEl.className = `status status--${kind}`;
}

// Sensitivity slider → engine threshold scaling, live.
sensitivitySlider.addEventListener('input', () => {
  const value = parseFloat(sensitivitySlider.value);
  sensValueEl.textContent = `${value.toFixed(1)}×`;
  if (engine) engine.setSensitivity(value);
});

function handleFrame(frame) {
  // Numeric readouts.
  pitchValueEl.textContent = frame.pitchHz > 0 ? frame.pitchHz.toFixed(0) : '—';
  dbValueEl.textContent = isFinite(frame.db) ? frame.db.toFixed(1) : '—';
  voicedValueEl.textContent = frame.voiced ? 'speaking' : 'silence';
  voicedValueEl.classList.toggle('is-voiced', frame.voiced);

  // Volume meter.
  const pct = Math.min(100, (frame.volume / METER_FULL_SCALE) * 100);
  volumeBarEl.style.width = `${pct}%`;

  // Push into scope history.
  history.push({ pitchHz: frame.pitchHz, volume: frame.volume });
  if (history.length > HISTORY_LENGTH) history.shift();
  drawScope();
}

function handleUnit(unit) {
  unitsDetected += 1;
  unitCountEl.textContent = String(unitsDetected);

  const li = document.createElement('li');
  li.className = 'unit-list__item';
  const pitchText = unit.avgPitchHz > 0 ? `${unit.avgPitchHz.toFixed(0)} Hz` : 'no pitch';
  li.innerHTML =
    `<span class="unit-list__dot" style="background:${
      unit.avgPitchHz > 0 ? pitchToColor(unit.avgPitchHz) : '#555'
    }"></span>` +
    `<strong>U${String(unit.index).padStart(3, '0')}</strong>` +
    ` dur=${unit.durationMs}ms f0=${pitchText} pk=${unit.maxVolume.toFixed(3)}`;
  unitListEl.prepend(li);
  // Keep the list short — it's a debug view, not a log.
  while (unitListEl.children.length > 12) unitListEl.removeChild(unitListEl.lastChild);
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

// ---- Scope drawing ----
function drawScope() {
  const w = scopeCanvas.width;
  const h = scopeCanvas.height;
  scopeCtx.clearRect(0, 0, w, h);

  // Reference grid: horizontal lines at round pitch values (log scale), so the
  // pitch trace can be read like an instrument chart.
  scopeCtx.font = '10px Consolas, monospace';
  for (const refHz of [100, 200, 300, 400]) {
    const t =
      (Math.log(refHz) - Math.log(PITCH_COLOR_MIN)) /
      (Math.log(PITCH_COLOR_MAX) - Math.log(PITCH_COLOR_MIN));
    const y = h - t * (h * 0.9) - h * 0.05;
    scopeCtx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
    scopeCtx.beginPath();
    scopeCtx.moveTo(0, y);
    scopeCtx.lineTo(w, y);
    scopeCtx.stroke();
    scopeCtx.fillStyle = 'rgba(255, 255, 255, 0.22)';
    scopeCtx.fillText(`${refHz}Hz`, 6, y - 3);
  }

  const step = w / HISTORY_LENGTH;

  for (let i = 0; i < history.length; i++) {
    const x = w - (history.length - i) * step;
    const { pitchHz, volume } = history[i];

    // Volume: dim bar rising from the bottom.
    const barH = Math.min(1, volume / METER_FULL_SCALE) * (h * 0.9);
    scopeCtx.fillStyle = 'rgba(78, 250, 192, 0.13)';
    scopeCtx.fillRect(x, h - barH, Math.max(1, step - 1), barH);

    // Pitch: a colored dot, higher pitch drawn higher (log scale, like the colors).
    if (pitchHz > 0) {
      const t =
        (Math.log(pitchHz) - Math.log(PITCH_COLOR_MIN)) /
        (Math.log(PITCH_COLOR_MAX) - Math.log(PITCH_COLOR_MIN));
      const y = h - Math.min(1, Math.max(0, t)) * (h * 0.9) - h * 0.05;
      scopeCtx.fillStyle = pitchToColor(pitchHz);
      scopeCtx.beginPath();
      scopeCtx.arc(x, y, 2.5, 0, Math.PI * 2);
      scopeCtx.fill();
    }
  }
}

// ---- Start/stop button ----
micButton.addEventListener('click', async () => {
  if (engine && engine.running) {
    engine.stop();
    engine = null;
    micButton.textContent = 'START MIC';
    setStatus('stopped', 'idle');
    return;
  }

  setStatus('requesting mic…', 'pending');
  engine = new AudioEngine({
    onFrame: handleFrame,
    onUnit: handleUnit,
    onError: handleError,
  });
  // Apply whatever the sensitivity slider is currently set to.
  engine.setSensitivity(parseFloat(sensitivitySlider.value));
  await engine.start();
  if (engine.running) {
    micButton.textContent = 'STOP MIC';
    setStatus('listening', 'live');
  }
});
