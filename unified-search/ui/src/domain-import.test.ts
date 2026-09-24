import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Every import from `@domain` must be type-only.
 *
 * The UI shares the backend's domain model so the wire contract has one definition
 * rather than being hand-mirrored, because duplicated wire shapes drift. That sharing
 * is only safe while
 * it stays types: `@domain` resolves into `../backend/src/domain`, and a value import
 * would pull server-side runtime code into the browser bundle.
 *
 * Nothing there is dangerous *today* — the domain layer is provably free of Nest and AWS
 * imports, which a backend test asserts by reading the files. But the barrel also exports
 * runtime values (`collectChat`, `UserIdentity`, `RETRIEVAL_PROVIDER`), and
 * `UserIdentity` in a browser bundle would be an identity type in the one place identity
 * must never be constructed.
 *
 * Checked by reading source rather than by inspecting the bundle, so it fails in the
 * editor and in CI at the point the mistake is made. A bundle check would also work but
 * only after a build, and would not say which file was responsible.
 */

// `process.cwd()` rather than `import.meta.url`: these tests run in the jsdom
// environment, where `import.meta.url` is not a file URL. Vitest runs from the package
// root, so this resolves to `ui/src`.
const SOURCE_ROOT = join(process.cwd(), 'src');
const EXTENSIONS = new Set(['.ts', '.tsx']);

/**
 * Excluded from its own scan because its failure message contains the pattern it looks
 * for.
 */
const SELF = 'domain-import.test.ts';

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    if (entry === SELF) return [];
    return EXTENSIONS.has(extname(path)) ? [path] : [];
  });
}

describe('imports from @domain', () => {
  const files = sourceFiles(SOURCE_ROOT);

  it('finds source files to check', () => {
    // Guards against the suite passing because the walk found nothing.
    expect(files.length).toBeGreaterThan(5);
  });

  it('are type-only in every file', () => {
    const offenders: string[] = [];

    for (const file of files) {
      const contents = readFileSync(file, 'utf8');

      // Strip line comments so prose mentioning the rule is not matched.
      const code = contents
        .split('\n')
        .filter(
          (line) =>
            !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'),
        )
        .join('\n');

      // Any import statement mentioning '@domain'. Captures the whole statement so the
      // `type` keyword position can be checked.
      const pattern = /import\s+([^;]*?)\s+from\s+'@domain'/g;
      let match: RegExpExecArray | null;

      while ((match = pattern.exec(code)) !== null) {
        const clause = match[1] ?? '';
        // `import type { A } from` and `import { type A } from` are both fine. A bare
        // `import { A } from` is not.
        const isTypeOnly =
          clause.startsWith('type ') ||
          clause
            .replace(/[{}]/g, '')
            .split(',')
            .every((specifier) => specifier.trim().startsWith('type '));

        if (!isTypeOnly) {
          offenders.push(
            `${file.replace(SOURCE_ROOT, '')}: import ${clause} from '@domain'`,
          );
        }
      }
    }

    expect(
      offenders,
      `Value imports from @domain would bundle backend runtime code into the browser:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('does not import the backend by path, bypassing the alias', () => {
    const offenders = files.filter((file) => {
      const code = readFileSync(file, 'utf8');
      return /from\s+'[^']*\.\.\/backend\//.test(code);
    });

    // The alias is the reviewable seam. A relative path into the backend would sidestep
    // both it and this check.
    expect(offenders).toEqual([]);
  });
});
