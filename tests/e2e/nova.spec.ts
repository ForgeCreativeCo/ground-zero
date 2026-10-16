import { expect, test, type Page } from '@playwright/test';
import { bootGame, expectNoErrors, shot, trackErrors } from './helpers';

/**
 * Smoke test, M8 (DESIGN.md §15): the Nova. The meter fills from property damage; holding R
 * winds up (he can't move, letting go cancels); the release whites out the screen, the front
 * levels several blocks in readable zones, and the mushroom cloud reads from across the city.
 */

const nova = (page: Page) => page.evaluate(() => window.__GZ__.nova());
const held = (page: Page, id: string, on: boolean) =>
  page.evaluate(([k, v]) => window.__GZ__.setHeld(k as string, v as boolean), [id, on] as const);

test('M8: Nova wind-up, release, zones, mushroom cloud', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = trackErrors(page);
  await bootGame(page);
  await page.waitForFunction(() => window.__GZ__.warm === true, undefined, { timeout: 60_000 });
  const all = await page.evaluate(() => window.__GZ__.structures());

  // --- Empty meter: holding R does nothing. Property damage fills it.
  let n = await nova(page);
  expect(n.meter).toBe(0);
  await held(page, 'KeyR', true);
  await page.waitForTimeout(400);
  expect((await nova(page)).phase).toBe('idle');
  await held(page, 'KeyR', false);
  const mid = all.filter((b) => b.district === 'mid').sort((a, b) => b.floors - a.floors)[0]!;
  await page.evaluate((i) => window.__GZ__.cutStory(i, 1, 1), mid.index);
  await page.waitForTimeout(500);
  n = await nova(page);
  console.log('meter after cutting supports', n.meter.toFixed(3));
  expect(n.meter).toBeGreaterThan(0);

  // --- Wind-up from 30 m over the middle of downtown; letting go early cancels.
  const down = all.filter((b) => b.district === 'downtown');
  const cx = down.reduce((a, b) => a + (b.x0 + b.x1) / 2, 0) / down.length;
  const cz = down.reduce((a, b) => a + (b.z0 + b.z1) / 2, 0) / down.length;
  await page.evaluate(() => window.__GZ__.fillNova());
  await page.evaluate(([x, z]) => window.__GZ__.teleportPlayer(x!, 30, z!), [cx, cz - 6]);
  await page.evaluate(() => window.__GZ__.setLook(0, -0.25));
  await page.waitForTimeout(400);
  await held(page, 'KeyR', true);
  await page.waitForTimeout(800);
  n = await nova(page);
  expect(n.phase).toBe('windup');
  expect(n.locked).toBe(true);
  await held(page, 'KeyR', false);
  await page.waitForTimeout(200);
  n = await nova(page);
  expect(n.phase).toBe('idle');
  expect(n.cancels).toBe(1);
  expect(n.meter).toBe(1); // cancelling keeps the charge

  // --- Full wind-up: he can't be moved; it goes off.
  const before = await page.evaluate(() => window.__GZ__.destruction());
  const p0 = await page.evaluate(() => window.__GZ__.player());
  await held(page, 'KeyR', true);
  await held(page, 'KeyW', true);
  await page.waitForTimeout(1800);
  await shot(page, 'm8-01-windup');
  const p1 = await page.evaluate(() => window.__GZ__.player());
  expect(Math.hypot(p1.x - p0.x, p1.z - p0.z)).toBeLessThan(2);
  await held(page, 'KeyW', false);
  await expect
    .poll(async () => (await nova(page)).releases, { timeout: 3000, intervals: [20] })
    .toBe(1);
  await held(page, 'KeyR', false);
  // Frame times from the release until the front has passed everything (log only: this laptop is
  // far below the reference hardware the 30 fps target is for).
  await page.evaluate(() => {
    const w = window as unknown as { __ft: number[] };
    w.__ft = [];
    let last = performance.now();
    const f = () => {
      const now = performance.now();
      w.__ft.push(now - last);
      last = now;
      if (window.__GZ__.nova().phase !== 'idle') requestAnimationFrame(f);
    };
    requestAnimationFrame(f);
  });
  await shot(page, 'm8-02-flash');
  n = await nova(page);
  expect(n.meter).toBe(0);
  await page.waitForTimeout(450);
  await shot(page, 'm8-03-shockwave');
  await page.waitForTimeout(700);
  await shot(page, 'm8-04-front');
  await expect.poll(async () => (await nova(page)).phase, { timeout: 30_000 }).toBe('idle');
  const ft = await page.evaluate(() => (window as unknown as { __ft: number[] }).__ft.slice(1));
  const sorted = [...ft].sort((a, b) => a - b);
  console.log(
    `nova frames ${ft.length}: avg ${(ft.reduce((a, b) => a + b, 0) / ft.length).toFixed(1)} ms, p95 ${sorted[Math.floor(sorted.length * 0.95)]!.toFixed(1)} ms, max ${sorted[sorted.length - 1]!.toFixed(1)} ms`,
  );
  n = await nova(page);
  const after = await page.evaluate(() => window.__GZ__.destruction());
  console.log(
    'nova',
    JSON.stringify(n),
    'bill',
    Math.round(before.bill),
    '→',
    Math.round(after.bill),
  );
  expect(n.destroyed).toBeGreaterThan(3000);
  expect(n.cloud).toBe(true);

  // Zones: buildings in the core are gone; ones at the fringe still stand with windows blown.
  const zone = (b: (typeof all)[number]) =>
    Math.hypot((b.x0 + b.x1) / 2 - cx, (b.z0 + b.z1) / 2 - cz);
  const core = all.filter((b) => zone(b) < 30);
  // Wholly beyond the radius (nearest wall more than 210 m out) but within the fringe (300 m).
  const nearest = (b: (typeof all)[number]) =>
    Math.hypot(Math.max(b.x0 - cx, 0, cx - b.x1), Math.max(b.z0 - cz, 0, cz - b.z1));
  const fringe = all.filter((b) => b.index !== mid.index && nearest(b) > 210 && zone(b) < 280);
  for (const b of core) {
    const left = await page.evaluate((i) => window.__GZ__.buildingIntact(i), b.index);
    expect(left.staticPieces, `core building ${b.index}`).toBeLessThan(left.total * 0.2);
  }
  for (const b of fringe.slice(0, 3)) {
    const left = await page.evaluate((i) => window.__GZ__.buildingIntact(i), b.index);
    expect(left.staticPieces, `fringe building ${b.index}`).toBeGreaterThan(left.total * 0.8);
  }

  // --- Aftermath from across the city (free camera, so the hero isn't in the shot).
  const look = (x: number, y: number, z: number, tx: number, ty: number, tz: number) => [
    x,
    y,
    z,
    Math.atan2(-(tx - x), -(tz - z)),
    Math.atan2(ty - y, Math.hypot(tx - x, tz - z)),
  ];
  await page.evaluate(() => (window.__GZ__.config.debug.freeCamera = true));
  await page.evaluate(
    (v) => window.__GZ__.setCameraPose(v[0]!, v[1]!, v[2]!, v[3]!, v[4]!),
    look(cx + 420, 60, cz - 420, cx, 170, cz),
  );
  await page.waitForTimeout(6000);
  await shot(page, 'm8-05-mushroom-cloud');
  await page.evaluate(
    (v) => window.__GZ__.setCameraPose(v[0]!, v[1]!, v[2]!, v[3]!, v[4]!),
    look(cx + 150, 170, cz - 190, cx, 0, cz),
  );
  await page.waitForTimeout(2500);
  await shot(page, 'm8-06-ground-zero');
  const snap = await page.evaluate(() => window.__GZ__.snapshot());
  console.log(
    `fps ${snap.fps.toFixed(0)}  max step ms ${n.maxStepMs.toFixed(1)}  particles ${snap.particles}`,
  );
  await expectNoErrors(errors);
});
