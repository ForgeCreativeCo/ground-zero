import type RAPIER from '@dimforge/rapier3d-compat';
import { config } from '../config';
import { events, type PlayerState } from '../core/events';
import type { Input } from '../core/input';
import type { Physics } from '../physics/physics';
import {
  approachSpeed,
  leapSpeed,
  resolveContact,
  rotateToward,
  speedBand,
  targetSpeed,
  turnRate,
  type SpeedBand,
  type Vec3,
} from './flightModel';

const v3 = (): Vec3 => ({ x: 0, y: 0, z: 0 });
const _fwd = v3();
const _flat = v3();
const _right = v3();
const _wish = v3();
const _dir = v3();
const _delta = { x: 0, y: 0, z: 0 };
const _n = v3();
const _center = { x: 0, y: 0, z: 0 };
const _colliderPos = { x: 0, y: 0, z: 0 };
const _up = { x: 0, y: 0.3, z: 0 };
const _hit = v3();

/** Sonic fly-through (DESIGN.md §7.7): what he passes through and what that does. */
export interface Penetrator {
  /** Colliders a sonic hero goes straight through (buildings). */
  passes(collider: RAPIER.Collider): boolean;
  /** He moved from a to b (body centre) in one substep while penetrating. */
  sweep(ax: number, ay: number, az: number, bx: number, by: number, bz: number): void;
  /** He dropped out of penetration (below the threshold or landed) at body centre (x, y, z). */
  ended(x: number, y: number, z: number): void;
}

/**
 * The hero's movement (DESIGN.md §5): walk/run, charged superhuman leap, take-off, hover, cruise,
 * boost, sonic and dive, on a Rapier kinematic character controller. Runs at the fixed sim rate;
 * high speeds substep the collision sweep so he never tunnels through anything.
 */
export class PlayerController {
  /** Feet position. */
  readonly position = v3();
  readonly prevPosition = v3();
  readonly velocity = v3();
  state: PlayerState = 'grounded';
  /** Camera look the controls are relative to (set by the camera rig each frame). */
  lookYaw = 0;
  lookPitch = 0;
  /** True while charging a leap (crouched). 0..1 charge fraction. */
  leapCharge = 0;
  charging = false;
  landingTimer = 0;
  diving = false;
  /** Last frame's turn rate around the vertical (rad/s), for banking. */
  yawRate = 0;
  band: SpeedBand = 'hover';
  /** Counters for tests and the HUD. */
  stats = { sonicBooms: 0, hardLandings: 0, impacts: 0, unstucks: 0 };
  /** Sonic fly-through hook (set by the game); null = buildings always block. */
  penetrator: Penetrator | null = null;
  /** Going through buildings this step (sonic, flying). */
  penetrating = false;

  private body: RAPIER.RigidBody;
  private ray: RAPIER.Ray;
  private collider: RAPIER.Collider;
  private kcc: RAPIER.KinematicCharacterController;
  private inputHeld = 0;
  private sonicArmed = true;
  /** Rocketing straight down from a slam (Q in the air); cleared on landing. */
  private slamDiving = false;
  private slamSpeed = 0;
  /** Touched a wall during the last step's move. */
  private wallContact = false;
  private stuck = 0;
  private lastFlatYaw = 0;
  private passFilter = (c: RAPIER.Collider) => !this.penetrator!.passes(c);

  constructor(private readonly physics: Physics) {
    const p = config.player;
    const R = physics.R;
    const half = p.height / 2 - p.radius;
    // Kinematic body: the character controller misbehaves with a parentless collider.
    this.body = physics.world.createRigidBody(
      R.RigidBodyDesc.kinematicPositionBased().setTranslation(0, p.height / 2, 0),
    );
    this.collider = physics.world.createCollider(R.ColliderDesc.capsule(half, p.radius), this.body);
    this.kcc = physics.world.createCharacterController(p.skin);
    this.ray = new R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
    this.kcc.setUp({ x: 0, y: 1, z: 0 });
    this.kcc.setMaxSlopeClimbAngle((50 * Math.PI) / 180);
    this.kcc.setMinSlopeSlideAngle((35 * Math.PI) / 180);
    this.kcc.enableAutostep(0.5, 0.3, false);
    this.kcc.setApplyImpulsesToDynamicBodies(true);
    this.teleport(p.spawn[0], p.spawn[1], p.spawn[2]);
  }

