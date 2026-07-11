// render.js — draws the constellation onto a full-screen canvas, every frame.
//
// Phase 2 scope: plain but correct — dots sized by radius, hairline edges,
// pitch-mapped node colors. Glow, numeric overlays, and similarity edges are
// Phase 3. The render loop is also the app's single timing source: it advances
// the physics one step, then paints the result.

import { pitchToColor, UNVOICED_COLOR } from './palette.js';

const BACKGROUND = '#050505';
const LINK_COLOR = 'rgba(180, 200, 255, 0.16)';

export class Renderer {
  constructor(canvas, constellation) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.constellation = constellation;
    this.rafId = null;

    this._resize = this._resize.bind(this);
    window.addEventListener('resize', this._resize);
    this._resize();
  }

  // Match the canvas backing store to the element's CSS size × devicePixelRatio
  // so the artwork is crisp on any display, then tell the physics where center is.
  _resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // draw in CSS-pixel coordinates
    this.constellation.setSize(w, h);
  }

  start() {
    if (this.rafId !== null) return;
    const loop = () => {
      this.constellation.tick(); // one physics step per painted frame
      this.draw();
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  stop() {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  draw() {
    const ctx = this.ctx;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const { nodes, links } = this.constellation;

    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, w, h);

    // Edges first so nodes paint over them.
    ctx.strokeStyle = LINK_COLOR;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const link of links) {
      ctx.moveTo(link.source.x, link.source.y);
      ctx.lineTo(link.target.x, link.target.y);
    }
    ctx.stroke();

    // Nodes: filled disc, colored by the unit's average pitch.
    for (const node of nodes) {
      const voiced = node.unit.avgPitchHz > 0;
      ctx.fillStyle = voiced ? pitchToColor(node.unit.avgPitchHz) : UNVOICED_COLOR;
      ctx.beginPath();
      ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
