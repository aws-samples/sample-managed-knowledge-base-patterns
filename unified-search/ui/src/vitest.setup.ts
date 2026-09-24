import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// React Testing Library only registers its automatic `afterEach(cleanup)` when
// the runner exposes globals. This project uses `globals: false`, so cleanup has
// to be wired explicitly — without it, mounted trees accumulate across tests in
// a file and `getBy*` queries fail with "found multiple elements" rather than
// with anything that points at the real cause.
afterEach(() => {
  cleanup();
});
