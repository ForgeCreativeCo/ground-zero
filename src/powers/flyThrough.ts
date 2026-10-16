import type RAPIER from '@dimforge/rapier3d-compat';
import { config } from '../config';
import { events } from '../core/events';
import { closestOnSegment, segmentBoxDistSq } from '../core/geom';
import { Rng } from '../core/rng';
import type { DestructionSystem } from '../destruction/destruction';
import { KIND } from '../destruction/pieces';
import type { Effects } from '../fx/effects';
import type { InteriorSystem } from '../interiors/interiorSystem';
import type { Penetrator, PlayerController } from '../player/controller';

interface Tunnel {
  /** Where he entered and where he is now (body centre). */
  ax: number;
  ay: number;
  az: number;
  bx: number;
  by: number;
  bz: number;
}

const _ids: number[] = [];
const _units: number[] = [];

/**
 * Fly-through penetration at sonic speed (DESIGN.md §7.7). Above the sonic threshold buildings
 * don't stop him: each physics substep sweeps a sphere along his path, destroying everything inside
 * it (facades, columns, interior walls, furniture; floor slabs only when diving) and blasting what's
 * near. Debris sprays out along his velocity, the exit facade blows outward, and each building costs
 * speed: drop below the threshold and he crashes to a stop inside, amid the wreckage. Leaving (or
 * crashing) sends a structural shock through the tunnelled stories, so towers often fail afterwards.
 */
export class FlyThrough implements Penetrator {
  /** Buildings he is inside right now, with their tunnel so far. */
  readonly inside = new Map<number, Tunnel>();
  stats = { buildings: 0, exits: 0, crashes: 0, piecesDestroyed: 0 };
  private prepared = new Set<number>();
  private rng = new Rng(0x7a77);
  private lookTimer = 0;

  constructor(
    private readonly destruction: DestructionSystem,
    private readonly interiors: InteriorSystem,
    private readonly fx: Effects,
    private readonly player: PlayerController,
  ) {}

  passes(c: RAPIER.Collider) {
    return this.destruction.colliders.buildingOfCollider.has(c.handle);
  }

