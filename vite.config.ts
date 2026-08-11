/// <reference types="vitest/config" />
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  // Relative base: the site is served from GitHub Pages under a subpath
  // (nordicnode.github.io/ashes-and-antlers/), so root-absolute URLs like
  // "/logo.png" or "/game.html" would 404. './' rewrites every emitted URL
  // to be relative and works at any mount point.
  base: './',
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      input: {
        index: resolve(root, 'index.html'),
      },
    },
  },
  test: {
    // The simulation test suites were scrapped with the game (2026-08-11);
    // they will return when the game is rebuilt. Until then there are no
    // Vitest files, so allow the run to pass instead of failing.
    include: ['tests/unit/**/*.test.ts', 'tests/sim/**/*.test.ts'],
    environment: 'node',
    passWithNoTests: true,
  },
});