  get playerCollider() {
    return this.collider;
  }

  get speed() {
    return Math.hypot(this.velocity.x, this.velocity.y, this.velocity.z);
  }

  teleport(x: number, y: number, z: number) {
    // Start just clear of the surface: the controller can't resolve a starting overlap.
    y += config.player.skin * 2;
    this.position.x = this.prevPosition.x = x;
    this.position.y = this.prevPosition.y = y;
    this.position.z = this.prevPosition.z = z;
    this.velocity.x = this.velocity.y = this.velocity.z = 0;
    this.syncCollider();
  }

  fixedUpdate(input: Input | null, dt: number) {
    this.prevPosition.x = this.position.x;
    this.prevPosition.y = this.position.y;
    this.prevPosition.z = this.position.z;
    this.computeBasis();

    const mx = input ? input.move.x : 0;
    const my = input ? input.move.y : 0;
    const jump = input?.action('jump');
    const descend = input?.action('descend');
    const boost = input?.action('boost');

    switch (this.state) {
      case 'grounded':
        this.updateGrounded(mx, my, !!boost?.down, jump, dt);
        break;
      case 'airborne':
        this.updateAirborne(mx, my, jump, dt);
        break;
      case 'flying':
        this.updateFlying(mx, my, jump?.value ?? 0, descend?.value ?? 0, !!boost?.down, dt);
        break;
    }

    this.move(dt, (descend?.value ?? 0) > 0.5);
    this.updateSonic();
    this.unstickIfNeeded(mx, my, dt);
  }

  // --- states -------------------------------------------------------------------------------

  private updateGrounded(
    mx: number,
    my: number,
    running: boolean,
    jump: Input['actions']['jump'] | undefined,
    dt: number,
  ) {
    const p = config.player;
    if (this.landingTimer > 0) this.landingTimer -= dt;
    const recovering = this.landingTimer > 0;

    if (jump?.doubleTapLatch && !recovering) {
      this.takeOff();
      return;
    }
    if (jump?.pressedLatch && !recovering) {
      this.charging = true;
      this.leapCharge = 0;
    }
    if (this.charging) {
      this.leapCharge = Math.min(1, this.leapCharge + dt / p.leapChargeTime);
      if (!jump?.down) {
        this.launchLeap();
        return;
      }
    }

    const speed = recovering
      ? 0
      : (running ? p.runSpeed : p.walkSpeed) * (this.charging ? 0.25 : 1);
    const tx = (_flat.x * my + _right.x * mx) * speed;
    const tz = (_flat.z * my + _right.z * mx) * speed;
    const k = 1 - Math.exp(-p.groundResponse * dt);
    this.velocity.x += (tx - this.velocity.x) * k;
    this.velocity.z += (tz - this.velocity.z) * k;
    this.velocity.y = -2; // keep contact; snap-to-ground does the rest
  }

  private updateAirborne(
    mx: number,
    my: number,
    jump: Input['actions']['jump'] | undefined,
    dt: number,
  ) {
    const p = config.player;
    // Pressing jump in the air takes off (this is also how a ground double-tap lands here).
    if (jump?.pressedLatch) {
      this.takeOff();
      return;
    }
    this.velocity.y += p.gravity * dt;
    const horiz = Math.hypot(this.velocity.x, this.velocity.z);
    const steerSpeed = Math.max(horiz, p.runSpeed);
    const k = 1 - Math.exp(-p.airControl * dt);
    if (Math.abs(mx) + Math.abs(my) > 0.05) {
      const tx = (_flat.x * my + _right.x * mx) * steerSpeed;
      const tz = (_flat.z * my + _right.z * mx) * steerSpeed;
      this.velocity.x += (tx - this.velocity.x) * k;
      this.velocity.z += (tz - this.velocity.z) * k;
    }
  }

