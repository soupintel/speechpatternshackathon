# Credits & Third-Party Disclosure

Everything used in this project that wasn't written from scratch for it, per
hackathon disclosure rules. Updated every time a dependency or borrowed idea is added.

## Libraries (runtime)

*None yet.* Phase 1 uses only browser built-ins (Web Audio API, Canvas 2D).
Planned for Phase 2: `d3-force` (BSD-3-Clause) — physics simulation for the
force-directed layout. Will be recorded here with exact version when added.

## Tools (development only — not shipped in the app)

| Tool | Version | License | Used for |
|---|---|---|---|
| Vite | ^6.0.0 | MIT | Dev server & production bundler. No Vite code ships in the built app; it only bundles my source. |

## Techniques / references (no code copied)

- **Pitch detection via autocorrelation** — a standard digital-signal-processing
  technique (compare the waveform against a time-shifted copy of itself; the shift
  with the strongest self-similarity is the pitch period). Implemented from the
  concept in `src/audio.js`; refined with 3-point parabolic peak interpolation,
  also a standard DSP method.
- **RMS (root-mean-square) loudness** — standard formula for signal energy.

## AI assistance

Built with AI pair-programming assistance (Claude Code) under my direction and
architecture decisions. *(Keep or reword this section per hackathon rules on AI
disclosure — separate from library disclosure.)*
