import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './test', testMatch: 'browser.spec.mjs', fullyParallel: false,
  use: { baseURL: 'http://127.0.0.1:3117', browserName: 'chromium', viewport: { width: 1440, height: 1000 },
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {},
    screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: { command: 'node server.mjs', url: 'http://127.0.0.1:3117', env: { PORT: '3117' }, reuseExistingServer: false },
});