  /** He moved from a to b (body centre) during one substep, above the sonic threshold. */
  sweep(ax: number, ay: number, az: number, bx: number, by: number, bz: number) {
    // Already stopped (crashed earlier in this step): the rest of the step's substeps do nothing.
    if (this.player.speed < config.player.sonicThreshold) return;
    const ft = config.flyThrough;
    const d = this.destruction;
    const s = d.city.store;
    const v = this.player.velocity;
    const speed = Math.max(1e-3, this.player.speed);
    const steep = Math.abs(v.y) / speed;
    const mx = (ax + bx) / 2;
    const my = (ay + by) / 2;
    const mz = (az + bz) / 2;
    const half = Math.hypot(bx - ax, by - ay, bz - az) / 2;
    const tr2 = ft.tunnelRadius * ft.tunnelRadius;
    const br = Math.max(ft.blastRadius, ft.tunnelRadius + 0.01);
    _ids.length = 0;
    d.city.forEachPieceInSphere(mx, my, mz, half + br, (id) => _ids.push(id));
    for (const id of _ids) {
      if (!s.isStatic(id)) continue;
      const d2 = segmentBoxDistSq(
        ax,
        ay,
        az,
        bx,
        by,
        bz,
        s.cx[id]!,
        s.cy[id]!,
        s.cz[id]!,
        s.hx[id]!,
        s.hy[id]!,
        s.hz[id]!,
      );
      if (d2 > br * br) continue;
      // Only what is beside or behind him takes the blast: what is ahead is tunnelled when he
      // gets there (blasting it early would clear the facade before he ever touched it).
      if (d2 > tr2) {
        const qx = Math.max(s.cx[id]! - s.hx[id]!, Math.min(s.cx[id]! + s.hx[id]!, bx));
        const qy = Math.max(s.cy[id]! - s.hy[id]!, Math.min(s.cy[id]! + s.hy[id]!, by));
        const qz = Math.max(s.cz[id]! - s.hz[id]!, Math.min(s.cz[id]! + s.hz[id]!, bz));
        if (((qx - bx) * v.x + (qy - by) * v.y + (qz - bz) * v.z) / speed > 0.05) continue;
      }
      const bi = s.building[id]!;
      const slab = s.kind[id] === KIND.slab;
      if (d2 <= tr2 && (!slab || steep >= ft.slabSteepness)) {
        if (!this.inside.has(bi)) {
          this.enter(bi, bx, by, bz);
          // Crashed at the entry wall: nothing more this step.
          if (this.player.speed < config.player.sonicThreshold) return;
        }
        this.spray(id, v.x, v.y, v.z, 1);
        this.stats.piecesDestroyed++;
      } else {
        const dist = Math.sqrt(d2);
        const k = Math.max(0, 1 - (dist - ft.tunnelRadius) / (br - ft.tunnelRadius));
        const push = ft.spray * 0.5 * k;
        d.damagePiece(id, ft.blastDamage * (0.4 + 0.6 * k), v.x * push, v.y * push, v.z * push);
      }
    }
    // Furniture, interior walls (and, later, people) in the path are obliterated.
    d.propDamage?.(
      bx,
      by,
      bz,
      ft.tunnelRadius,
      5000,
      v.x * ft.spray,
      v.y * ft.spray + 2,
      v.z * ft.spray,
    );

    // Track the tunnels; leaving a building's footprint is the exit.
    for (const [bi, t] of this.inside) {
      t.bx = bx;
      t.by = by;
      t.bz = bz;
      const b = d.city.buildings[bi]!;
      const out =
        bx < b.x0 - 0.3 ||
        bx > b.x1 + 0.3 ||
        bz < b.z0 - 0.3 ||
        bz > b.z1 + 0.3 ||
        by > b.height + 4 ||
        by < -1;
      if (out) this.exit(bi, t);
    }
  }

  /**
   * He slowed below the threshold (or landed) while still inside a building: that's a crash too,
   * or he would be left inside colliders that haven't caught up with the tunnel.
   */
  ended(x: number, y: number, z: number) {
    if (this.inside.size === 0) return;
    const [bi] = this.inside.keys();
    this.crash(bi!, x, y, z);
  }

  /** Blows one piece out along his velocity. */
  private spray(id: number, vx: number, vy: number, vz: number, scale: number) {
    const ft = config.flyThrough;
    const k = ft.spray * scale;
    const sc = ft.scatter;
    this.destruction.destroyPiece(
      id,
      vx * k + this.rng.range(-sc, sc),
      vy * k + this.rng.range(-sc * 0.3, sc),
      vz * k + this.rng.range(-sc, sc),
    );
  }

  private enter(bi: number, x: number, y: number, z: number) {
    const ft = config.flyThrough;
    const v = this.player.velocity;
    this.inside.set(bi, { ax: x, ay: y, az: z, bx: x, by: y, bz: z });
    this.stats.buildings++;
    this.prepare(bi, x, y, z);
    // Each building costs speed.
    const keep = 1 - ft.speedCost;
    v.x *= keep;
    v.y *= keep;
    v.z *= keep;
    events.emit('player:tunnelEnter', { building: bi, x, y, z, speed: this.player.speed });
    events.emit('camera:shake', { trauma: ft.shake });
    if (this.player.speed < config.player.sonicThreshold) this.crash(bi, x, y, z);
  }

