/// <reference types="vitest/config" />
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  // Relative base: the site is served from GitHub Pages under a subpath.
  base: './',
  plugins: [react()],
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      input: {
        index: resolve(root, 'index.html'),
        game: resolve(root, 'game.html'),
      },
    },
  },
  server: {
    // Dev proxy: the browser talks to the API on the same origin.
    proxy: {
      '/api': 'http://localhost:3001',
      '/healthz': 'http://localhost:3001',
    },
  },
});
