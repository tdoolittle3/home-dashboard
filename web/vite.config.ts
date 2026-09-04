import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const API_TARGET = process.env.API_TARGET ?? 'http://localhost:8099';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // In dev the browser talks to Vite and Vite forwards /api to the backend,
    // so the frontend never needs to know the backend's origin.
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
