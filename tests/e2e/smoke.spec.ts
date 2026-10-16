import { expect, test, type Page } from '@playwright/test';
import { bootGame, expectNoErrors, hold, shot, trackErrors } from './helpers';

/**
 * Smoke test (DESIGN.md §14.4), M1: walk, leap, take off, hover, cruise, boost through the sonic
 * barrier, slam into a building, dive into the street, and check the camera never clips into
 * geometry. Screenshots of each moment go to test-results/. "Punch a wall" arrives with M2.
 */

const player = (page: Page) => page.evaluate(() => window.__GZ__.player());
const held = (page: Page, ids: string[], on: boolean) =>
  page.evaluate(
    ([list, v]) => (list as string[]).forEach((id) => window.__GZ__.setHeld(id, v as boolean)),
    [ids, on] as const,
  );

async function tap(page: Page, id: string, ms = 60) {
  await held(page, [id], true);
  await page.waitForTimeout(ms);
  await held(page, [id], false);
}

/** Samples the camera while `fn` runs and fails if it is ever inside solid geometry. */
async function watchCamera(page: Page, fn: () => Promise<void>) {
  let inside = 0;
  let running = true;
  const poll = (async () => {
    while (running) {
      if (await page.evaluate(() => window.__GZ__.cameraInsideGeometry())) inside++;
      await page.waitForTimeout(50);
    }
  })();
  await fn();
  running = false;
  await poll;
  return inside;
}

