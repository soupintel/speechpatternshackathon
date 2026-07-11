# Credits & Third-Party Disclosure

Everything used in this project that wasn't written from scratch for it, per
hackathon disclosure rules. Updated every time a dependency or borrowed idea is added.

## Libraries (runtime)

| Library | Version | License | Used for |
|---|---|---|---|
| d3-force | 3.0.0 | ISC | Force-directed physics simulation that positions the constellation's nodes (link attraction, many-body repulsion, collision, centering). |
| d3-dispatch | 3.0.1 | ISC | Internal dependency of d3-force (event dispatch). |
| d3-quadtree | 3.0.1 | ISC | Internal dependency of d3-force (spatial index that makes repulsion fast). |
| d3-timer | 3.0.1 | ISC | Internal dependency of d3-force (timing; unused at runtime since we tick manually). |

Everything else is browser built-ins (Web Audio API, Canvas 2D) or written for
this project.

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
