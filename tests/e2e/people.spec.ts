import { expect, test, type Page } from '@playwright/test';
import { bootGame, expectNoErrors, shot, trackErrors } from './helpers';

/**
 * M5 smoke: people and traffic. Close-ups of civilians (skinning, clothes, hair), a crowd seen
 * from above, then violence: a slam in a crowd must kill some, knock some down and send panic
 * spreading outward (people far beyond the blast end up fleeing too).
 */

/** Free camera looking at a point from an offset. */
async function lookAt(
  page: Page,
  target: { x: number; y: number; z: number },
  off: { x: number; y: number; z: number },
) {
  await page.evaluate(
    ([t, o]) => {
      const g = window.__GZ__;
      g.config.debug.freeCamera = true;
      const cx = t.x + o.x;
      const cy = t.y + o.y;
      const cz = t.z + o.z;
      const dx = t.x - cx;
      const dy = t.y - cy;
      const dz = t.z - cz;
      const yaw = Math.atan2(-dx, -dz);
      const pitch = Math.atan2(dy, Math.hypot(dx, dz));
      g.setCameraPose(cx, cy, cz, yaw, pitch);
    },
    [target, off] as const,
  );
}

test('M5: civilians render, walk, panic and die', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = trackErrors(page);
  await bootGame(page);
  await page.waitForFunction(() => window.__GZ__.warm === true, undefined, { timeout: 90_000 });
  await page.waitForTimeout(1500);

  const n0 = await page.evaluate(() => window.__GZ__.npc());
  console.log('npc at start', JSON.stringify(n0));
  expect(n0.living).toBeGreaterThan(100);

  // Close-up of a walker.
  const near = await page.evaluate(() =>
    window.__GZ__.npcNear(0, 0, 120).filter((p) => p.state === 1),
  );
  expect(near.length).toBeGreaterThan(5);
  const p = near[0]!;
  await lookAt(page, { x: p.x, y: p.y + 1.1, z: p.z }, { x: 2.2, y: 0.4, z: 2.2 });
  await page.waitForTimeout(400);
  await shot(page, 'm5-01-closeup');
  // Follow them a moment (walking animation).
  const p2 = (await page.evaluate(
    (i) => window.__GZ__.npcNear(0, 0, 200).find((q) => q.i === i),
    p.i,
  ))!;
  expect(Math.hypot(p2.x - p.x, p2.z - p.z)).toBeGreaterThan(0.2);
  await lookAt(page, { x: p2.x, y: p2.y + 0.9, z: p2.z }, { x: -3.5, y: 0.6, z: 1 });
  await page.waitForTimeout(150);
  await shot(page, 'm5-02-walker-side');

  // The street from above, people on the sidewalks.
  await lookAt(page, { x: p.x, y: 0, z: p.z }, { x: 25, y: 22, z: 25 });
  await page.waitForTimeout(400);
  await shot(page, 'm5-03-street');
  const tiers = (await page.evaluate(() => window.__GZ__.npc())).tiers;
  console.log('tiers', tiers);
  expect(tiers[0]! + tiers[1]! + tiers[2]!).toBeGreaterThan(5);

  // Violence: a blast in the crowd. Some die, panic spreads well beyond the blast.
  await page.evaluate(([x, z]) => window.__GZ__.npcBlast(x, 1, z, 10, 400, 12), [
    p.x,
    p.z,
  ] as const);
  await page.evaluate(([x, z]) => window.__GZ__.npcAlarm(x, 1, z, 40), [p.x, p.z] as const);
  await page.waitForTimeout(600);
  await lookAt(page, { x: p.x, y: 0.5, z: p.z }, { x: 14, y: 8, z: 14 });
  await page.waitForTimeout(1200);
  await shot(page, 'm5-04-blast-aftermath');
  await page.waitForTimeout(3000);
  const n1 = await page.evaluate(() => window.__GZ__.npc());
  console.log('npc after blast', JSON.stringify(n1));
  expect(n1.casualties).toBeGreaterThan(0);
  expect(n1.fleeing + n1.panicking).toBeGreaterThan(5);
  await lookAt(page, { x: p.x, y: 0.5, z: p.z }, { x: 30, y: 25, z: 30 });
  await page.waitForTimeout(300);
  await shot(page, 'm5-05-panic');

  await expectNoErrors(errors);
});

