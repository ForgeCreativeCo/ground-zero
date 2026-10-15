import { defineConfig } from '@playwright/test';

/**
 * Uses the installed Chrome with GPU enabled so WebGPU and perf numbers reflect the real GPU
 * (Playwright's bundled headless Chromium falls back to SwiftShader).
 */
export default defineConfig({
  testDir: 'tests/e2e',
  outputDir: 'test-results/artifacts',
  timeout: 120_000,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    channel: 'chrome',
    headless: process.env.HEADED ? false : true,
    viewport: { width: 1280, height: 720 },
    launchOptions: {
      args: [
        '--enable-gpu',
        '--ignore-gpu-blocklist',
        '--enable-unsafe-webgpu',
        '--use-angle=d3d11',
        '--enable-features=Vulkan,WebGPU',
      ],
    },
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
