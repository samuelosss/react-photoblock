import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import dts from 'vite-plugin-dts';

// Library build. Vite over tsup here because the components use CSS
// Modules (scoped class names, `import styles from './X.module.css'`):
// Vite has that built in via its own PostCSS pipeline and emits it as one
// bundled stylesheet for library mode with no extra config, where tsup
// needs a hand-wired postcss-modules loader to do the same job. Since this
// package's whole point is "ship usable CSS with zero consumer setup",
// the tool that does that by default was the simpler choice.
export default defineConfig({
  plugins: [
    react(),
    dts({
      insertTypesEntry: true,
      rollupTypes: false,
      tsconfigPath: './tsconfig.build.json',
    }),
  ],
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'ReactPhotoblock',
      fileName: (format) => (format === 'es' ? 'react-photoblock.js' : 'react-photoblock.cjs'),
      formats: ['es', 'cjs'],
    },
    cssCodeSplit: false,
    sourcemap: true,
    rollupOptions: {
      // React/ReactDOM are peer dependencies — never bundled. A consuming
      // app supplies its own copy, so this package doesn't ship a second
      // React instance (which breaks hooks) or inflate its own size.
      external: ['react', 'react-dom', 'react/jsx-runtime'],
      output: {
        globals: {
          react: 'React',
          'react-dom': 'ReactDOM',
        },
        // Names the emitted CSS file predictably (Vite's library-mode
        // default is a generic `style.css`) so package.json's
        // "./styles.css" export subpath has a stable target.
        assetFileNames: 'react-photoblock.[ext]',
      },
    },
  },
});
