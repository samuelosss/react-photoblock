import { defineConfig } from '@playwright/test';

// Playwright drives e2e/harness (a throwaway dev-only Vite app — see its
// own vite.config.ts) in a real browser. Verified in headless Chromium
// only — see the README's Limitations section for what that does and does
// not tell you about other engines.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: 'npx vite dev --config e2e/harness/vite.config.ts',
    // Checked against a real page, not "/" — the harness has no root
    // index.html (only crop-editor.html/photo-uploader.html), so "/" 404s
    // forever and Playwright's readiness poll never sees it come up.
    url: 'http://localhost:4173/crop-editor.html',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
