import * as THREE from 'three/webgpu';
import { config } from '../config';
import { events } from '../core/events';
import type { Input } from '../core/input';
import { Rng } from '../core/rng';
import type { DestructionSystem } from '../destruction/destruction';
import { KIND, MAT } from '../destruction/pieces';
import type { FireSystem } from '../fx/fire';
import type { InteriorSystem } from '../interiors/interiorSystem';
import type { PlayerController } from '../player/controller';

export type NovaPhase = 'idle' | 'windup' | 'wave';

/** One building the front has reached: its pieces nearest first. */
interface Work {
  bi: number;
  ids: Int32Array;
  dist: Float32Array;
  next: number;
}

interface Queued {
  bi: number;
  near: number;
  far: number;
}

const _v = new THREE.Vector3();
const _ids: number[] = [];

/**
 * The Nova blast (DESIGN.md §6.6). The meter fills from property damage; with it full, holding R
 * winds up for 2.5 s (he locks in a hover; letting go cancels), then it goes off. The shockwave
 * front expands at a finite speed and applies the damage zones to each piece as it arrives:
 * core vaporized, blast torn loose and flung, edge stripped and burning with failing supports,
 * fringe windows blown in. Work is capped per step and spread as the front advances; flung pieces
 * beyond the debris budget drop straight into rubble.
 */
export class Nova {
  /** Charge meter 0..1. */
  meter = 0;
  phase: NovaPhase = 'idle';
  /** Seconds into the wind-up (0..windupTime). */
  windupT = 0;
  /** Seconds since the last release (Infinity before the first). */
  sinceRelease = Infinity;
  /** Radius of the shockwave front (m). */
  front = 0;
  readonly center = new THREE.Vector3();
  /** Radius of the current/last blast (config at release). */
  radius = 0;
  /** Points where the core vaporized pieces since the effects last read them (ash bursts). */
  readonly bursts: number[] = [];
  stats = { releases: 0, cancels: 0, destroyed: 0, vaporizedBuildings: 0, flung: 0, maxStepMs: 0 };

  private queue: Queued[] = [];
  private qNext = 0;
  private work: Work[] = [];
  private lastBill = 0;
  private rng = new Rng(0x40fa);
  private burstCount = 0;
  /** Milliseconds of Nova work done this rendered frame (see beginFrame). */
  private frameSpent = 0;

  constructor(
    private readonly destruction: DestructionSystem,
    private readonly interiors: InteriorSystem,
    private readonly fire: FireSystem,
    private readonly player: PlayerController,
  ) {
    // Carnage fills the meter (the Nova's own destruction doesn't).
    events.on('damage:bill', ({ total }) => {
      const delta = total - this.lastBill;
      this.lastBill = total;
      if (this.phase === 'wave' || delta <= 0) return;
      this.meter = Math.min(1, this.meter + delta / Math.max(1, config.nova.fillDollars));
    });
  }

  /** Call once per rendered frame: resets the per-frame work budget. */
  beginFrame() {
    this.frameSpent = 0;
  }

  /** Debug: fill the meter. */
  fill() {
    this.meter = 1;
  }

  get windupK() {
    return this.phase === 'windup' ? Math.min(1, this.windupT / config.nova.windupTime) : 0;
  }

  get ready() {
    return this.meter >= 1 || !config.nova.requireFullMeter;
  }

  fixedUpdate(input: Input | null, dt: number) {
    const c = config.nova;
    this.sinceRelease += dt;
    const held = !!input?.action('nova').down;
    switch (this.phase) {
      case 'idle':
        if (held && this.ready) this.startWindup();
        break;
      case 'windup':
        this.windupT += dt;
        this.orbitDebris(dt);
        if (!held) this.cancel();
        else if (this.windupT >= c.windupTime) this.release();
        break;
      case 'wave': {
        const t0 = performance.now();
        // He's held a moment longer, then free while the front rolls on.
        if (this.sinceRelease > 0.6) this.player.locked = false;
        this.front += c.waveSpeed * dt;
        this.advance();
        this.stats.maxStepMs = Math.max(this.stats.maxStepMs, performance.now() - t0);
        break;
      }
    }
  }

  private startWindup() {
    const p = this.player;
    this.phase = 'windup';
    this.windupT = 0;
    p.locked = true;
    this.center.set(p.position.x, p.position.y + config.player.height / 2, p.position.z);
    events.emit('nova:windup', { x: this.center.x, y: this.center.y, z: this.center.z });
  }

  private cancel() {
    this.phase = 'idle';
    this.windupT = 0;
    this.player.locked = false;
    this.stats.cancels++;
    events.emit('nova:cancel', {});
  }