test('M1: flight states, sonic boom, impacts and camera', async ({ page }) => {
  const errors = trackErrors(page);
  const info = await bootGame(page);
  console.log(`backend: ${info.backend}, seed: ${info.seed}`);
  // Movement timing checks below assume steady frames: let the background shader warm-up finish
  // (its one early stall is a known issue, see docs/DECISIONS.md M4 follow-up).
  await page.waitForFunction(() => window.__GZ__.warm === true, undefined, { timeout: 60_000 });
  await page.waitForTimeout(800);
  await shot(page, 'm1-01-start');
  await expect(page.locator('#perf-hud pre')).toContainText('fps');
  await expect(page.locator('#speedometer')).toContainText('m/s');

  // Walk, then run (Shift on the ground).
  await page.evaluate(() => window.__GZ__.setLook(0, -0.1));
  await hold(page, ['KeyW'], 700);
  let p = await player(page);
  expect(p.state).toBe('grounded');
  expect(p.z).toBeLessThan(-2);
  expect(p.y).toBeGreaterThan(-0.05); // standing on the street, not sunk into it
  await hold(page, ['KeyW', 'ShiftLeft'], 900);
  await shot(page, 'm1-02-run');

  // Charged superhuman leap: hold, release, sail over a building, land hard.
  await held(page, ['Space'], true);
  await page.waitForTimeout(900);
  await shot(page, 'm1-03-leap-charge');
  await held(page, ['Space'], false);
  await page.waitForTimeout(700);
  p = await player(page);
  expect(p.state).toBe('airborne');
  expect(p.y).toBeGreaterThan(30);
  await shot(page, 'm1-04-leap-air');
  await expect.poll(async () => (await player(page)).state, { timeout: 8000 }).toBe('grounded');
  p = await player(page);
  expect(p.stats.hardLandings).toBeGreaterThanOrEqual(1);
  await page.waitForTimeout(250);
  await shot(page, 'm1-05-hard-landing');

  // Take off with a double-tap and hover.
  await page.waitForTimeout(500);
  await tap(page, 'Space');
  await page.waitForTimeout(70);
  await tap(page, 'Space');
  await page.waitForTimeout(300);
  expect((await player(page)).state).toBe('flying');
  await hold(page, ['Space'], 900);
  await page.waitForTimeout(600);
  p = await player(page);
  expect(p.speed).toBeLessThan(1); // hover stops dead on release
  await shot(page, 'm1-06-hover');

  // Cruise and boost through the sonic barrier above the rooftops.
  await page.evaluate(() => window.__GZ__.teleportPlayer(0, 200, 300));
  await page.evaluate(() => window.__GZ__.setLook(0, 0));
  const insideDuringFlight = await watchCamera(page, async () => {
    await hold(page, ['KeyW'], 3000);
    p = await player(page);
    expect(p.band).toBe('cruise');
    await shot(page, 'm1-07-cruise');
    await held(page, ['KeyW', 'ShiftLeft'], true);
    await expect.poll(async () => (await player(page)).stats.sonicBooms, { timeout: 8000 }).toBe(1);
    await page.waitForTimeout(100);
    await shot(page, 'm1-08-sonic-boom');
    await page.waitForTimeout(1500);
    await shot(page, 'm1-09-boost');
    await held(page, ['KeyW', 'ShiftLeft'], false);
  });
  p = await player(page);
  expect(p.speed).toBeGreaterThan(130);
  expect(insideDuringFlight).toBe(0);

  // Slam into the tallest tower below sonic speed: bounce, no tunnelling.
  const tower = await page.evaluate(() =>
    window.__GZ__.buildings().reduce((a, b) => (b.h > a.h ? b : a)),
  );
  // Start in the street in front of the tower (60 m back would be inside the next block).
  const startZ = tower.z + tower.d / 2 + 25;
  await page.evaluate(
    ([x, y, z]) => window.__GZ__.teleportPlayer(x!, y!, z!),
    [tower.x, tower.h * 0.5, startZ],
  );
  await page.evaluate(() => window.__GZ__.setLook(0, 0));
  const insideDuringSlam = await watchCamera(page, async () => {
    await held(page, ['KeyW', 'ShiftLeft'], true);
    await expect
      .poll(async () => (await player(page)).stats.impacts, { timeout: 6000 })
      .toBeGreaterThan(0);
    await held(page, ['KeyW', 'ShiftLeft'], false);
    await page.waitForTimeout(150);
    await shot(page, 'm1-10-wall-slam');
    // Hug the wall: the spring arm must pull in rather than clip through the facade.
    await page.evaluate(() => window.__GZ__.setLook(Math.PI / 2, 0));
    await hold(page, ['KeyD'], 600);
    await page.waitForTimeout(300);
    await shot(page, 'm1-11-camera-near-wall');
  });
  p = await player(page);
  expect(p.z).toBeGreaterThan(tower.z + tower.d / 2 - 0.5); // still outside the tower
  expect(insideDuringSlam).toBe(0);

  // Dive into the street: dive slam.
  await page.evaluate(() => window.__GZ__.teleportPlayer(0, 150, 0));
  await page.evaluate(() => window.__GZ__.setLook(0, -1.35));
  await held(page, ['KeyW', 'ShiftLeft'], true);
  await expect.poll(async () => (await player(page)).diving, { timeout: 4000 }).toBe(true);
  await shot(page, 'm1-12-dive');
  await expect.poll(async () => (await player(page)).state, { timeout: 8000 }).toBe('grounded');
  await held(page, ['KeyW', 'ShiftLeft'], false);
  p = await player(page);
  expect(p.stats.hardLandings).toBeGreaterThanOrEqual(2);
  await page.evaluate(() => window.__GZ__.setLook(Math.PI, -0.6));
  await page.waitForTimeout(900);
  await shot(page, 'm1-13-dive-crater');
  expect(p.stats.unstucks).toBe(0);

  // Debug UI still works.
  await page.keyboard.press('F1');
  await expect.poll(() => page.evaluate(() => window.__GZ__.debugPanelVisible())).toBe(true);
  await expect(page.locator('#debug-panel')).toContainText('player');
  await shot(page, 'm1-14-debug-panel');
  await page.keyboard.press('F1');

  const snap = await page.evaluate(() => window.__GZ__.snapshot());
  expect(snap.decals).toBeGreaterThanOrEqual(2);
  await expectNoErrors(errors);
});
