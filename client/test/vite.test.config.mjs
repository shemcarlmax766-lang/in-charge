import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

/** Builds the app into a single IIFE the jsdom harness can evaluate. */
export default defineConfig({
  configFile: false,
  root: path.resolve(import.meta.dirname, '..'),
  define: { 'process.env.NODE_ENV': '"development"', 'process.env': '{}' },
  plugins: [react()],
  resolve: { alias: { 'jsqr': path.resolve(import.meta.dirname, '..', 'src', 'test-stubs', 'jsqr.js') } },
  build: {
    outDir: 'test/.build',
    emptyOutDir: true,
    minify: false,
    cssCodeSplit: false,
    lib: { entry: 'test/entry.jsx', formats: ['iife'], name: 'BemfrsTest', fileName: () => 'app.js' },
  },
});
