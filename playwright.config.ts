import { defineConfig } from '@playwright/test'
import path from 'node:path'

const baseURL = 'http://127.0.0.1:5173'
const e2eApiPort = '8081'
const e2eDataDirectory = path.join(process.cwd(), '.e2e-data')

export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    screenshot: 'on',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
  webServer: [
    {
      command: 'npm run dev -- --host 127.0.0.1',
      url: `${baseURL}/`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        ...process.env,
        VITE_API_PORT: e2eApiPort,
      },
    },
    {
      command: 'node server.js',
      url: `http://127.0.0.1:${e2eApiPort}/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        ...process.env,
        NODE_ENV: 'development',
        APP_ORIGIN: baseURL,
        E2E_TEST_MODE: 'true',
        GUESS_PARTY_DATA_DIR: e2eDataDirectory,
        PORT: e2eApiPort,
      },
    },
  ],
})
