import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Dev server binds 0.0.0.0 and accepts any Host so the app is reachable from a phone on the
 * same network / the preview proxy — which matters because QR scanning is a *mobile* feature
 * and cannot be tested from localhost on the laptop.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: Number(process.env.CLIENT_PORT || 5173),
    allowedHosts: true,
    strictPort: false,
    proxy: {
      '/api': {
        target: process.env.API_ORIGIN || 'http://127.0.0.1:4000',
        changeOrigin: false,
        xfwd: true,
      },
    },
  },
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 900 },
});
