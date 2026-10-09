import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e', timeout: 60000, workers: 1, fullyParallel: false,
  use: { baseURL: 'http://127.0.0.1:3333', headless: true, channel: process.env.CI ? undefined : 'msedge', launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] }, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: { command: 'npm run start', url: 'http://127.0.0.1:3333/api/health', reuseExistingServer: false, timeout: 30000 },
});