  /** Leaving: the exit facade blows outward, then the structural shock. */
  private exit(bi: number, t: Tunnel) {
    const ft = config.flyThrough;
    const d = this.destruction;
    const s = d.city.store;
    const v = this.player.velocity;
    _ids.length = 0;
    d.city.forEachPieceInSphere(t.bx, t.by, t.bz, ft.exitRadius, (id) => {
      if (s.building[id] === bi) _ids.push(id);
    });
    for (const id of _ids) {
      if (!s.isStatic(id)) continue;
      if (s.kind[id] === KIND.panel || s.kind[id] === KIND.roof) {
        this.spray(id, v.x, v.y, v.z, 1.2);
        this.stats.piecesDestroyed++;
      } else d.damagePiece(id, ft.blastDamage, v.x * 0.2, v.y * 0.2, v.z * 0.2);
    }
    d.propDamage?.(
      t.bx,
      t.by,
      t.bz,
      ft.exitRadius,
      5000,
      v.x * ft.spray,
      v.y * ft.spray + 3,
      v.z * ft.spray,
    );
    // A burst of dust out of the hole, along his path.
    for (let i = 0; i < 40; i++) {
      const k = this.rng.range(0.05, 0.3);
      this.fx.dust.spawn(
        t.bx,
        t.by,
        t.bz,
        v.x * k + this.rng.range(-4, 4),
        v.y * k + this.rng.range(-2, 4),
        v.z * k + this.rng.range(-4, 4),
        this.rng.range(1.2, 2.4),
        2.5,
      );
    }
    this.shock(bi, t);
    this.inside.delete(bi);
    this.prepared.delete(bi);
    this.stats.exits++;
    events.emit('player:tunnelExit', {
      building: bi,
      x: t.bx,
      y: t.by,
      z: t.bz,
      vx: v.x,
      vy: v.y,
      vz: v.z,
    });
  }

  /** Too slow to keep going: he stops dead inside the building, amid the wreckage. */
  private crash(bi: number, x: number, y: number, z: number) {
    const ft = config.flyThrough;
    const d = this.destruction;
    const s = d.city.store;
    const v = this.player.velocity;
    const vx = v.x;
    const vy = v.y;
    const vz = v.z;
    const sp = Math.max(1e-3, Math.hypot(vx, vy, vz));
    v.x = v.y = v.z = 0;
    // He ploughs on a few metres into the building, clearing a pocket of wreckage around him so
    // he isn't left inside anything.
    const ex = x + (vx / sp) * ft.crashDepth;
    const ey = y + (vy / sp) * ft.crashDepth;
    const ez = z + (vz / sp) * ft.crashDepth;
    const r = ft.tunnelRadius * 1.4;
    const r2 = r * r;
    _ids.length = 0;
    d.city.forEachPieceInSphere(
      (x + ex) / 2,
      (y + ey) / 2,
      (z + ez) / 2,
      ft.crashDepth / 2 + r,
      (id) => _ids.push(id),
    );
    for (const id of _ids) {
      if (!s.isStatic(id)) continue;
      if (s.kind[id] === KIND.slab && s.cy[id]! < Math.min(y, ey) - 0.5) continue; // keep the floor
      const d2 = segmentBoxDistSq(
        x,
        y,
        z,
        ex,
        ey,
        ez,
        s.cx[id]!,
        s.cy[id]!,
        s.cz[id]!,
        s.hx[id]!,
        s.hy[id]!,
        s.hz[id]!,
      );
      if (d2 <= r2) this.spray(id, vx, vy, vz, 0.35);
    }
    this.player.shiftTo(ex, ey - config.player.height / 2, ez);
    x = ex;
    y = ey;
    z = ez;
    d.propDamage?.(x, y, z, ft.tunnelRadius * 2, 5000, vx * 0.2, 2, vz * 0.2);
    for (const [b, t] of this.inside) {
      this.shock(b, t);
      d.colliders.rebuild(b);
    }
    this.inside.clear();
    this.stats.crashes++;
    this.fx.dust.ring(x, y - 0.8, z, 3, 50, 6);
    events.emit('player:tunnelCrash', { building: bi, x, y, z });
    events.emit('camera:shake', { trauma: 0.9 });
  }

