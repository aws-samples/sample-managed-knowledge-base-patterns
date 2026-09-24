import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DOMAIN_DIR = new URL('.', import.meta.url).pathname;

function domainFiles(dir: string = DOMAIN_DIR): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      return domainFiles(path);
    }
    return path.endsWith('.ts') ? [path] : [];
  });
}

/**
 * The domain layer's defining property is that it depends on nothing external.
 *
 * ESLint already forbids Bedrock SDK imports outside `src/providers/`, and
 * `scripts/check-import-boundaries.sh` asserts that rule still fires. This test
 * is deliberately broader and independent of the lint configuration: it fails on
 * *any* AWS or Nest import anywhere under `src/domain/`, so the layer cannot
 * acquire a framework or SDK dependency through a package the lint rule's
 * pattern list does not happen to name.
 *
 * Reading the files rather than inspecting the module graph is intentional. A
 * type-only import disappears at runtime, so a graph-based check would not see
 * `import type { Foo } from '@aws-sdk/...'` — which is exactly the form an SDK
 * type leak takes.
 */
describe('domain layer purity', () => {
  const FORBIDDEN = [
    { pattern: /from\s+['"]@aws-sdk\//, label: '@aws-sdk/*' },
    { pattern: /from\s+['"]aws-sdk['"]/, label: 'aws-sdk' },
    { pattern: /from\s+['"]@aws-cdk\//, label: '@aws-cdk/*' },
    { pattern: /from\s+['"]aws-cdk-lib/, label: 'aws-cdk-lib' },
    { pattern: /from\s+['"]@nestjs\//, label: '@nestjs/*' },
  ];

  // This file necessarily contains the forbidden specifiers as regex literals,
  // so it must exclude itself or it reports itself as an offender. Excluded by
  // exact filename rather than by skipping all specs, so a domain spec that does
  // import an AWS SDK package is still caught.
  const SELF = 'domain-purity.spec.ts';
  const files = domainFiles().filter((file) => !file.endsWith(SELF));

  it('contains source files to check', () => {
    // Guards against the traversal silently finding nothing, which would make
    // every assertion below vacuously true.
    expect(files.length).toBeGreaterThan(5);
  });

  it.each(FORBIDDEN)('imports nothing from $label', ({ pattern, label }) => {
    const offenders = files.filter((file) => pattern.test(readFileSync(file, 'utf8')));

    expect(
      offenders,
      `${label} must not be imported by the domain layer. Move the dependency ` +
        `behind the RetrievalProvider port in src/providers/. Offending files:\n` +
        offenders.join('\n'),
    ).toEqual([]);
  });

  it('declares the retrieval port with identity as a required leading argument', () => {
    const port = readFileSync(join(DOMAIN_DIR, 'retrieval-provider.ts'), 'utf8');

    // The signature is the security-relevant part of the port: a required
    // leading identity turns "forgot to pass the user" into a compile error
    // instead of a silent zero-result page. Pin it so a refactor that makes it
    // optional has to change this test deliberately.
    expect(port).toMatch(/search\(identity: UserIdentity, query: SearchQuery\)/);
    expect(port).toMatch(/chat\(identity: UserIdentity, request: ChatRequest\)/);
    expect(port).not.toMatch(/identity\?: UserIdentity/);
  });
});
