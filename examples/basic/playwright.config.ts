import { defineConfig } from '@playwright/test';

// Drives the BUILT preview server (`vite preview`, i.e. what `npm run
// build` actually produces) in headless Chromium — the same "does it
// really work once built" question the package's own e2e/ suite asks,
// applied to this consumer app instead of the library's own harness.
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  use: { baseURL: 'http://localhost:4174' },
  webServer: {
    command: 'npx vite preview --port 4174',
    url: 'http://localhost:4174',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
