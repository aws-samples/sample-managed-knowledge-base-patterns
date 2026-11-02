/** Paths inside the pattern directory, resolved from this file so commands work from any directory. */

import * as path from 'node:path';

// typescript/src/paths.ts -> the pattern root
export const PATTERN_ROOT = path.resolve(__dirname, '..', '..');
export const INSTRUCTIONS_DIR = path.join(PATTERN_ROOT, 'instructions');
export const MANIFEST_FILE = path.join(PATTERN_ROOT, 'corpus', 'manifest.json');
export const STATE_FILE = path.join(PATTERN_ROOT, 'sample-state.json');
