import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30_000,
  retries: process.env.CI ? 2 : 0,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      // The API owns the authoritative engine (in-memory for M0). A short tick
      // duration lets the e2e observe the scheduler advancing ticks live.
      command: 'pnpm --filter @ashes/api start',
      url: 'http://localhost:3001/healthz',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: {
        PORT: '3001',
        WORLD_SEED: '1337',
        TICK_DURATION_MS: '2000',
        // Must match the web client's VITE_PLAYER_TOKEN default: the overview
        // test authenticates as the seeded player.
        PLAYER_TOKEN: 'player-1337-token',
        ADMIN_TOKEN: 'dev-admin-token',
      },
    },
    {
      // VITE_API_BASE is baked at build time, so the e2e build targets the API
      // directly (the preview server has no proxy).
      command:
        'VITE_API_BASE=http://localhost:3001 pnpm --filter @ashes/web build && pnpm --filter @ashes/web preview',
      url: 'http://localhost:4173',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