  /** Loose debris nearby lifts and slowly orbits him. */
  private orbitDebris(dt: number) {
    const c = config.nova;
    const k = this.windupK;
    const o = this.center;
    this.destruction.debris.forEachNear(o.x, o.y, o.z, c.orbitRadius, (it) => {
      const dx = it.pos.x - o.x;
      const dz = it.pos.z - o.z;
      const d = Math.max(1, Math.hypot(dx, dz));
      // Lift (beating gravity), a slow swirl, and a gentle pull toward a ring around him.
      const lift = (12 + 6 * k) * dt;
      const swirl = (3 + 5 * k) * dt;
      this.destruction.debris.push(it, (-dz / d) * swirl, lift, (dx / d) * swirl);
    });
  }

  private release() {
    const c = config.nova;
    const p = this.player;
    this.center.set(p.position.x, p.position.y + config.player.height / 2, p.position.z);
    this.phase = 'wave';
    this.meter = 0;
    this.front = 0;
    this.sinceRelease = 0;
    this.radius = c.radius;
    this.stats.releases++;
    this.stats.maxStepMs = 0;
    this.destruction.quiet = true;
    // Every building the front will reach, nearest first.
    const o = this.center;
    const reach = this.radius * c.fringeFraction;
    this.queue.length = 0;
    this.qNext = 0;
    this.work.length = 0;
    for (const b of this.destruction.city.buildings) {
      const nx = Math.max(b.x0 - o.x, 0, o.x - b.x1);
      const nz = Math.max(b.z0 - o.z, 0, o.z - b.z1);
      const ny = Math.max(0 - o.y, 0, o.y - b.height);
      const near = Math.hypot(nx, ny, nz);
      if (near > reach) continue;
      const fx = Math.max(Math.abs(b.x0 - o.x), Math.abs(b.x1 - o.x));
      const fz = Math.max(Math.abs(b.z0 - o.z), Math.abs(b.z1 - o.z));
      const fy = Math.max(Math.abs(o.y), Math.abs(b.height - o.y));
      this.queue.push({ bi: b.id, near, far: Math.hypot(fx, fy, fz) });
    }
    this.queue.sort((a, b) => a.near - b.near);
    events.emit('nova:release', { x: o.x, y: o.y, z: o.z, radius: this.radius });
  }

  /** Moves the front on: buildings it reaches join the work list; pieces it passes take their zone. */
  private advance() {
    const c = config.nova;
    const d = this.destruction;
    const R = this.radius;
    let budget = c.piecesPerStep;
    // Time box: however many physics steps a slow frame runs, the Nova gets budgetMs of it.
    const t0 = performance.now();
    const deadline = t0 + Math.max(0, c.budgetMs - this.frameSpent);
    let checks = 0;
    while (
      this.qNext < this.queue.length &&
      this.queue[this.qNext]!.near <= this.front &&
      performance.now() < deadline
    ) {
      const q = this.queue[this.qNext++]!;
      if (q.far <= R * c.coreFraction) {
        // Wholly inside the core: gone at once, no pieces simulated.
        const n = d.vaporizeBuilding(q.bi);
        this.stats.destroyed += n;
        this.stats.vaporizedBuildings++;
        const b = d.city.buildings[q.bi]!;
        this.bursts.push((b.x0 + b.x1) / 2, b.height * 0.4, (b.z0 + b.z1) / 2, 2);
        budget -= Math.ceil(n / 20);
        continue;
      }
      this.work.push(this.collect(q.bi));
      if (q.near <= R && q.far > R * c.blastFraction) this.setAlight(q.bi);
    }
    for (let w = 0; w < this.work.length && budget > 0; w++) {
      const job = this.work[w]!;
      while (job.next < job.ids.length && job.dist[job.next]! <= this.front && budget > 0) {
        this.apply(job.ids[job.next]!, job.dist[job.next]!);
        job.next++;
        budget--;
        if ((++checks & 15) === 0 && performance.now() > deadline) budget = 0;
      }
    }
    for (let w = this.work.length - 1; w >= 0; w--) {
      if (this.work[w]!.next >= this.work[w]!.ids.length) this.work.splice(w, 1);
    }
    this.frameSpent += performance.now() - t0;
    d.flushBill();
    const done = this.qNext >= this.queue.length && this.work.length === 0;
    if (done && this.front >= R * c.fringeFraction) {
      this.phase = 'idle';
      this.player.locked = false;
      d.quiet = false;
      events.emit('nova:done', {
        destroyed: this.stats.destroyed,
        vaporizedBuildings: this.stats.vaporizedBuildings,
      });
    }
  }

