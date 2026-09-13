import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    // Required for @testing-library/react's automatic post-test cleanup
    // (it hooks the global afterEach) — without this, JSX rendered by one
    // test stays mounted for the next, and getByRole()/getByAltText()
    // queries that expect exactly one match start failing with "found
    // multiple elements" as soon as more than one test in a file renders
    // the same component.
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    css: true,
    include: ['test/**/*.test.{ts,tsx}'],
  },
});