  private updateFlying(
    mx: number,
    my: number,
    ascend: number,
    descend: number,
    boosting: boolean,
    dt: number,
  ) {
    const p = config.player;
    if (this.slamDiving) {
      this.velocity.x = 0;
      this.velocity.y = -this.slamSpeed;
      this.velocity.z = 0;
      this.diving = true;
      this.band = speedBand(this.slamSpeed, p);
      return;
    }
    _wish.x = _fwd.x * my + _right.x * mx;
    _wish.y = _fwd.y * my + (ascend - descend);
    _wish.z = _fwd.z * my + _right.z * mx;
    let len = Math.hypot(_wish.x, _wish.y, _wish.z);
    let hasInput = len > 0.1;
    if (boosting && !hasInput) {
      // Boost with no direction flies where the camera looks.
      _wish.x = _fwd.x;
      _wish.y = _fwd.y;
      _wish.z = _fwd.z;
      len = 1;
      hasInput = true;
    }
    this.inputHeld = hasInput ? this.inputHeld + dt : 0;

    const speed = this.speed;
    if (speed > 1e-4) {
      _dir.x = this.velocity.x / speed;
      _dir.y = this.velocity.y / speed;
      _dir.z = this.velocity.z / speed;
    } else if (hasInput) {
      _dir.x = _wish.x / len;
      _dir.y = _wish.y / len;
      _dir.z = _wish.z / len;
    }
    const target = targetSpeed(hasInput, boosting, this.inputHeld, p) * Math.min(1, len);
    let next = approachSpeed(speed, target, dt, p);
    if (hasInput) {
      _wish.x /= len;
      _wish.y /= len;
      _wish.z /= len;
      const facing = _dir.x * _wish.x + _dir.y * _wish.y + _dir.z * _wish.z;
      // Pressed against a wall, only motion toward the wish builds speed: pushing into a facade
      // pins him there instead of accelerating whatever sideways sliver is left after the contact.
      if (this.wallContact && facing < 0.7)
        next = approachSpeed(speed, target * Math.max(0, facing), dt, p);
      if (facing < -0.3 && speed < p.hoverSpeed * 1.5) {
        // Reversing at low speed: brake through zero and go straight back, no looping arc.
        next = approachSpeed(speed, 0, dt, p);
        if (next < 0.5) {
          _dir.x = _wish.x;
          _dir.y = _wish.y;
          _dir.z = _wish.z;
        }
      } else {
        rotateToward(_dir, _wish, turnRate(speed, p) * dt);
      }
    }
    this.velocity.x = _dir.x * next;
    this.velocity.y = _dir.y * next;
    this.velocity.z = _dir.z * next;
    this.band = speedBand(next, p);
    this.diving = next > p.diveMinSpeed && _dir.y < -Math.sin((p.diveAngleDeg * Math.PI) / 180);
  }

  private takeOff() {
    const p = config.player;
    this.charging = false;
    this.leapCharge = 0;
    this.velocity.y = Math.max(this.velocity.y, p.takeoffSpeed);
    this.inputHeld = 0;
    this.setState('flying');
  }

  private launchLeap() {
    const p = config.player;
    const charge = this.leapCharge;
    const vy = leapSpeed(charge * p.leapChargeTime, p.jumpSpeed, p.leapMaxSpeed, p.leapChargeTime);
    this.velocity.y = vy;
    // A charged leap also throws him forward along where he is heading (or looking).
    const fwd = vy * p.leapForward * charge;
    const hx = this.velocity.x;
    const hz = this.velocity.z;
    const hl = Math.hypot(hx, hz);
    const dx = hl > 0.5 ? hx / hl : _flat.x;
    const dz = hl > 0.5 ? hz / hl : _flat.z;
    this.velocity.x += dx * fwd;
    this.velocity.z += dz * fwd;
    this.charging = false;
    this.leapCharge = 0;
    this.setState('airborne');
  }

  // --- movement & contacts -----------------------------------------------------------------------

