// graph.js — the constellation's data model and physics. No drawing here.
//
// Each speech unit from the AudioEngine becomes a node; nodes are laid out by a
// d3-force simulation (third-party physics library — see CREDITS.md). Forces used:
//
//   forceLink     — linked nodes pull toward each other (the speech chain holds)
//   forceManyBody — every node repels every other (the web spreads out)
//   forceCollide  — nodes can't overlap (respects each node's radius)
//   forceX/Y      — a weak pull toward screen center (keeps the artwork on stage)
//
// The renderer reads .nodes and .links each frame; we tick the simulation
// ourselves from the render loop so there's exactly one timing source.

import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCollide,
  forceX,
  forceY,
} from 'd3-force';

// ---- Node sizing ----
// Map a unit's peak RMS volume to a pixel radius. sqrt so that visual AREA
// tracks loudness (a 2x louder word looks ~2x bigger, not 4x).
const MIN_RADIUS = 4;
const MAX_RADIUS = 26;
const VOLUME_FULL_SCALE = 0.15; // RMS that earns the max radius

function volumeToRadius(maxVolume) {
  const t = Math.min(1, Math.sqrt(maxVolume / VOLUME_FULL_SCALE));
  return MIN_RADIUS + t * (MAX_RADIUS - MIN_RADIUS);
}

// ---- Physics tuning (each is a feel decision; adjust freely) ----
const SEQ_LINK_DISTANCE = 55; // preferred edge length between chained nodes
const SEQ_LINK_STRENGTH = 0.5;
const SIM_LINK_DISTANCE = 110; // similarity edges are longer, looser ties
const SIM_LINK_STRENGTH = 0.08; // ...and much weaker, so they shape, not drag
const REPULSION = -70; // forceManyBody strength (negative = repel)
const CENTER_PULL = 0.02; // weak drift toward center
const ALPHA_FLOOR = 0.02; // sim never fully sleeps → constellation "breathes"
const REHEAT_ALPHA = 0.6; // energy injected when a new node arrives
const SPAWN_JITTER = 46; // px offset when spawning near the previous node
const SPAWN_KICK = 4.5; // initial velocity of a newborn node

// ---- Similarity edges (what turns the string into a web) ----
// Two voiced units are "similar" when their pitches are within about a musical
// semitone of each other (pitch is compared on a log scale, like octaves).
const SIM_PITCH_TOLERANCE = 0.09; // |log2(p1/p2)| below this = similar
const SIM_MAX_PER_NODE = 2; // best matches only, so the web doesn't hairball

export class Constellation {
  constructor(width, height) {
    this.nodes = [];
    this.links = [];
    this.width = width;
    this.height = height;

    this.sim = forceSimulation(this.nodes)
      .force(
        'link',
        forceLink(this.links)
          .distance((l) => (l.kind === 'seq' ? SEQ_LINK_DISTANCE : SIM_LINK_DISTANCE))
          .strength((l) => (l.kind === 'seq' ? SEQ_LINK_STRENGTH : SIM_LINK_STRENGTH))
      )
      .force('charge', forceManyBody().strength(REPULSION))
      .force('collide', forceCollide().radius((n) => n.radius + 2))
      .force('x', forceX(width / 2).strength(CENTER_PULL))
      .force('y', forceY(height / 2).strength(CENTER_PULL))
      .alphaMin(0) // we manage liveliness with alphaTarget instead
      .alphaTarget(ALPHA_FLOOR)
      .stop(); // no internal timer — we call tick() from the render loop
  }

  // Called on window resize so the center pull follows the actual screen center.
  setSize(width, height) {
    this.width = width;
    this.height = height;
    this.sim.force('x').x(width / 2);
    this.sim.force('y').y(height / 2);
  }

  // One speech unit → one node (+ an edge to the previous node).
  addUnit(unit) {
    const prev = this.nodes.length > 0 ? this.nodes[this.nodes.length - 1] : null;

    // Spawn near the previous node (the web grows outward like it's being spun);
    // the very first node starts at center.
    const baseX = prev ? prev.x : this.width / 2;
    const baseY = prev ? prev.y : this.height / 2;
    const angle = Math.random() * Math.PI * 2;
    const dist = prev ? SPAWN_JITTER * (0.5 + Math.random()) : 0;

    const node = {
      id: this.nodes.length,
      unit,
      radius: volumeToRadius(unit.maxVolume),
      bornAt: performance.now(), // renderer uses this for the arrival ripple
      x: baseX + Math.cos(angle) * dist,
      y: baseY + Math.sin(angle) * dist,
      // A velocity kick so arrival visibly disturbs the web.
      vx: Math.cos(angle) * SPAWN_KICK,
      vy: Math.sin(angle) * SPAWN_KICK,
    };

    this.nodes.push(node);
    if (prev) {
      // The speech thread: how close in time two units were spoken (0..1,
      // 1 = said back-to-back). Renderer maps this to edge brightness.
      const gapMs = Math.max(0, unit.startMs - prev.unit.endMs);
      const closeness = Math.max(0, 1 - gapMs / 2000);
      this.links.push({
        source: prev,
        target: node,
        kind: 'seq',
        closeness,
        bornAt: node.bornAt, // renderer fades edges as they age
      });
    }

    // Similarity edges: tie this node to the few most pitch-similar earlier
    // nodes (excluding its chain neighbor). These cross-links are what make
    // the artwork read as a WEB rather than a string.
    if (unit.avgPitchHz > 0) {
      const candidates = [];
      for (const other of this.nodes) {
        if (other === node || other === prev) continue;
        if (!(other.unit.avgPitchHz > 0)) continue;
        const diff = Math.abs(Math.log2(unit.avgPitchHz / other.unit.avgPitchHz));
        if (diff < SIM_PITCH_TOLERANCE) {
          candidates.push({ other, similarity: 1 - diff / SIM_PITCH_TOLERANCE });
        }
      }
      candidates.sort((a, b) => b.similarity - a.similarity);
      for (const { other, similarity } of candidates.slice(0, SIM_MAX_PER_NODE)) {
        this.links.push({
          source: other,
          target: node,
          kind: 'sim',
          similarity,
          bornAt: node.bornAt,
        });
      }
    }

    // Re-register arrays with the forces and inject energy so the whole
    // constellation reacts to the new arrival, then settles again.
    this.sim.nodes(this.nodes);
    this.sim.force('link').links(this.links);
    this.sim.alpha(Math.max(this.sim.alpha(), REHEAT_ALPHA));
  }

  // Advance physics one step; called once per animation frame by the renderer.
  tick() {
    this.sim.tick();
  }

  // Wipe the artwork (explicit user action only — the graph never auto-resets).
  clear() {
    this.nodes.length = 0;
    this.links.length = 0;
    this.sim.nodes(this.nodes);
    this.sim.force('link').links(this.links);
  }
}