test('M5: traffic drives, crashes and explodes', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = trackErrors(page);
  await bootGame(page);
  await page.waitForFunction(() => window.__GZ__.warm === true, undefined, { timeout: 90_000 });
  await page.waitForTimeout(1000);
  const v0 = await page.evaluate(() => window.__GZ__.vehicles());
  console.log('vehicles', JSON.stringify({ ...v0, list: undefined }));
  expect(v0.driving).toBeGreaterThan(20);
  expect(v0.still).toBeGreaterThan(20);
  // Cars move along their lanes.
  const before = v0.list.filter((v) => v.mode === 0);
  await page.waitForTimeout(2000);
  const after = (await page.evaluate(() => window.__GZ__.vehicles())).list;
  const moved = before.filter((b) => {
    const a = after[b.id]!;
    return Math.hypot(a.x - b.x, a.z - b.z) > 2;
  }).length;
  console.log(`moved ${moved}/${before.length}`);
  expect(moved).toBeGreaterThan(before.length * 0.3);

  // A driving car near the start, seen from the kerb.
  const car = after
    .filter((v) => v.mode === 0)
    .sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z))[0]!;
  await lookAt(page, { x: car.x, y: 1, z: car.z }, { x: 6, y: 3, z: 6 });
  await page.waitForTimeout(100);
  await shot(page, 'm5-10-traffic');
  await lookAt(page, { x: 0, y: 0, z: 0 }, { x: 40, y: 35, z: 40 });
  await page.waitForTimeout(300);
  await shot(page, 'm5-11-junction');

  // Blow a parked car up: it leaps, burns, throws neighbours and wrecks itself.
  const parked = after
    .filter((v) => v.parked)
    .sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z))[0]!;
  await lookAt(page, { x: parked.x, y: 1, z: parked.z }, { x: 14, y: 7, z: 14 });
  await page.waitForTimeout(200);
  await page.evaluate((id) => window.__GZ__.vehicleExplode(id), parked.id);
  await page.waitForTimeout(250);
  await shot(page, 'm5-12-explosion');
  await page.waitForTimeout(3000);
  await shot(page, 'm5-13-burning-wreck');
  const v1 = await page.evaluate(() => window.__GZ__.vehicles());
  console.log('after explosion', JSON.stringify({ ...v1, list: undefined }));
  expect(v1.exploded).toBeGreaterThanOrEqual(1);
  expect(v1.wrecks).toBeGreaterThanOrEqual(1);

  // Panic: a big blast at a junction; drivers bail or floor it, there are crashes.
  await page.evaluate(() => window.__GZ__.npcAlarm(0, 0, 0, 300));
  await page.evaluate(() => {
    const g = window.__GZ__;
    g.vehicleBlast(0, 1, 0, 30, 300, 20);
  });
  await page.waitForTimeout(5000);
  await lookAt(page, { x: 0, y: 0, z: 0 }, { x: 45, y: 30, z: 45 });
  await page.waitForTimeout(300);
  await shot(page, 'm5-14-panic-traffic');
  await expectNoErrors(errors);
});

test('M5: the hero punches a person, throws a car, breached rooms have people', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const errors = trackErrors(page);
  await bootGame(page);
  await page.waitForFunction(() => window.__GZ__.warm === true, undefined, { timeout: 90_000 });
  await page.waitForTimeout(800);
  const tap = async (id: string) => {
    await page.evaluate((k) => window.__GZ__.setHeld(k, true), id);
    await page.waitForTimeout(70);
    await page.evaluate((k) => window.__GZ__.setHeld(k, false), id);
  };

  // Punch: stand next to someone and hit them.
  const target = (
    await page.evaluate(() => window.__GZ__.npcNear(0, 0, 150).filter((p) => p.state === 1))
  )[0]!;
  // In front of them on the sidewalk (they walk toward him), facing back at them.
  await page.evaluate(
    ([x, z, yaw]) => {
      const g = window.__GZ__;
      const fx = Math.sin(yaw);
      const fz = Math.cos(yaw);
      g.teleportPlayer(x + fx * 1.7, 0, z + fz * 1.7);
      g.setLook(Math.atan2(fx, fz), -0.2);
    },
    [target.x, target.z, target.yaw] as const,
  );
  await page.waitForTimeout(60);
  const c0 = (await page.evaluate(() => window.__GZ__.npc())).casualties;
  await tap('Mouse0');
  await page.waitForTimeout(400);
  await shot(page, 'm5-20-punch-person');
  const c1 = await page.evaluate(() => window.__GZ__.npc());
  console.log('after punch', JSON.stringify(c1));
  expect(c1.casualties + c1.injured).toBeGreaterThan(c0);

  // Grab a parked car and throw it.
  const car = (await page.evaluate(() => window.__GZ__.vehicles())).list
    .filter((v) => v.parked && v.mode === 1)
    .sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z))[0]!;
  await page.evaluate(
    ([x, z]) => {
      const g = window.__GZ__;
      g.teleportPlayer(x - 3.4, 0, z);
      g.setLook(-Math.PI / 2, -0.25);
    },
    [car.x, car.z] as const,
  );
  await page.waitForTimeout(200);
  await tap('KeyE');
  await expect
    .poll(async () => (await page.evaluate(() => window.__GZ__.destruction())).holding, {
      timeout: 2000,
    })
    .toBe(true);
  await page.waitForTimeout(400);
  await shot(page, 'm5-21-car-held');
  await tap('Mouse0');
  await page.waitForTimeout(700);
  await shot(page, 'm5-22-car-thrown');
  const thrown = (await page.evaluate(() => window.__GZ__.vehicles())).list[car.id]!;
  expect(Math.hypot(thrown.x - car.x, thrown.z - car.z)).toBeGreaterThan(8);

  // Breach a building: furnished rooms come with people in them.
  const b = (await page.evaluate(() => window.__GZ__.structures())).find(
    (s) => s.district === 'mid' && s.floors >= 6,
  )!;
  await page.evaluate(([bi]) => window.__GZ__.cutStory(bi!, 2, 0.5), [b.index]);
  await page.waitForTimeout(2500);
  const n = await page.evaluate(() => window.__GZ__.npc());
  console.log('occupants', n.occupants, 'spawned', n.occupantsSpawned);
  expect(n.occupantsSpawned).toBeGreaterThan(0);
  await expectNoErrors(errors);
});
