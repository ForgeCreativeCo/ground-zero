import { expect, test, type CDPSession, type Page } from '@playwright/test';
import { bootGame, expectNoErrors, shot, trackErrors } from './helpers';

/**
 * Mobile: on-screen touch controls and landscape-only play (added at the user's request).
 * A touch phone in landscape gets the stick, look drag and buttons; in portrait a prompt covers
 * the game until the device is turned.
 */

test.use({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true });

async function touch(
  cdp: CDPSession,
  type: 'touchStart' | 'touchMove' | 'touchEnd',
  points: { x: number; y: number; id: number }[],
) {
  await cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: points.map((p) => ({ x: p.x, y: p.y, id: p.id })),
  });
}

async function drag(
  page: Page,
  cdp: CDPSession,
  from: [number, number],
  to: [number, number],
  ms: number,
  id = 1,
) {
  await touch(cdp, 'touchStart', [{ x: from[0], y: from[1], id }]);
  const steps = 8;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await touch(cdp, 'touchMove', [
      { x: from[0] + (to[0] - from[0]) * t, y: from[1] + (to[1] - from[1]) * t, id },
    ]);
    await page.waitForTimeout(ms / steps);
  }
  return () => touch(cdp, 'touchEnd', []);
}

test('mobile: touch controls in landscape, rotate prompt in portrait', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = trackErrors(page);
  await bootGame(page);
  await page.waitForFunction(() => window.__GZ__.warm === true, undefined, { timeout: 60_000 });
  await expect(page.locator('#touch-ui')).toBeVisible();
  await expect(page.locator('#rotate-prompt')).toBeHidden();
  await expect(page.locator('#hint')).toBeHidden();
  await shot(page, 'mobile-01-start');
  await page.locator('#touch-start-btn').tap();
  await expect(page.locator('#touch-start')).toHaveCount(0);
  const cdp = await page.context().newCDPSession(page);

  // Move: push the left stick forward; he walks.
  const p0 = await page.evaluate(() => window.__GZ__.player());
  await page.evaluate(() => window.__GZ__.setLook(0, -0.1));
  const end = await drag(page, cdp, [150, 280], [150, 225], 900);
  await page.waitForTimeout(600);
  await shot(page, 'mobile-02-stick');
  await end();
  const p1 = await page.evaluate(() => window.__GZ__.player());
  console.log('moved', Math.hypot(p1.x - p0.x, p1.z - p0.z).toFixed(2));
  expect(Math.hypot(p1.x - p0.x, p1.z - p0.z)).toBeGreaterThan(1.5);

  // Look: drag on the right side turns the camera.
  const yaw0 = (await page.evaluate(() => window.__GZ__.look())).yaw;
  const endLook = await drag(page, cdp, [520, 200], [400, 200], 300, 2);
  await endLook();
  const yaw1 = (await page.evaluate(() => window.__GZ__.look())).yaw;
  console.log('yaw', yaw0.toFixed(3), '→', yaw1.toFixed(3));
  expect(Math.abs(yaw1 - yaw0)).toBeGreaterThan(0.1);

  // Buttons: punch, then fly (double tap), then heat vision held.
  await page.locator('.touch-punch').tap();
  await expect
    .poll(async () => (await page.evaluate(() => window.__GZ__.destruction())).strength.punches)
    .toBeGreaterThan(0);
  await page.locator('.touch-jump').tap();
  await page.waitForTimeout(80);
  await page.locator('.touch-jump').tap();
  await expect
    .poll(async () => (await page.evaluate(() => window.__GZ__.player())).state)
    .toBe('flying');
  const heat = await page.locator('.touch-heat').boundingBox();
  await touch(cdp, 'touchStart', [
    { x: heat!.x + heat!.width / 2, y: heat!.y + heat!.height / 2, id: 3 },
  ]);
  await page.waitForTimeout(500);
  expect((await page.evaluate(() => window.__GZ__.powers())).heat.firing).toBe(true);
  await shot(page, 'mobile-03-heat');
  await touch(cdp, 'touchEnd', []);
  await page.waitForTimeout(200);
  expect((await page.evaluate(() => window.__GZ__.powers())).heat.firing).toBe(false);

  // Boost toggles on and off.
  await page.locator('.touch-boost').tap();
  await expect(page.locator('.touch-boost')).toHaveClass(/on/);
  await page.locator('.touch-boost').tap();
  await expect(page.locator('.touch-boost')).not.toHaveClass(/on/);

  // Portrait: the rotate prompt covers the game.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  await expect(page.locator('#rotate-prompt')).toBeVisible();
  await shot(page, 'mobile-04-portrait');
  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForTimeout(400);
  await expect(page.locator('#rotate-prompt')).toBeHidden();
  await expectNoErrors(errors);
});