  /** A building's standing pieces within reach, sorted by distance from the centre. */
  private collect(bi: number): Work {
    const s = this.destruction.city.store;
    const b = this.destruction.city.buildings[bi]!;
    const o = this.center;
    const reach = this.radius * config.nova.fringeFraction;
    _ids.length = 0;
    const dists: number[] = [];
    for (let id = b.base; id < b.end; id++) {
      if (!s.isStatic(id)) continue;
      const dd = Math.sqrt(s.distSq(id, o.x, o.y, o.z));
      if (dd > reach) continue;
      _ids.push(id);
      dists.push(dd);
    }
    const order = _ids.map((_, i) => i).sort((a, q) => dists[a]! - dists[q]!);
    return {
      bi,
      ids: Int32Array.from(order, (i) => _ids[i]!),
      dist: Float32Array.from(order, (i) => dists[i]!),
      next: 0,
    };
  }

  /** The zone a piece is in decides what happens to it (§6.6 table). */
  private apply(id: number, dist: number) {
    const c = config.nova;
    const d = this.destruction;
    const s = d.city.store;
    if (!s.isStatic(id)) return;
    const R = this.radius;
    const f = dist / R;
    const o = this.center;
    if (f <= c.coreFraction) {
      if (d.vaporizePiece(id)) {
        this.stats.destroyed++;
        if (++this.burstCount % 30 === 0) this.bursts.push(s.cx[id]!, s.cy[id]!, s.cz[id]!, 1);
      }
      return;
    }
    // Outward from the centre, with some lift.
    _v.set(s.cx[id]! - o.x, s.cy[id]! - o.y, s.cz[id]! - o.z);
    if (_v.lengthSq() < 1e-6) _v.set(0, 1, 0);
    _v.normalize();
    _v.y = Math.max(_v.y, 0) + 0.3;
    const kind = s.kind[id]!;
    if (f <= c.blastFraction) {
      // Blast: everything torn loose and thrown outward, weaker toward the outer edge.
      const k = 1 - (f - c.coreFraction) / Math.max(1e-3, c.blastFraction - c.coreFraction);
      const sp = c.blastLaunch * (0.35 + 0.65 * k) * this.rng.range(0.7, 1.15);
      const fly = this.rng.next() < c.blastFlingShare;
      // Visual debris only (§6.6 performance rules): the Nova makes no rigid bodies.
      if (d.tearLoose(id, _v.x * sp, _v.y * sp, _v.z * sp, fly, false)) {
        this.stats.destroyed++;
        if (fly) this.stats.flung++;
      }
      return;
    }
    if (f <= 1) {
      // Edge: glass gone, facades stripped, supports badly damaged, everything scorched.
      const k = (f - c.blastFraction) / Math.max(1e-3, 1 - c.blastFraction);
      const sp = c.blastLaunch * 0.3 * (1 - k);
      if (kind === KIND.panel) {
        const strip = s.mat[id] === MAT.glass || this.rng.next() < c.edgeStrip * (1 - 0.5 * k);
        if (strip) {
          if (d.tearLoose(id, _v.x * sp, _v.y * sp, _v.z * sp, this.rng.next() < 0.25, false))
            this.stats.destroyed++;
        } else {
          d.bulkShatter(id);
          d.bulkDamage(id, s.maxHp[id]! * 0.5, 0, 0, 0, 0.8);
        }
      } else if (kind === KIND.column) {
        if (d.bulkDamage(id, s.maxHp[id]! * c.edgeColumnDamage * (1 - k), _v.x, _v.y, _v.z, 0.7))
          this.stats.destroyed++;
      } else if (kind === KIND.roof) {
        if (d.tearLoose(id, _v.x * sp, _v.y * sp, _v.z * sp, true, false)) this.stats.destroyed++;
      } else if (d.bulkDamage(id, s.maxHp[id]! * 0.6 * (1 - k), 0, 0, 0, 0.6)) {
        this.stats.destroyed++;
      }
      return;
    }
    // Fringe: windows blown in.
    d.bulkShatter(id);
  }

  /** Edge-zone buildings: power out and rooms burning. */
  private setAlight(bi: number) {
    const c = config.nova;
    const b = this.destruction.city.buildings[bi]!;
    const floor = Math.max(
      0,
      Math.min(b.floors - 1, Math.floor(this.center.y / config.construction.floorHeight)),
    );
    this.interiors.cutPower(bi, floor);
    const units = this.interiors.units;
    const n = Math.min(
      14,
      Math.round(b.floors * (b.ncx - 1) * (b.ncz - 1) * c.edgeIgnition * 0.25),
    );
    for (let i = 0; i < n; i++) {
      const u = units.id(
        bi,
        this.rng.int(0, b.floors - 1),
        this.rng.int(0, b.ncx - 2),
        this.rng.int(0, b.ncz - 2),
      );
      if (u >= 0) this.fire.ignite(u, 0.6);
    }
  }
}
