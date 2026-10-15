import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { bootGame, expectNoErrors, shot, trackErrors } from './helpers';

/**
 * Perf run (DESIGN.md §14.4): scripted camera path at 1080p while physics bodies rain down.
 * Logs avg / p95 frame times and peak counts, writes test-results/perf.json, and fails over budget.
 */
test.use({ viewport: { width: 1920, height: 1080 } });

test('perf path stays within budget', async ({ page }) => {
  const errors = trackErrors(page);
  // Defaults are the Low preset. PERF_QUALITY=high mirrors QUALITY_HIGH in src/ui/debugPanel.ts.
  if (process.env.PERF_QUALITY === 'high') {
    await page.addInitScript(() =>
      localStorage.setItem(
        'ground-zero:config-overrides',
        JSON.stringify({
          'render.msaaSamples': 4,
          'render.bloom.enabled': true,
          'render.shadows.mapSize': 2048,
          'render.shadows.cascades': 3,
          'render.maxPixelRatio': 1.5,
        }),
      ),
    );
  }
  const info = await bootGame(page);
  await page.waitForTimeout(1500); // shader compile + env map settle
  const result = await page.evaluate(() => window.__GZ__.runPerfPath());
  const limits = await page.evaluate(() => ({
    perf: window.__GZ__.config.perf,
    budgets: window.__GZ__.config.budgets,
  }));
  await shot(page, 'm0-perf-end');

  const report = { ...info, viewport: '1920x1080', ...result, limits: limits.perf };
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/perf.json', JSON.stringify(report, null, 2));
  console.log(
    `\nPERF  ${info.backend}  frames ${result.frames}\n` +
      `  avg ${result.avgMs.toFixed(2)} ms (${(1000 / result.avgMs).toFixed(1)} fps)` +
      `  p95 ${result.p95Ms.toFixed(2)} ms  p99 ${result.p99Ms.toFixed(2)} ms  max ${result.maxMs.toFixed(2)} ms\n` +
      `  peak active bodies ${result.peakActiveBodies}  peak draw calls ${result.peakDrawCalls}` +
      `  peak tris ${result.peakTriangles}  avg CPU ${result.avgCpuMs.toFixed(2)} ms/frame\n`,
  );

  await expectNoErrors(errors);
  expect(result.frames).toBeGreaterThan(30);
  expect(result.peakActiveBodies).toBeLessThanOrEqual(limits.budgets.activeRigidBodies);
  expect(result.peakDrawCalls).toBeLessThanOrEqual(limits.budgets.drawCalls);
  expect(result.avgMs, 'average frame time over budget').toBeLessThanOrEqual(
    limits.perf.maxAvgFrameMs,
  );
  expect(result.p95Ms, 'p95 frame time over budget').toBeLessThanOrEqual(limits.perf.maxP95FrameMs);
});
