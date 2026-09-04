import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: true,
  retries: 1,
  reporter: [['html', { open: 'never' }], ['list']],
  use: {
    baseURL: 'http://localhost:8934',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'python3 -m http.server 8934 --directory dist',
    url: 'http://localhost:8934',
    reuseExistingServer: false,
    timeout: 30_000,
  },
  projects: [
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
})
