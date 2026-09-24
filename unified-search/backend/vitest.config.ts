import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Integration tests live in vitest.integration.config.ts and are excluded
    // here so the default suite needs no AWS credentials.
    include: ['src/**/*.spec.ts'],
    exclude: ['src/**/*.integration.spec.ts', '**/node_modules/**'],
    environment: 'node',
    // Explicit imports from 'vitest' in every spec rather than ambient globals:
    // it keeps test helpers out of production type scope and makes it obvious
    // which runner a file belongs to.
    globals: false,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.spec.ts', 'src/main.ts'],
    },
  },
});
