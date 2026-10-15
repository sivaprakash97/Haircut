import { defineConfig } from '@playwright/test';

// Headless Chromium renders WebGL with SwiftShader (software), so these tests
// check that the scene loads and renders correctly, not how fast it is.
export default defineConfig({
  testDir: 'e2e',
  timeout: 180_000,
  outputDir: 'test-results',
  use: {
    baseURL: 'http://localhost:4173',
    viewport: { width: 1280, height: 800 },
    launchOptions: {
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
    },
  },
  webServer: {
    command: 'npm run build && npm run preview',
    url: 'http://localhost:4173',
    reuseExistingServer: true,
    timeout: 180_000,
  },
});
