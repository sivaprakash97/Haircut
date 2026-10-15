import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

export default defineConfig({
  plugins: [preact()],
  build: {
    target: 'es2022',
    // The app is one small bundle plus a worker; no need for the preload polyfill.
    modulePreload: { polyfill: false },
    reportCompressedSize: false,
    // three.js is one ~550 KB (≈130 KB compressed) chunk by design; scripts/check-size.mjs enforces the real budget.
    chunkSizeWarningLimit: 700,
  },
  worker: { format: 'es' },
});
