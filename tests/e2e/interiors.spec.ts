import { expect, test, type Page } from '@playwright/test';
import { bootGame, expectNoErrors, shot, trackErrors } from './helpers';

/**
 * Smoke test, M3 (DESIGN.md §15): breaching a wall reveals furnished rooms; punches smash the
 * furniture; a fire spreads from room to room; cutting a building's columns knocks its power out
 * floor by floor; the collapse starts fires in the rubble.
 */

const interiors = (page: Page) => page.evaluate(() => window.__GZ__.interiors());
const held = (page: Page, id: string, on: boolean) =>
  page.evaluate(([k, v]) => window.__GZ__.setHeld(k as string, v as boolean), [id, on] as const);
async function tap(page: Page, id: string, ms = 50) {
  await held(page, id, true);
  await page.waitForTimeout(ms);
  await held(page, id, false);
}

test('M3: furnished interiors, fire spread, power failure, collapse fires', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = trackErrors(page);
  await bootGame(page);
  const all = await page.evaluate(() => window.__GZ__.structures());
  const mids = all
    .filter((b) => b.district === 'mid' && b.floors >= 8)
    .sort(
      (a, b) =>
        Math.hypot((a.x0 + a.x1) / 2, (a.z0 + a.z1) / 2) -
        Math.hypot((b.x0 + b.x1) / 2, (b.z0 + b.z1) / 2),
    );
  const wall = mids[0]!;
  const wx = (wall.x0 + wall.x1) / 2;
  const before = await interiors(page);
  expect(before.spawnedUnits).toBe(0); // nothing furnished until something breaks in

  // --- Breach a wall: the rooms behind it get furnished.
  await page.evaluate(([x, z]) => window.__GZ__.teleportPlayer(x!, 7.5, z!), [wx, wall.z0 - 1.6]);
  await page.evaluate(() => window.__GZ__.setLook(Math.PI, -0.05));
  await page.waitForTimeout(800);
  for (let i = 0; i < 5; i++) {
    await tap(page, 'Mouse0');
    await page.waitForTimeout(280);
  }
  await expect
    .poll(async () => (await interiors(page)).spawnedUnits, { timeout: 3000 })
    .toBeGreaterThan(0);
  let s = await interiors(page);
  console.log('after breach', JSON.stringify(s));
  expect(s.props).toBeGreaterThan(20);
  await shot(page, 'm3-01-breach');

  // --- Fly in: the room around the hero is a real, furnished unit; punches smash furniture.
  await held(page, 'KeyW', true);
  await page.waitForTimeout(900);
  await held(page, 'KeyW', false);
  await page.waitForTimeout(500);
  const p = await page.evaluate(() => window.__GZ__.player());
  const unit = await page.evaluate(
    ([x, y, z]) => window.__GZ__.unitAt(x!, y!, z!),
    [p.x, p.y + 1, p.z],
  );
  expect(unit).not.toBeNull();
  expect(unit!.spawned).toBe(true);
  await page.evaluate(() => window.__GZ__.setLook(Math.PI - 0.6, -0.15));
  await page.waitForTimeout(400);
  await shot(page, 'm3-02-inside');
  const smashedBefore = (await interiors(page)).propsDestroyed;
  await page.evaluate(() => window.__GZ__.setLook(Math.PI, -0.5));
  for (let i = 0; i < 3; i++) {
    await tap(page, 'Mouse0');
    await page.waitForTimeout(280);
  }
  s = await interiors(page);
  expect(s.propsDestroyed).toBeGreaterThanOrEqual(smashedBefore);
  expect(s.propsDestroyed).toBeGreaterThan(0);

  // --- Fire: set the room alight, back off, watch it spread to other rooms.
  await page.evaluate(([x, y, z]) => window.__GZ__.igniteAt(x!, y!, z!), [p.x, p.y + 1, p.z]);
  expect((await interiors(page)).burning).toBeGreaterThan(0);
  await page.evaluate(
    ([x, z]) => window.__GZ__.teleportPlayer(x!, 20, z!),
    [wx + 10, wall.z0 - 35],
  );
  await page.evaluate(() => window.__GZ__.setLook(Math.PI + 0.25, -0.2));
  await expect
    .poll(async () => (await interiors(page)).burning, { timeout: 20000 })
    .toBeGreaterThan(3);
  s = await interiors(page);
  console.log('fire', JSON.stringify(s));
  await shot(page, 'm3-03-fire-spreading');

  // --- Power: cut a building's ground-floor columns; the outage spreads up floor by floor.
  const target = mids[1]!;
  const tx = (target.x0 + target.x1) / 2;
  const tz = (target.z0 + target.z1) / 2;
  const outagesBefore = (await interiors(page)).outages;
  const firesBefore = (await interiors(page)).openFires;
  const [vx, vy, vz] = [tx + 25, 200, tz - 45];
  await page.evaluate(([x, y, z]) => window.__GZ__.teleportPlayer(x!, y!, z!), [vx, vy, vz]);
  const yaw = Math.atan2(-(tx - vx), -(tz - vz));
  const pitch = -Math.atan2(vy - target.height * 0.3, Math.hypot(tx - vx, tz - vz));
  await page.evaluate(([y, p]) => window.__GZ__.setLook(y!, p!), [yaw, pitch]);
  await page.evaluate((i) => window.__GZ__.cutStory(i, 1, 1), target.index);
  await expect
    .poll(async () => (await interiors(page)).outages, { timeout: 3000 })
    .toBeGreaterThan(outagesBefore);
  // Floors near the cut go dark first, the top floor later.
  const low = await page.evaluate((i) => window.__GZ__.floorPower(i, 1), target.index);
  const top = await page.evaluate(
    ([i, f]) => window.__GZ__.floorPower(i!, f!),
    [target.index, target.floors - 1],
  );
  console.log('power low/top right after the cut', low, top);
  expect(low).toBeLessThan(1);
  expect(top).toBeGreaterThan(low);

  // --- The collapse starts fires in the rubble.
  await expect
    .poll(
      async () => {
        const i = await interiors(page);
        return i.openFires + i.burning;
      },
      { timeout: 20000 },
    )
    .toBeGreaterThan(firesBefore + s.burning);
  await page.waitForTimeout(1500);
  await shot(page, 'm3-04-collapse-fires');

  await expectNoErrors(errors);
});
