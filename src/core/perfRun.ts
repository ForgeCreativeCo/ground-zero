import { Vector3 } from 'three/webgpu';
import { config } from '../config';
import type { Game } from './game';
import type { PerfResult } from './perfRecorder';

/**
 * Scripted perf path (npm run perf): the hero boost-flies a loop over the city at 190 m (above
 * the tallest tower, with the whole city in view), through the sonic barrier, with the real input pipeline and camera, while
 * physics bodies rain down. Later milestones add destruction and a Nova to this path.
 */
export function runPerfPath(game: Game, seconds = config.perf.runSeconds): Promise<PerfResult> {
  return new Promise((resolve) => {
    const input = game.input;
    let t = 0;
    let spawned = 0;
    const toSpawn = config.perf.spawnBodies;
    let warmup = 0.75;
    // Destruction script: [time fraction, action].
    const bs = game.destruction.city.buildings;
    const tower = bs.reduce((a, b) => (b.height > a.height ? b : a));
    const mid = bs.filter((b) => b.src.district === 'mid').sort((a, b) => b.floors - a.floors)[0]!;
    const events: [number, () => void][] = [
      [0.05, () => game.destruction.cutStory(tower.id, 4, 1)],
      [0.15, () => game.destruction.cutStory(mid.id, 1, 1)],
      [0.3, () => game.slamAt((mid.x0 + mid.x1) / 2 + 30, 0, mid.z0 - 12, 90, true)],
      [0.45, () => game.slamAt((tower.x0 + tower.x1) / 2 - 40, 0, tower.z0 - 12, 120, true)],
    ];
    let nextEvent = 0;
    // Start south of downtown heading west; a steady left turn circles the centre.
    const radius = config.city.blockSize * 2.5;
    game.teleport(0, cruiseAltitude, -radius);
    game.rig.yaw = Math.PI / 2;
    game.rig.pitch = 0;
    game.onFrame = (dt) => {
      if (warmup > 0) {
        warmup -= dt;
        if (warmup <= 0) {
          game.recorder.start();
          input.setHeld('KeyW', true);
          input.setHeld('ShiftLeft', true);
        }
        return;
      }
      t += dt;
      const u = Math.min(t / seconds, 1);
      // Turn steadily (a loop over the city) and hold altitude.
      game.rig.yaw += dt * ((Math.PI * 2) / seconds);
      const y = game.player.position.y;
      game.rig.pitch = Math.max(-0.35, Math.min(0.35, (cruiseAltitude - y) * 0.01));
      while (nextEvent < events.length && u >= events[nextEvent]![0]) events[nextEvent++]![1]();
      const due = Math.floor(Math.min(1, u * 2) * toSpawn);
      if (due > spawned) {
        game.testBodies.spawn(due - spawned, center);
        spawned = due;
      }
      if (u >= 1) {
        game.onFrame = null;
        input.setHeld('KeyW', false);
        input.setHeld('ShiftLeft', false);
        resolve(game.recorder.stop());
      }
    };
  });
}

const center = new Vector3(0, 30, 0);
/** Above the tallest downtown tower (175 m max). */
const cruiseAltitude = 190;
