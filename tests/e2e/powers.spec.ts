import { expect, test, type Page } from '@playwright/test';
import { bootGame, expectNoErrors, shot, trackErrors } from './helpers';

/**
 * Smoke test, M4 (DESIGN.md §15): heat vision burns the facade and the room behind it, a sweep
 * cuts pieces in two, the meter overheats; freeze breath frosts facades (brittle), puts out fire;
 * flying through a tower at sonic speed blows a tunnel through it, sprays debris out the far side,
 * and the tower may collapse after; too slow and he crashes to a stop inside.
 */

const powers = (page: Page) => page.evaluate(() => window.__GZ__.powers());
const held = (page: Page, id: string, on: boolean) =>
  page.evaluate(([k, v]) => window.__GZ__.setHeld(k as string, v as boolean), [id, on] as const);
async function tap(page: Page, id: string, ms = 50) {
  await held(page, id, true);
  await page.waitForTimeout(ms);
  await held(page, id, false);
}
const near = (b: { x0: number; x1: number; z0: number; z1: number }) =>
  Math.hypot((b.x0 + b.x1) / 2, (b.z0 + b.z1) / 2);

test('M4: heat vision, freeze breath, sonic fly-through', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = trackErrors(page);
  await bootGame(page);
  await page.waitForFunction(() => window.__GZ__.warm === true, undefined, { timeout: 60_000 });
  const all = await page.evaluate(() => window.__GZ__.structures());
  const mids = all
    .filter((b) => b.district === 'mid' && b.floors >= 8)
    .sort((a, b) => near(a) - near(b));

  // --- Heat vision on a facade: scorch, glow, burn through, and the room behind catches fire.
  const wall = mids[0]!;
  const wx = (wall.x0 + wall.x1) / 2;
  await page.evaluate(([x, z]) => window.__GZ__.teleportPlayer(x!, 8, z!), [wx, wall.z0 - 18]);
  await page.evaluate(() => window.__GZ__.setLook(Math.PI, -0.02));
  await page.waitForTimeout(600);
  await held(page, 'Mouse2', true);
  await page.waitForTimeout(700);
  await shot(page, 'm4-01-heat-vision');
  const firing = await powers(page);
  expect(firing.heat.firing).toBe(true);
  // On the facade, or through the hole it burned onto what's behind / falling out.
  expect(firing.heat.target).not.toBe('none');
  await page.waitForTimeout(800);
  await held(page, 'Mouse2', false);
  let p = await powers(page);
  console.log('heat on facade', JSON.stringify(p.heat), 'hot', p.hotPieces, 'decals', p.decals);
  expect(p.heat.target).toBe('none'); // released
  expect(p.heat.piecesBurned).toBeGreaterThan(0);
  expect(p.decals).toBeGreaterThan(0);
  await expect
    .poll(async () => (await page.evaluate(() => window.__GZ__.interiors())).burning, {
      timeout: 3000,
    })
    .toBeGreaterThan(0);
  await page.waitForTimeout(400);
  await shot(page, 'm4-02-scar-cooling');

  // --- Sweep: the beam cuts a line across a facade; pieces it burns through are sliced in two.
  const cutB = mids[1]!;
  const cx = (cutB.x0 + cutB.x1) / 2;
  const width = cutB.x1 - cutB.x0;
  const dist = 22;
  await page.evaluate(([x, z]) => window.__GZ__.teleportPlayer(x!, 5, z!), [cx, cutB.z0 - dist]);
  const half = Math.atan2(width / 2, dist);
  await page.evaluate((y) => window.__GZ__.setLook(y, -0.08), Math.PI - half);
  await page.waitForTimeout(500);
  await held(page, 'Mouse2', true);
  const steps = 60;
  for (let i = 0; i <= steps; i++) {
    await page.evaluate(
      (y) => window.__GZ__.setLook(y, -0.08),
      Math.PI - half + (2 * half * i) / steps,
    );
    await page.waitForTimeout(50);
    if (i === 30) await shot(page, 'm4-03-heat-sweep');
  }
  // Keep firing until the meter overheats (forced cooldown).
  await expect.poll(async () => (await powers(page)).heat.locked, { timeout: 9000 }).toBe(true);
  await held(page, 'Mouse2', false);
  p = await powers(page);
  console.log('sweep', JSON.stringify(p.heat));
  expect(p.heat.piecesCut).toBeGreaterThan(0);
  expect(p.heat.overheats).toBeGreaterThanOrEqual(1);
  await page.waitForTimeout(300);
  await shot(page, 'm4-04-cut-line');

  // --- Freeze breath: set a room on fire, breathe on it: fire out, facade frozen and brittle.
  const iceB = mids[2]!;
  const ix = (iceB.x0 + iceB.x1) / 2;
  await page.evaluate(([x, z]) => window.__GZ__.igniteAt(x!, 9, z! + 3), [ix, iceB.z0]);
  await page.waitForTimeout(1500);
  const burningBefore = (await page.evaluate(() => window.__GZ__.interiors())).burning;
  expect(burningBefore).toBeGreaterThan(0);
  await page.evaluate(([x, z]) => window.__GZ__.teleportPlayer(x!, 7.6, z!), [ix, iceB.z0 - 6]);
  await page.evaluate(() => window.__GZ__.setLook(Math.PI, -0.05));
  await page.waitForTimeout(500);
  await held(page, 'KeyF', true);
  await page.waitForTimeout(900);
  await shot(page, 'm4-05-freeze-breath');
  await page.waitForTimeout(900);
  await held(page, 'KeyF', false);
  p = await powers(page);
  console.log('breath', JSON.stringify(p.breath), 'frozen', p.frozenPieces);
  expect(p.frozenPieces).toBeGreaterThan(0);
  expect(p.breath.level).toBeLessThan(0.9);
  expect(p.breath.firesOut).toBeGreaterThan(0);
  await shot(page, 'm4-06-frozen-facade');
  // Brittle: one jab on the frozen concrete/brick panel cracks it heavily (double damage).
  await page.evaluate(([x, z]) => window.__GZ__.teleportPlayer(x!, 7.5, z!), [ix, iceB.z0 - 1.6]);
  await page.waitForTimeout(400);
  const target = [ix, 9.3, iceB.z0 + 0.15] as const;
  const frozenPanel = await page.evaluate(
    ([x, y, z]) => window.__GZ__.pieceAt(x, y, z, 0.6),
    target,
  );
  expect(frozenPanel).not.toBeNull();
  const th = await page.evaluate((id) => window.__GZ__.pieceThermal(id), frozenPanel!.id);
  console.log('panel', JSON.stringify(frozenPanel), JSON.stringify(th));
  expect(th.frozen).toBeGreaterThan(0);
  if (frozenPanel!.material !== 3) {
    await tap(page, 'Mouse0');
    await page.waitForTimeout(300);
    const after = await page.evaluate((id) => window.__GZ__.pieceState(id), frozenPanel!.id);
    console.log('frozen panel after one jab', JSON.stringify(after));
    expect(after.state).toBeGreaterThanOrEqual(2);
  }

  // --- Energy ball: a full charge takes a section out of a building; a tap is a small burst.
  const ballB = mids.slice(5).find((b) => {
    const x = (b.x0 + b.x1) / 2;
    return !all.some(
      (o) => o.index !== b.index && x > o.x0 - 2 && x < o.x1 + 2 && o.z1 > b.z0 - 40 && o.z0 < b.z0,
    );
  })!;
  const bx = (ballB.x0 + ballB.x1) / 2;
  const ballBefore = await page.evaluate((i) => window.__GZ__.buildingIntact(i), ballB.index);
  await page.evaluate(([x, z]) => window.__GZ__.teleportPlayer(x!, 14, z!), [bx, ballB.z0 - 32]);
  await page.evaluate(() => window.__GZ__.setLook(Math.PI, -0.04));
  await page.waitForTimeout(500);
  await held(page, 'KeyG', true);
  await page.waitForTimeout(1900);
  p = await powers(page);
  expect(p.energy.charging).toBe(true);
  expect(p.energy.charge).toBe(1);
  await shot(page, 'm4-12-energy-charged');
  await held(page, 'KeyG', false);
  await expect.poll(async () => (await powers(page)).energy.blasts, { timeout: 3000 }).toBe(1);
  await page.waitForTimeout(150);
  await shot(page, 'm4-13-energy-blast');
  await page.waitForTimeout(1200);
  p = await powers(page);
  console.log('energy ball', JSON.stringify(p.energy));
  expect(p.energy.lastRadius).toBeGreaterThan(12);
  expect(p.energy.piecesDestroyed).toBeGreaterThan(60);
  const ballAfter = await page.evaluate((i) => window.__GZ__.buildingIntact(i), ballB.index);
  console.log('ball building static pieces', ballBefore.staticPieces, '→', ballAfter.staticPieces);
  expect(ballAfter.staticPieces).toBeLessThan(ballBefore.staticPieces - 60);
  await shot(page, 'm4-14-energy-crater');
  // A tap throws a small ball.
  await page.evaluate(() => window.__GZ__.setLook(Math.PI + 0.25, -0.04));
  await page.waitForTimeout(300);
  await tap(page, 'KeyG', 60);
  await expect.poll(async () => (await powers(page)).energy.blasts, { timeout: 3000 }).toBe(2);
  p = await powers(page);
  expect(p.energy.lastRadius).toBeLessThan(7);

  // --- Sonic fly-through: straight through the tallest tower and out the far side.
  const tower = all
    .filter((b) => b.district === 'downtown')
    .sort((a, b) => b.height - a.height)[0]!;
  const tx = (tower.x0 + tower.x1) / 2;
  const tz = (tower.z0 + tower.z1) / 2;
  const ty = Math.min(tower.height * 0.3, 40);
  const startZ = tower.z0 - 70;
  // High side vantage (above every building), looking down at the tower's middle.
  const vx = tx + 150;
  const vy = tower.height + 25;
  const vPitch = -Math.atan2(vy - tower.height * 0.45, 150);
  const intactBefore = await page.evaluate((i) => window.__GZ__.buildingIntact(i), tower.index);
  await page.evaluate(([x, y, z]) => window.__GZ__.teleportPlayer(x!, y!, z!), [tx, ty, startZ]);
  await page.evaluate(() => window.__GZ__.setLook(Math.PI, 0));
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__GZ__.setPlayerVelocity(0, 0, 150));
  await held(page, 'ShiftLeft', true);
  await expect
    .poll(async () => (await powers(page)).fly.buildings, { timeout: 3000, intervals: [20] })
    .toBeGreaterThan(0);
  await shot(page, 'm4-07-tunnel-entry');
  // Out the far side: stop there (teleport to the vantage) so he doesn't chain into the next one.
  await page.evaluate(
    async ([x, y, z, yaw, pitch]) => {
      const g = window.__GZ__;
      while (g.powers().fly.exits < 1) await new Promise((r) => requestAnimationFrame(r));
      g.setHeld('ShiftLeft', false);
      g.teleportPlayer(x!, y!, z!);
      g.setLook(yaw!, pitch!);
    },
    [vx, vy, tz, Math.atan2(vx - tx, 0), vPitch],
  );
  p = await powers(page);
  console.log('fly-through', JSON.stringify(p.fly));
  expect(p.fly.buildings).toBeGreaterThanOrEqual(1);
  expect(p.fly.crashes).toBe(0);
  expect(p.fly.piecesDestroyed).toBeGreaterThan(10);
  const intactAfter = await page.evaluate((i) => window.__GZ__.buildingIntact(i), tower.index);
  expect(intactAfter.staticPieces).toBeLessThan(intactBefore.staticPieces);
  await page.waitForTimeout(250);
  await shot(page, 'm4-08-tunnel-spray');
  // The tunnelled tower creaks, sags and comes down after the delay.
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.__GZ__.failingBuildings())).includes(tower.index),
      {
        timeout: 5000,
      },
    )
    .toBe(true);
  await page.waitForTimeout(500);
  await shot(page, 'm4-09-tunnelled-tower-failing');
  await expect
    .poll(async () => (await page.evaluate(() => window.__GZ__.destruction())).clusters, {
      timeout: 12000,
    })
    .toBeGreaterThan(0);
  await page.waitForTimeout(2500);
  await shot(page, 'm4-10-tower-collapsing');

  // --- Too slow: he crashes to a stop inside, and isn't stuck.
  // A building with a clear 25 m run-up in front of its south face.
  const clear = (b: (typeof mids)[number]) => {
    const x = (b.x0 + b.x1) / 2;
    return !all.some(
      (o) => o.index !== b.index && x > o.x0 - 2 && x < o.x1 + 2 && o.z1 > b.z0 - 26 && o.z0 < b.z0,
    );
  };
  const slowB = mids.slice(3).find(clear)!;
  const sx = (slowB.x0 + slowB.x1) / 2;
  await page.evaluate(([x, z]) => window.__GZ__.teleportPlayer(x!, 12, z!), [sx, slowB.z0 - 20]);
  await page.evaluate(() => window.__GZ__.setLook(Math.PI, 0));
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__GZ__.setPlayerVelocity(0, 0, 118));
  await held(page, 'ShiftLeft', true);
  await expect.poll(async () => (await powers(page)).fly.crashes, { timeout: 3000 }).toBe(1);
  await held(page, 'ShiftLeft', false);
  await page.waitForTimeout(600);
  const pl = await page.evaluate(() => window.__GZ__.player());
  console.log('after crash', JSON.stringify(pl));
  expect(pl.z).toBeGreaterThan(slowB.z0 - 1);
  expect(pl.y).toBeLessThan(25); // not popped up onto the roof
  await page.evaluate(() => window.__GZ__.setLook(Math.PI + 2.5, -0.1));
  await page.waitForTimeout(500);
  await shot(page, 'm4-11-crashed-inside');
  // He can fly straight back out the way he came.
  await page.evaluate(() => window.__GZ__.setLook(0, 0));
  await held(page, 'KeyW', true);
  await page.waitForTimeout(1500);
  await held(page, 'KeyW', false);
  const out = await page.evaluate(() => window.__GZ__.player());
  expect(out.z).toBeLessThan(pl.z - 3);

  const snap = await page.evaluate(() => window.__GZ__.snapshot());
  console.log(`fps ${snap.fps.toFixed(0)}  particles ${snap.particles}  decals ${snap.decals}`);
  await expectNoErrors(errors);
});
