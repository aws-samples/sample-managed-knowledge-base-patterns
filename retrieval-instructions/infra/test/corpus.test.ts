import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PATTERN_DIR } from './support';

// Checks the corpus the stack uploads and indexes: a broken copy, or a sidecar that
// drifts from the manifest, would silently change what each tenant's filter selects.

const CORPUS = path.join(PATTERN_DIR, 'corpus');
const FOOTER =
  'Synthetic demo content. AnyCompany is a fictitious company. Not a real policy.';
const HEADER_FIELDS = [
  'Doc ID',
  'Version',
  'Effective date',
  'Status',
  'Owner',
  'Scope',
];

interface Entry {
  docId: string;
  path: string;
  scope: string;
  region: string;
  audience_team: string;
  sensitivity: string;
  conflicts: string[];
}

interface FolderRule {
  docs: number;
  regions: string[];
  audience: string;
  sensitivity: string;
}

/** The folder table of corpus/README.md. */
const FOLDERS: Record<string, FolderRule> = {
  global: { docs: 12, regions: ['global'], audience: 'all', sensitivity: 'public' },
  'sales-region-north': {
    docs: 3,
    regions: ['sales-region-north'],
    audience: 'all',
    sensitivity: 'public',
  },
  'sales-region-central': {
    docs: 3,
    regions: ['sales-region-central'],
    audience: 'all',
    sensitivity: 'public',
  },
  'sales-region-south': {
    docs: 4,
    regions: ['sales-region-south'],
    audience: 'all',
    sensitivity: 'public',
  },
  'team-support': {
    docs: 3,
    regions: ['global'],
    audience: 'team-support',
    sensitivity: 'internal',
  },
  'team-field-sales': {
    docs: 3,
    regions: ['global', 'sales-region-south'],
    audience: 'team-field-sales',
    sensitivity: 'internal',
  },
  'team-legal-compliance': {
    docs: 2,
    regions: ['global', 'sales-region-central'],
    audience: 'team-legal-compliance',
    sensitivity: 'internal',
  },
  'team-engineering': {
    docs: 2,
    regions: ['global'],
    audience: 'team-engineering',
    sensitivity: 'restricted',
  },
};

const manifest = JSON.parse(
  fs.readFileSync(path.join(CORPUS, 'manifest.json'), 'utf8'),
) as {
  note: string;
  asOf: string;
  docs: (Entry & { facts?: unknown })[];
};

/** Every file under corpus/, relative to it, ignoring the .DS_Store files Finder writes. */
function listFiles(dir: string, prefix = ''): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      return listFiles(path.join(dir, entry.name), rel);
    }
    return entry.name === '.DS_Store' ? [] : [rel];
  });
}

describe('corpus manifest', () => {
  it('has the public note and the as-of date', () => {
    expect(manifest.note).toBe(
      "Synthetic AnyCompany Smart Home corpus. AnyCompany is a fictitious company. Each <file>.md.metadata.json must equal its entry's region, audience_team, and sensitivity; infra/test/corpus.test.ts checks this.",
    );
    expect(manifest.asOf).toBe('2026-10-01');
  });

  it('has 32 entries with unique IDs and file names, under docs/<scope>/, without facts', () => {
    expect(manifest.docs).toHaveLength(32);
    expect(new Set(manifest.docs.map((d) => d.docId)).size).toBe(32);
    expect(new Set(manifest.docs.map((d) => path.basename(d.path))).size).toBe(32);
    for (const doc of manifest.docs) {
      expect(doc.path).toMatch(new RegExp(`^docs/${doc.scope}/[^/]+\\.md$`));
      expect(doc).not.toHaveProperty('facts');
    }
  });

  it('uses only the allowed values and follows the folder rules', () => {
    for (const doc of manifest.docs) {
      expect(doc.region).toMatch(/^(global|sales-region-(north|central|south))$/);
      expect(doc.audience_team).toMatch(/^(all|team-[a-z-]+)$/);
      expect(['public', 'internal', 'restricted']).toContain(doc.sensitivity);
      const rule = FOLDERS[doc.scope];
      expect(rule, `unknown folder ${doc.scope}`).toBeDefined();
      expect(rule!.regions).toContain(doc.region);
      expect(doc.audience_team).toBe(rule!.audience);
      expect(doc.sensitivity).toBe(rule!.sensitivity);
    }
    for (const [folder, rule] of Object.entries(FOLDERS)) {
      expect(
        manifest.docs.filter((d) => d.scope === folder),
        folder,
      ).toHaveLength(rule.docs);
    }
  });
});

describe('corpus files', () => {
  it('holds only the README, the manifest, and the 32 documents with their sidecars', () => {
    const expected = [
      'README.md',
      'manifest.json',
      ...manifest.docs.flatMap((d) => [d.path, `${d.path}.metadata.json`]),
    ].sort();
    expect(listFiles(CORPUS).sort()).toEqual(expected);
    expect(
      fs
        .readdirSync(path.join(CORPUS, 'docs'))
        .filter((n) => n !== '.DS_Store')
        .sort(),
    ).toEqual(Object.keys(FOLDERS).sort());
  });

  it('gives each document a sidecar equal to its manifest entry', () => {
    for (const doc of manifest.docs) {
      const sidecar = JSON.parse(
        fs.readFileSync(path.join(CORPUS, `${doc.path}.metadata.json`), 'utf8'),
      ) as unknown;
      expect(sidecar, doc.path).toEqual({
        metadataAttributes: {
          region: doc.region,
          audience_team: doc.audience_team,
          sensitivity: doc.sensitivity,
        },
      });
    }
  });

  it('starts each document with a title and the header fields, and ends with the footer', () => {
    for (const doc of manifest.docs) {
      const lines = fs.readFileSync(path.join(CORPUS, doc.path), 'utf8').split('\n');
      expect(lines[0], doc.path).toMatch(/^# \S/);
      const header = lines
        .slice(1, 1 + HEADER_FIELDS.length)
        .map((line) => line.split(':')[0]);
      expect(header, doc.path).toEqual(HEADER_FIELDS);
      expect(lines[1]).toBe(`Doc ID: ${doc.docId}`);
      const last = lines.filter((line) => line.trim() !== '').at(-1);
      expect(last, doc.path).toBe(FOOTER);
    }
  });

  it('uses only @example.com email addresses', () => {
    for (const file of listFiles(CORPUS)) {
      const text = fs.readFileSync(path.join(CORPUS, file), 'utf8');
      for (const email of text.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g) ?? []) {
        expect(email, file).toMatch(/@example\.com$/);
      }
    }
  });

  it('says in the README that the content is synthetic', () => {
    expect(fs.readFileSync(path.join(CORPUS, 'README.md'), 'utf8')).toContain(
      'Synthetic demo content.',
    );
  });
});
