import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// A minimal, dev-only multi-page app whose sole purpose is mounting
// PhotoCropEditor/PhotoUploader standalone for Playwright to drive in a
// real browser (see e2e/README.md and the harness components' own docs
// for why: JSDOM has no layout engine and cannot observe the CSS
// invariants and real paint these components' geometry depends on).
// Never built or published — playwright.config.ts's webServer runs this
// via `vite dev`, not `vite build`.
export default defineConfig({
  root: __dirname,
  plugins: [react()],
  server: {
    port: 4173,
  },
});
