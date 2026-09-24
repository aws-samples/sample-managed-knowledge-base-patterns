import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Test configuration lives in vitest.config.ts. Vite 8's UserConfig no longer
// accepts a `test` key, so keeping it here fails `tsc --noEmit`.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Mirrors the `paths` entry in tsconfig.json. Type-only, so this alias exists
      // to satisfy resolution during type checking and never contributes to the
      // bundle.
      '@domain': fileURLToPath(
        new URL('../backend/src/domain/index.ts', import.meta.url),
      ),
    },
  },
  server: {
    port: 5173,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