  private move(dt: number, wantsDown: boolean) {
    const p = config.player;
    const flying = this.state === 'flying';
    if (this.state === 'grounded') this.kcc.enableSnapToGround(p.snapToGround);
    else this.kcc.disableSnapToGround();

    const wasPenetrating = this.penetrating;
    this.penetrating =
      flying && !!this.penetrator && config.flyThrough.enabled && this.speed >= p.sonicThreshold;
    if (wasPenetrating && !this.penetrating)
      this.penetrator?.ended(this.position.x, this.position.y + p.height / 2, this.position.z);
    const filter = this.penetrating ? this.passFilter : undefined;
    const dist = this.speed * dt;
    const steps = Math.min(p.maxSubsteps, Math.max(1, Math.ceil(dist / p.maxSubstep)));
    const sub = dt / steps;
    let groundImpact = 0;
    let grounded = false;
    const preDive = this.diving;
    // The sweep can stop at the skin without reporting a ground hit, so impact speed also comes
    // from the velocity before the move.
    const preVy = this.velocity.y;
    this.wallContact = false;
    // Debug bodies are ignored for now (M2 gives debris real interaction); never wedged in them.
    const flags =
      this.physics.R.QueryFilterFlags.EXCLUDE_SENSORS |
      this.physics.R.QueryFilterFlags.EXCLUDE_DYNAMIC;

    for (let s = 0; s < steps; s++) {
      _delta.x = this.velocity.x * sub;
      _delta.y = this.velocity.y * sub;
      _delta.z = this.velocity.z * sub;
      this.kcc.computeColliderMovement(this.collider, _delta, flags, undefined, filter);
      const mv = this.kcc.computedMovement();
      const hy = p.height / 2;
      const ax = this.position.x;
      const ay = this.position.y + hy;
      const az = this.position.z;
      this.position.x += mv.x;
      this.position.y += mv.y;
      this.position.z += mv.z;
      this.syncCollider();
      if (this.penetrating) {
        this.penetrator!.sweep(ax, ay, az, this.position.x, this.position.y + hy, this.position.z);
      }
      grounded = this.kcc.computedGrounded();

      let reported = false;
      const n = this.kcc.numComputedCollisions();
      for (let i = 0; i < n; i++) {
        const c = this.kcc.computedCollision(i);
        if (!c || !c.collider) continue;
        if (c.collider.parent()?.isDynamic()) continue;
        reported = true;
        groundImpact = Math.max(
          groundImpact,
          this.contact(
            c.normal2.x,
            c.normal2.y,
            c.normal2.z,
            c.witness1.x,
            c.witness1.y,
            c.witness1.z,
            flying,
          ),
        );
      }
      // The controller sometimes blocks the move without reporting a collision. If he came up
      // short, find the blocking surface with a ray along the move and treat it as a contact.
      if (!reported) {
        const lx = _delta.x - mv.x;
        const ly = _delta.y - mv.y;
        const lz = _delta.z - mv.z;
        const lost = Math.hypot(lx, ly, lz);
        const want = Math.hypot(_delta.x, _delta.y, _delta.z);
        if (lost > 1e-3 && lost > want * 0.1) {
          const hit = this.probe(_delta.x / want, _delta.y / want, _delta.z / want, want);
          if (hit) {
            groundImpact = Math.max(
              groundImpact,
              this.contact(_n.x, _n.y, _n.z, _hit.x, _hit.y, _hit.z, flying),
            );
          }
        }
      }
      if (this.state !== 'grounded' && grounded && groundImpact > 0) break;
    }

    // Landing / leaving the ground.
    if (this.state === 'grounded') {
      if (!grounded) this.setState('airborne');
      return;
    }
    const touching = grounded || groundImpact > 0;
    if (!touching) return;
    groundImpact = Math.max(groundImpact, -preVy);
    if (this.state === 'airborne' && this.velocity.y <= 0) {
      this.land(groundImpact, false);
    } else if (flying) {
      const hard = groundImpact > p.hardLandingSpeed;
      if (hard || wantsDown || preDive) this.land(groundImpact, preDive);
    }
  }

