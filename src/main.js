// main.js — wires everything together.
//
//   AudioEngine (audio.js)  --units-->  Constellation (graph.js)
//                                            |
//                            Renderer (render.js) paints it every frame
//
// This file owns the DOM: buttons, sensitivity slider, and the HUD readouts.

import './style.css';
import { AudioEngine } from './audio.js';
import { Constellation } from './graph.js';
import { Renderer } from './render.js';

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

// ---- The artwork ----
// Constellation = data + physics; Renderer = paints it and ticks the physics.
// The render loop runs from page load so the constellation keeps breathing
// even while the mic is stopped (the artwork never resets on stop).
const constellation = new Constellation(window.innerWidth, window.innerHeight);
const renderer = new Renderer(canvas, constellation);
renderer.start();

// ---- Engine wiring ----
let engine = null;

function setStatus(text, kind) {
  statusEl.textContent = `[ ${text} ]`;
  statusEl.className = `status status--${kind}`;
}

function handleFrame(frame) {
  pitchValueEl.textContent = frame.pitchHz > 0 ? frame.pitchHz.toFixed(0) : '—';
  dbValueEl.textContent = isFinite(frame.db) ? frame.db.toFixed(1) : '—';
  voicedValueEl.textContent = frame.voiced ? 'OPEN' : 'SHUT';
  voicedValueEl.classList.toggle('is-voiced', frame.voiced);
}

function handleUnit(unit) {
  constellation.addUnit(unit);
  unitCountEl.textContent = String(constellation.nodes.length);
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
  constellation.clear();
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
    onUnit: handleUnit,
    onError: handleError,
  });
  engine.setSensitivity(parseFloat(sensitivitySlider.value));
  await engine.start();
  if (engine.running) {
    micButton.textContent = 'STOP MIC';
    setStatus('listening', 'live');
  }
});
