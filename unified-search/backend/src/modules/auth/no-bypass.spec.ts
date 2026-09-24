import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_DIR = new URL('../../', import.meta.url).pathname;

function sourceFiles(dir: string = SRC_DIR): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      return sourceFiles(path);
    }
    return path.endsWith('.ts') ? [path] : [];
  });
}

/**
 * Removes comments before scanning.
 *
 * Without stripping, the check would fire on documentation that mentions the
 * forbidden names. Whole-line `//` comments are stripped rather than all `//`
 * occurrences, so a `https://` inside a string literal survives intact.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * Guards against introducing an authentication bypass.
 *
 * A single `BYPASS_AUTH = true` constant disables every route guard at once.
 * Combined with a hardcoded placeholder user, document permissions would no
 * longer be evaluated for the real caller, even though the setting looks like a
 * harmless development convenience.
 *
 * A switch like that is easy to add for local testing and easy to miss in
 * review, so it gets a test rather than a code-review convention.
 * CONTRIBUTING.md states the rule; this enforces it.
 */
describe('no authentication bypass', () => {
  const files = sourceFiles().filter((file) => !file.endsWith('no-bypass.spec.ts'));

  it('finds source files to check', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it.each([
    ['BYPASS_AUTH', /BYPASS_AUTH/],
    ['SKIP_AUTH', /SKIP_AUTH/],
    ['DISABLE_AUTH', /DISABLE_AUTH/],
    ['NODE_TLS_REJECT_UNAUTHORIZED', /NODE_TLS_REJECT_UNAUTHORIZED/],
  ])('contains no %s', (label, pattern) => {
    const offenders = files.filter((file) =>
      pattern.test(stripComments(readFileSync(file, 'utf8'))),
    );

    expect(
      offenders,
      `${label} must not appear in application code. See SECURITY.md and ` +
        `CONTRIBUTING.md. Offending files:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('uses @Public() on exactly one production route', () => {
    // Every public route is a route that cannot filter by document permissions.
    // Adding one should require changing this expectation deliberately.
    //
    // Counts occurrences rather than files, so a second @Public() in a file that
    // already has one is still caught.
    //
    // Specs are excluded because they legitimately define fixture controllers
    // with public probe routes in order to test the exemption itself.
    const usages = files
      .filter((file) => !file.endsWith('.spec.ts'))
      .flatMap((file) => {
        const matches =
          stripComments(readFileSync(file, 'utf8')).match(/^\s*@Public\(\)/gm) ?? [];
        return matches.map(() => file.replace(SRC_DIR, ''));
      });

    expect(usages).toEqual(['modules/health/health.controller.ts']);
  });

  it('registers the guard globally rather than per controller', () => {
    const authModule = readFileSync(
      join(SRC_DIR, 'modules/auth/auth.module.ts'),
      'utf8',
    );

    // A per-controller guard protects only the controllers someone remembered to
    // annotate, so a route added later would ship open.
    expect(authModule).toMatch(/APP_GUARD/);
    expect(authModule).toMatch(/useClass:\s*AuthGuard/);
  });
});
