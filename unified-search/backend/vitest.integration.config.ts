import { defineConfig } from 'vitest/config';

/**
 * Integration tests, kept in a separate config so they never run in the default
 * suite.
 *
 * They require deployed AWS resources and real credentials, so including them in
 * `npm test` would make the unit suite fail on any machine without an account.
 * Separated rather than tagged, because a tag that must be excluded is a tag
 * someone eventually forgets to exclude.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.integration.spec.ts'],
    environment: 'node',
    globals: false,
    // A real Retrieve round trip is far slower than a unit test.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
