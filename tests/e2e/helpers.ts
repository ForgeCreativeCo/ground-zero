import { expect, type Page } from '@playwright/test';
import type { TestHooks } from '../../src/core/testHooks';

declare global {
  interface Window {
    __GZ__: TestHooks;
  }
}

/** Collects console errors and uncaught exceptions for the whole test. */
export function trackErrors(page: Page) {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('requestfailed', (req) => errors.push(`requestfailed: ${req.url()}`));
  page.on('response', (res) => {
    if (res.status() >= 400) errors.push(`HTTP ${res.status()}: ${res.url()}`);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  return errors;
}

export async function bootGame(page: Page, seed = 1234) {
  await page.goto(`/?seed=${seed}`);
  await page.waitForFunction(() => window.__GZ__?.ready === true, undefined, { timeout: 60_000 });
  return page.evaluate(() => ({ backend: window.__GZ__.backend, seed: window.__GZ__.seed }));
}

export async function hold(page: Page, ids: string[], ms: number) {
  await page.evaluate((list) => list.forEach((id) => window.__GZ__.setHeld(id, true)), ids);
  await page.waitForTimeout(ms);
  await page.evaluate((list) => list.forEach((id) => window.__GZ__.setHeld(id, false)), ids);
}

export async function shot(page: Page, name: string) {
  await page.screenshot({ path: `test-results/${name}.png` });
}

export async function expectNoErrors(errors: string[]) {
  expect(errors, errors.join('\n')).toEqual([]);
}
