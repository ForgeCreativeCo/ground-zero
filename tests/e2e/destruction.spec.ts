import { expect, test, type Page } from '@playwright/test';
import { bootGame, expectNoErrors, shot, trackErrors } from './helpers';

/**
 * Smoke test, M2 (DESIGN.md §15): punching cracks then holes a wall; cutting a building's supports
 * makes it creak, sag and collapse; debris stays; grab/throw and slams wreck things.
 */

const d = (page: Page) => page.evaluate(() => window.__GZ__.destruction());
const held = (page: Page, id: string, on: boolean) =>
  page.evaluate(([k, v]) => window.__GZ__.setHeld(k as string, v as boolean), [id, on] as const);
async function tap(page: Page, id: string, ms = 50) {
  await held(page, id, true);
  await page.waitForTimeout(ms);
  await held(page, id, false);
}

test('M2: punch, collapse, debris persists, grab/throw, slams', async ({ page }) => {
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

  // --- Punch a wall: cracked → heavily cracked → breached (hole) → destroyed.
  await page.evaluate(([x, z]) => window.__GZ__.teleportPlayer(x!, 7.5, z!), [wx, wall.z0 - 1.6]);
  await page.evaluate(() => window.__GZ__.setLook(Math.PI, -0.05));
  await page.waitForTimeout(800);
  const panelPoint = [wx, 9, wall.z0 + 0.15] as const;
  const states: number[] = [];
  for (let i = 0; i < 4; i++) {
    await tap(page, 'Mouse0');
    await page.waitForTimeout(280);
    const piece = await page.evaluate(
      ([x, y, z]) => window.__GZ__.pieceAt(x, y, z, 0.6),
      panelPoint,
    );
    states.push(piece ? piece.state : 4);
    await shot(page, `m2-0${i + 1}-punch`);
  }
  console.log('punch states', states.join(' → '));
  expect(states[0]).toBe(1); // cracked
  expect(states[1]).toBe(2); // heavily cracked
  expect(states[2]).toBeGreaterThanOrEqual(3); // breached: a hole
  expect(states[3]).toBe(4); // destroyed
  let s = await d(page);
  expect(s.bill).toBeGreaterThan(0);

  // --- Cut a building's supports: creak (failing), sag (falling section), collapse, rubble.
  const target = mids[1]!;
  const tx = (target.x0 + target.x1) / 2;
  // Watch from a high diagonal vantage, aimed straight at the building's mid-height.
  const tz = (target.z0 + target.z1) / 2;
  const vx = tx + 25;
  const vz = tz - 45;
  const vy = 200;
  await page.evaluate(([x, y, z]) => window.__GZ__.teleportPlayer(x!, y!, z!), [vx, vy, vz]);
  const yaw = Math.atan2(-(tx - vx), -(tz - vz));
  const pitch = -Math.atan2(vy - target.height * 0.4, Math.hypot(tx - vx, tz - vz));
  await page.evaluate(([y, p]) => window.__GZ__.setLook(y!, p!), [yaw, pitch]);
  await page.waitForTimeout(600);
  const intactBefore = await page.evaluate((i) => window.__GZ__.buildingIntact(i), target.index);
  await page.evaluate((i) => window.__GZ__.cutStory(i, 1, 1), target.index);
  await expect.poll(async () => (await d(page)).failing, { timeout: 3000 }).toBe(1);
  await page.waitForTimeout(300);
  await shot(page, 'm2-05-cut-creaking');
  await expect.poll(async () => (await d(page)).clusters, { timeout: 8000 }).toBeGreaterThan(0);
  await shot(page, 'm2-06-sagging');
  await expect.poll(async () => (await d(page)).failing, { timeout: 10000 }).toBe(0);
  await page.waitForTimeout(800);
  await shot(page, 'm2-07-collapsing');
  await expect.poll(async () => (await d(page)).clusters, { timeout: 15000 }).toBe(0);
  const intactAfter = await page.evaluate((i) => window.__GZ__.buildingIntact(i), target.index);
  console.log('static pieces', intactBefore.staticPieces, '→', intactAfter.staticPieces);
  expect(intactAfter.staticPieces).toBeLessThan(intactBefore.staticPieces * 0.5);
  await page.waitForTimeout(1500);
  await shot(page, 'm2-08-collapsed');

  // --- Debris stays: rubble only ever grows, and settles (bodies go to sleep / static).
  const r1 = (await d(page)).rubble;
  await page.waitForTimeout(6000);
  s = await d(page);
  expect(r1).toBeGreaterThan(50);
  expect(s.rubble).toBeGreaterThanOrEqual(r1);
  expect(s.active).toBeLessThan(80);
  await shot(page, 'm2-09-rubble-persists');

  // --- Grab a panel, throw it across the street at another building.
  await page.evaluate(
    ([x, z]) => window.__GZ__.teleportPlayer(x!, 11, z!),
    [wx + 9, wall.z0 - 1.6],
  );
  await page.evaluate(() => window.__GZ__.setLook(Math.PI, -0.05));
  await page.waitForTimeout(500);
  await tap(page, 'KeyE');
  await expect.poll(async () => (await d(page)).holding, { timeout: 2000 }).toBe(true);
  await shot(page, 'm2-10-carrying');
  await page.evaluate(() => window.__GZ__.setLook(0, 0.02));
  await page.waitForTimeout(400);
  const billBeforeThrow = (await d(page)).bill;
  await tap(page, 'Mouse0');
  await page.waitForTimeout(2200);
  s = await d(page);
  expect(s.strength.throws).toBe(1);
  console.log('throw damage $', Math.round(s.bill - billBeforeThrow));
  expect(s.bill).toBeGreaterThan(billBeforeThrow);

  // --- Ground slam and dive slam: craters and wrecked ground floors.
  await page.evaluate(([x, z]) => window.__GZ__.teleportPlayer(x!, 0, z!), [wx - 10, wall.z0 - 9]);
  await page.evaluate(() => window.__GZ__.setLook(0.6, -0.4));
  await page.waitForTimeout(500);
  await tap(page, 'KeyQ');
  await page.waitForTimeout(500);
  await shot(page, 'm2-11-ground-slam');
  await page.evaluate(
    ([x, z]) => window.__GZ__.teleportPlayer(x!, 110, z!),
    [wx + 30, wall.z0 - 12],
  );
  await page.waitForTimeout(300);
  await tap(page, 'KeyQ');
  await expect.poll(async () => (await d(page)).craters, { timeout: 6000 }).toBe(2);
  await page.evaluate(() => window.__GZ__.setLook(Math.PI, -0.6));
  await page.waitForTimeout(900);
  await shot(page, 'm2-12-dive-slam-crater');
  s = await d(page);
  expect(s.strength.slams).toBe(2);

  // --- Never stuck: fly through the collapse rubble and around; he keeps moving.
  await page.evaluate(
    ([x, z]) => window.__GZ__.teleportPlayer(x!, 3, z!),
    [tx, (target.z0 + target.z1) / 2],
  );
  await page.evaluate(() => window.__GZ__.setLook(0, 0.1));
  await held(page, 'KeyW', true);
  await page.waitForTimeout(1500);
  await held(page, 'KeyW', false);
  const p = await page.evaluate(() => window.__GZ__.player());
  expect(Math.hypot(p.x - tx, p.z - (target.z0 + target.z1) / 2)).toBeGreaterThan(5);
  expect(await page.evaluate(() => window.__GZ__.cameraInsideGeometry())).toBe(false);

  const snap = await page.evaluate(() => window.__GZ__.snapshot());
  console.log(
    `fps ${snap.fps.toFixed(0)}  pieces shown ${snap.piecesShown}  colliders ${snap.colliders}  rubble ${snap.rubble}`,
  );
  await expectNoErrors(errors);
});