  /**
   * Structural shock (DESIGN.md §7.6, "a tower with a tunnel through it"): columns on the
   * tunnelled stories are damaged, worst near the path, so the building often fails after the delay.
   */
  private shock(bi: number, t: Tunnel) {
    const ft = config.flyThrough;
    const d = this.destruction;
    const s = d.city.store;
    const b = d.city.buildings[bi]!;
    const H = config.construction.floorHeight;
    const f0 = Math.max(0, Math.floor(Math.min(t.ay, t.by) / H) - ft.shockStories);
    const f1 = Math.min(b.floors - 1, Math.floor(Math.max(t.ay, t.by) / H) + ft.shockStories);
    const R = Math.max(0.1, ft.shockRadius);
    if (ft.shockDamage > 0 || ft.shockDamageEdge > 0) {
      for (let f = f0; f <= f1; f++) {
        for (let a = 0; a < b.ncx; a++) {
          for (let c = 0; c < b.ncz; c++) {
            const id = b.colId(f, a, c);
            if (!s.isStatic(id)) continue;
            // Horizontal distance to the path (the stories already bound it vertically).
            const u = closestOnSegment(t.ax, 0, t.az, t.bx, 0, t.bz, s.cx[id]!, 0, s.cz[id]!);
            const px = t.ax + (t.bx - t.ax) * u;
            const pz = t.az + (t.bz - t.az) * u;
            const dist = Math.hypot(s.cx[id]! - px, s.cz[id]! - pz);
            const k = Math.min(1, dist / R);
            const dmg = ft.shockDamage + (ft.shockDamageEdge - ft.shockDamage) * k;
            if (dmg > 0) d.damagePiece(id, s.maxHp[id]! * dmg);
          }
        }
      }
    }
    d.structure.markDirty(bi);
  }

  /**
   * Furnishes the rooms on his path through a building just before he gets there, so furniture
   * sprays out of the far side. Call every step while at sonic speed.
   */
  lookAhead(dt: number) {
    this.lookTimer -= dt;
    if (this.lookTimer > 0) return;
    this.lookTimer = 0.08;
    const p = this.player;
    const speed = p.speed;
    if (speed < config.player.sonicThreshold * 0.9) return;
    const dx = p.velocity.x / speed;
    const dy = p.velocity.y / speed;
    const dz = p.velocity.z / speed;
    const ox = p.position.x;
    const oy = p.position.y + config.player.height / 2;
    const oz = p.position.z;
    const hits = this.destruction.city.raycast(
      ox,
      oy,
      oz,
      dx,
      dy,
      dz,
      speed * config.flyThrough.lookAhead + 4,
    );
    if (hits.length === 0) return;
    const first = hits[0]!;
    const bi = this.destruction.city.store.building[first.id]!;
    if (this.prepared.has(bi)) return;
    this.prepare(bi, ox + dx * first.t, oy + dy * first.t, oz + dz * first.t);
  }

  /** Furnishes the units along his straight-line path through building bi from (x, y, z). */
  private prepare(bi: number, x: number, y: number, z: number) {
    if (this.prepared.has(bi)) return;
    this.prepared.add(bi);
    const p = this.player;
    const speed = Math.max(1e-3, p.speed);
    const b = this.destruction.city.buildings[bi]!;
    const span = Math.hypot(b.x1 - b.x0, b.z1 - b.z0) + 4;
    _units.length = 0;
    for (let t = 0; t <= span; t += 3) {
      const u = this.interiors.unitAt(
        x + (p.velocity.x / speed) * t,
        y + (p.velocity.y / speed) * t,
        z + (p.velocity.z / speed) * t,
      );
      if (u >= 0 && !_units.includes(u)) _units.push(u);
      if (_units.length >= 10) break;
    }
    for (const u of _units) this.interiors.spawnNow(u);
  }
}