  /**
   * Resolves one contact with normal n (pointing toward the hero) at point p. Returns the
   * downward impact speed for ground contacts (0 for walls).
   */
  private contact(
    nx: number,
    ny: number,
    nz: number,
    px: number,
    py: number,
    pz: number,
    flying: boolean,
  ) {
    const p = config.player;
    // A blocking surface's normal must oppose the attempted move; the controller's reported
    // normals don't have a reliable sign, so orient it here.
    if (nx * _delta.x + ny * _delta.y + nz * _delta.z > 0) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    _n.x = nx;
    _n.y = ny;
    _n.z = nz;
    if (ny > 0.7) {
      // Ground: landing logic decides what happens.
      const impact = -this.velocity.y;
      if (this.velocity.y < 0) this.velocity.y = 0;
      return Math.max(0, impact);
    }
    this.wallContact = true;
    const wallSlam = flying ? p.impactSpeed : Infinity;
    const into = resolveContact(this.velocity, _n, wallSlam, p.impactBounce);
    if (into > wallSlam) {
      this.stats.impacts++;
      events.emit('player:impact', { x: px, y: py, z: pz, nx, ny, nz, speed: into });
      events.emit('camera:shake', { trauma: into * config.camera.shakePerImpactSpeed });
    }
    return 0;
  }

  /** Ray from the capsule centre along a unit direction; fills _n and _hit on a hit. */
  private probe(dx: number, dy: number, dz: number, extra: number) {
    const p = config.player;
    const R = this.physics.R;
    this.ray.origin.x = this.position.x;
    this.ray.origin.y = this.position.y + p.height / 2;
    this.ray.origin.z = this.position.z;
    this.ray.dir.x = dx;
    this.ray.dir.y = dy;
    this.ray.dir.z = dz;
    const reach = p.height / 2 + extra + p.skin * 4;
    const hit = this.physics.world.castRayAndGetNormal(
      this.ray,
      reach,
      true,
      R.QueryFilterFlags.EXCLUDE_DYNAMIC,
      undefined,
      this.collider,
      undefined,
      this.penetrating ? this.passFilter : undefined,
    );
    if (!hit) return false;
    _n.x = hit.normal.x;
    _n.y = hit.normal.y;
    _n.z = hit.normal.z;
    _hit.x = this.ray.origin.x + dx * hit.timeOfImpact;
    _hit.y = this.ray.origin.y + dy * hit.timeOfImpact;
    _hit.z = this.ray.origin.z + dz * hit.timeOfImpact;
    return true;
  }

  /** Ground slam from the air: straight down at `speed`, slamming on impact (DESIGN.md §6.4). */
  startSlamDive(speed: number) {
    this.slamDiving = true;
    this.slamSpeed = speed;
    this.charging = false;
    if (this.state !== 'flying') this.setState('flying');
    this.velocity.x = 0;
    this.velocity.y = -speed;
    this.velocity.z = 0;
    this.diving = true;
  }

  private land(impactSpeed: number, dive: boolean) {
    const p = config.player;
    this.slamDiving = false;
    const hard = impactSpeed > p.hardLandingSpeed;
    this.velocity.y = 0;
    if (hard) {
      // Crouched impact: he stops dead and recovers.
      this.velocity.x *= 0.1;
      this.velocity.z *= 0.1;
      this.landingTimer = p.landingRecovery;
      this.stats.hardLandings++;
    }
    this.diving = false;
    this.setState('grounded');
    events.emit('player:landing', {
      x: this.position.x,
      y: this.position.y,
      z: this.position.z,
      impactSpeed,
      hard,
      dive,
    });
    if (hard)
      events.emit('camera:shake', { trauma: impactSpeed * config.camera.shakePerImpactSpeed });
  }

  private updateSonic() {
    const p = config.player;
    const speed = this.speed;
    if (this.sonicArmed && speed >= p.sonicThreshold) {
      this.sonicArmed = false;
      this.stats.sonicBooms++;
      events.emit('player:sonicBoom', {
        x: this.position.x,
        y: this.position.y + p.height / 2,
        z: this.position.z,
        vx: this.velocity.x,
        vy: this.velocity.y,
        vz: this.velocity.z,
      });
      events.emit('camera:shake', { trauma: config.camera.shakeSonicBoom });
    } else if (!this.sonicArmed && speed < p.sonicThreshold * p.sonicRearm) {
      this.sonicArmed = true;
    }
  }

