import { config } from '../config';
import type { FrameStats } from '../core/frameStats';

/** Everything the perf HUD and perf runner report (DESIGN.md §13). */
export interface PerfSnapshot {
  fps: number;
  avgMs: number;
  p95Ms: number;
  maxMs: number;
  drawCalls: number;
  triangles: number;
  activeBodies: number;
  totalBodies: number;
  ragdolls: number;
  charsLod0: number;
  charsLod1: number;
  charsLod2: number;
  decals: number;
  particles: number;
  jsHeapMB: number;
  gpuMB: number;
  simSteps: number;
  /** Smoothed CPU ms per frame. */
  cpuMs: number;
  backend: string;
  seed: number;
  pieces: number;
  piecesShown: number;
  colliders: number;
  debrisActive: number;
  debrisVisual: number;
  rubble: number;
  clusters: number;
}

export function emptySnapshot(): PerfSnapshot {
  return {
    fps: 0,
    avgMs: 0,
    p95Ms: 0,
    maxMs: 0,
    drawCalls: 0,
    triangles: 0,
    activeBodies: 0,
    totalBodies: 0,
    ragdolls: 0,
    charsLod0: 0,
    charsLod1: 0,
    charsLod2: 0,
    decals: 0,
    particles: 0,
    jsHeapMB: 0,
    gpuMB: 0,
    simSteps: 0,
    cpuMs: 0,
    backend: '',
    seed: 0,
    pieces: 0,
    piecesShown: 0,
    colliders: 0,
    debrisActive: 0,
    debrisVisual: 0,
    rubble: 0,
    clusters: 0,
  };
}

const GRAPH_W = 240;
const GRAPH_H = 56;
/** Graph full-scale (ms). */
const GRAPH_MAX_MS = 50;

/** Always-available perf overlay: text at hudRefreshHz, frame-time graph every frame. */
export class PerfHud {
  readonly root: HTMLDivElement;
  private text: HTMLPreElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private sinceText = Infinity;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.id = 'perf-hud';
    this.text = document.createElement('pre');
    this.canvas = document.createElement('canvas');
    this.canvas.width = GRAPH_W;
    this.canvas.height = GRAPH_H;
    this.root.append(this.canvas, this.text);
    parent.appendChild(this.root);
    this.ctx = this.canvas.getContext('2d')!;
  }

  update(realDt: number, stats: FrameStats, snap: PerfSnapshot) {
    this.root.style.display = config.debug.showPerfHud ? '' : 'none';
    if (!config.debug.showPerfHud) return;
    this.drawGraph(stats);
    this.sinceText += realDt;
    if (this.sinceText < 1 / config.debug.hudRefreshHz) return;
    this.sinceText = 0;
    const b = config.budgets;
    const over = (v: number, max: number) => (v > max ? ' !' : '');
    this.text.textContent =
      `${snap.fps.toFixed(0)} fps  ${snap.avgMs.toFixed(1)} ms avg  p95 ${snap.p95Ms.toFixed(1)}  max ${snap.maxMs.toFixed(1)}  cpu ${snap.cpuMs.toFixed(1)}\n` +
      `draw calls ${snap.drawCalls}${over(snap.drawCalls, b.drawCalls)}   tris ${fmtK(snap.triangles)}\n` +
      `bodies ${snap.activeBodies} active / ${snap.totalBodies}${over(snap.activeBodies, b.activeRigidBodies)}   ragdolls ${snap.ragdolls}${over(snap.ragdolls, b.activeRagdolls)}\n` +
      `chars LOD0 ${snap.charsLod0}${over(snap.charsLod0, b.lod0Characters)}  LOD1 ${snap.charsLod1}  crowd ${snap.charsLod2}\n` +
      `decals ${snap.decals}${over(snap.decals, b.decals)}   particles ${fmtK(snap.particles)}${over(snap.particles, b.particles)}\n` +
      `pieces ${fmtK(snap.piecesShown)} shown / ${fmtK(snap.pieces)}   colliders ${snap.colliders}\n` +
      `debris ${snap.debrisActive} bodies  ${snap.debrisVisual} loose  rubble ${fmtK(snap.rubble)}  falling ${snap.clusters}\n` +
      `mem JS ${snap.jsHeapMB.toFixed(0)} MB  GPU ~${snap.gpuMB.toFixed(0)} MB\n` +
      `${snap.backend}  steps/frame ${snap.simSteps}  seed ${snap.seed}  x${config.loop.timeScale.toFixed(2)}${config.loop.paused ? ' PAUSED' : ''}`;
  }

  private drawGraph(stats: FrameStats) {
    const { ctx } = this;
    ctx.clearRect(0, 0, GRAPH_W, GRAPH_H);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(0, 0, GRAPH_W, GRAPH_H);
    const y = (ms: number) => GRAPH_H - (Math.min(ms, GRAPH_MAX_MS) / GRAPH_MAX_MS) * GRAPH_H;
    // 60 fps and 30 fps guides
    ctx.fillStyle = 'rgba(120,255,140,0.5)';
    ctx.fillRect(0, y(16.7), GRAPH_W, 1);
    ctx.fillStyle = 'rgba(255,120,90,0.5)';
    ctx.fillRect(0, y(33.3), GRAPH_W, 1);
    const n = stats.count;
    const barW = GRAPH_W / stats.capacity;
    for (let i = 0; i < n; i++) {
      const ms = stats.at(i);
      ctx.fillStyle = ms > 33.3 ? '#ff5a4a' : ms > 16.9 ? '#ffc04a' : '#7cf08c';
      const top = y(ms);
      ctx.fillRect((stats.capacity - n + i) * barW, top, Math.max(1, barW), GRAPH_H - top);
    }
  }
}

function fmtK(n: number) {
  return n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${n}`;
}