  /**
   * Never stuck (DESIGN.md §5.2): if the capsule centre ends up inside geometry, or he has been
   * pushing against something without moving for a while, lift him clear.
   */
  private unstickIfNeeded(mx: number, my: number, dt: number) {
    const p = config.player;
    const w = this.physics.world;
    // Going through buildings at sonic speed is meant to be inside them.
    if (this.penetrating) {
      this.stuck = 0;
      return;
    }
    _center.x = this.position.x;
    _center.y = this.position.y + p.height / 2;
    _center.z = this.position.z;
    const proj = w.projectPoint(
      _center,
      true,
      this.physics.R.QueryFilterFlags.EXCLUDE_DYNAMIC,
      undefined,
      this.collider,
    );
    const inside = !!proj?.isInside;

    const moved = Math.hypot(
      this.position.x - this.prevPosition.x,
      this.position.y - this.prevPosition.y,
      this.position.z - this.prevPosition.z,
    );
    // Walking into a wall is normal; only count blocked steps in the air.
    const pushing = this.state !== 'grounded' && Math.abs(mx) + Math.abs(my) > 0.3;
    const expected = Math.max(this.speed * dt, pushing ? 0.02 : 0);
    if (pushing && moved < expected * 0.05) this.stuck++;
    else this.stuck = 0;

    if (!inside && this.stuck < p.stuckSteps) return;
    if (!inside) {
      // Blocked, but if he can still rise he is just pressed against a wall, not wedged.
      this.kcc.computeColliderMovement(
        this.collider,
        _up,
        this.physics.R.QueryFilterFlags.EXCLUDE_DYNAMIC,
      );
      if (this.kcc.computedMovement().y > 0.2) {
        this.stuck = 0;
        return;
      }
    }
    // Find the top surface above this spot and stand him on it.
    const ray = new this.physics.R.Ray(
      { x: _center.x, y: _center.y + 600, z: _center.z },
      { x: 0, y: -1, z: 0 },
    );
    const hit = w.castRay(
      ray,
      1200,
      true,
      this.physics.R.QueryFilterFlags.EXCLUDE_DYNAMIC,
      undefined,
      this.collider,
    );
    const top = hit ? _center.y + 600 - hit.timeOfImpact : this.position.y + 1;
    this.position.y = Math.max(top + 0.05, this.position.y + 0.6);
    this.syncCollider();
    this.stuck = 0;
    this.stats.unstucks++;
    events.emit('player:unstuck', { x: this.position.x, y: this.position.y, z: this.position.z });
  }

  private computeBasis() {
    const cy = Math.cos(this.lookYaw);
    const sy = Math.sin(this.lookYaw);
    const cp = Math.cos(this.lookPitch);
    const sp = Math.sin(this.lookPitch);
    // three.js convention: yaw 0 looks down -Z.
    _fwd.x = -sy * cp;
    _fwd.y = sp;
    _fwd.z = -cy * cp;
    _flat.x = -sy;
    _flat.y = 0;
    _flat.z = -cy;
    _right.x = cy;
    _right.y = 0;
    _right.z = -sy;
    this.lastFlatYaw = this.lookYaw;
  }

  private syncCollider() {
    _colliderPos.x = this.position.x;
    _colliderPos.y = this.position.y + config.player.height / 2;
    _colliderPos.z = this.position.z;
    // Teleport the body and push the pose to its collider now, so the next substep's sweep
    // starts from here rather than from where the last world step left it.
    this.body.setTranslation(_colliderPos, false);
    this.physics.world.propagateModifiedBodyPositionsToColliders();
  }

  private setState(next: PlayerState) {
    if (next === this.state) return;
    const from = this.state;
    this.state = next;
    if (next !== 'flying') this.band = 'hover';
    events.emit('player:state', { from, to: next });
  }

  /** Moves him (feet position) mid-step, e.g. ploughing on into a building as he crashes. */
  shiftTo(x: number, y: number, z: number) {
    this.position.x = x;
    this.position.y = y;
    this.position.z = z;
    this.syncCollider();
  }

  /** Debug: drop to the ground state wherever he is. */
  forceState(s: PlayerState) {
    this.setState(s);
  }

  get flatYaw() {
    return this.lastFlatYaw;
  }
}
