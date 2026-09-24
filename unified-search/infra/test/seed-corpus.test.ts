import { describe, expect, it } from 'vitest';

import { CONTENT_PREFIX, DEPARTMENTS, SEED_ACL, SEED_USERS } from '../lib/seed-acl';
import { generateCorpus } from '../lib/seed-corpus';
import { ATTRIBUTE_NAMES, buildSidecar } from '../lib/seed-metadata';

/**
 * The corpus and the access control lists have to agree: on an ACL-enabled data source a
 * document under a prefix with no matching entry is **not ingested at all**. It does not
 * appear as unauthorized; it is not in the index, so a search for it finds nothing.
 */
describe('generateCorpus', () => {
  const corpus = generateCorpus();

  it('produces a corpus large enough for ranking to be meaningful', () => {
    // Three documents are enough to show filtering, but every query returns the same file.
    expect(corpus.length).toBeGreaterThanOrEqual(100);
  });

  it('is deterministic', () => {
    // ACL assertions name specific documents. A corpus that varied between runs would
    // make those failures look like permissions bugs.
    expect(generateCorpus()).toEqual(generateCorpus());
  });

  it('produces a different corpus for a different seed', () => {
    expect(generateCorpus(1)).not.toEqual(generateCorpus(2));
  });

  /**
   * The invariant that matters most in this file.
   */
  it('places every document under a prefix that has an ACL entry', () => {
    const prefixes = SEED_ACL.map((entry) => entry.prefix);
    const orphans = corpus.filter(
      (doc) => !prefixes.some((prefix) => doc.key.startsWith(prefix)),
    );

    expect(
      orphans.map((doc) => doc.key),
      'these documents would be absent from the index, not merely unauthorized',
    ).toEqual([]);
  });

  it('covers every declared department', () => {
    const seen = new Set(
      corpus.map((doc) => doc.key.slice(CONTENT_PREFIX.length).split('/')[0]),
    );

    expect([...seen].sort()).toEqual([...DEPARTMENTS].sort());
  });

  it('declares an ACL entry for every department', () => {
    const withEntries = new Set(
      SEED_ACL.map((entry) =>
        entry.prefix.slice(CONTENT_PREFIX.length).replace('/', ''),
      ),
    );

    // A department added to DEPARTMENTS without a matching ACL entry produces documents
    // that upload cleanly and are never indexed.
    for (const department of DEPARTMENTS) {
      expect(withEntries, `no ACL entry for ${department}`).toContain(department);
    }
  });

  it('gives every document a unique key', () => {
    const keys = corpus.map((doc) => doc.key);

    // A collision would silently drop a document during upload.
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('gives every document a title and a non-trivial body', () => {
    for (const doc of corpus) {
      expect(doc.title.length, doc.key).toBeGreaterThan(0);
      expect(doc.body.length, doc.key).toBeGreaterThan(400);
      expect(doc.body, doc.key).toContain(`# ${doc.title}`);
    }
  });

  /**
   * Retrieved text is untrusted input to the generator.
   *
   * Body text that states access rules can be interpreted as an instruction about what
   * may be disclosed. Access is enforced by the knowledge base's ACLs, so nothing in a
   * generated corpus should resemble an instruction, and no document should discuss
   * permissions at all.
   */
  it('contains no document that describes its own permissions', () => {
    const forbidden = [
      /only \S+@\S+ (?:is|are) permitted/i,
      /do not disclose/i,
      /confidential[ -]?do not/i,
      /you (?:must|should) not (?:reveal|disclose|share)/i,
      /restricted to \S+@\S+/i,
    ];

    for (const doc of corpus) {
      for (const pattern of forbidden) {
        expect(pattern.test(doc.body), `${doc.key} matched ${String(pattern)}`).toBe(
          false,
        );
      }
    }
  });

  it('mentions no seed identity anywhere in the content', () => {
    // Keeps email addresses out of retrievable text, so a generated answer cannot
    // reproduce one and no document hints at who may read it.
    for (const doc of corpus) {
      for (const email of Object.values(SEED_USERS)) {
        expect(doc.body.includes(email), `${doc.key} mentions ${email}`).toBe(false);
      }
    }
  });

  /**
   * The end-to-end check asserts akua's generated answer contains none of the finance
   * figures. Those come from the hand-written finance document, so no generated document
   * may reuse them or that assertion would fail for an unrelated reason.
   */
  it('does not reuse the figures the end-to-end check treats as finance-only', () => {
    for (const doc of corpus) {
      for (const figure of ['4.2 million', '3.1 million', '3.6 million']) {
        expect(doc.body.includes(figure), `${doc.key} reuses "${figure}"`).toBe(false);
      }
    }
  });

  it('spreads documents evenly enough that no department dominates', () => {
    const counts = new Map<string, number>();
    for (const doc of corpus) {
      const department = doc.key.slice(CONTENT_PREFIX.length).split('/')[0] ?? '';
      counts.set(department, (counts.get(department) ?? 0) + 1);
    }

    for (const [department, count] of counts) {
      expect(count, department).toBeGreaterThanOrEqual(10);
    }
  });

  /**
   * Custom metadata attributes.
   *
   * These are what make business facets filterable. A filter on an attribute that was
   * not ingested returns no results rather than an error, so these tests check the
   * attributes before they reach the connector.
   */
  describe('metadata attributes', () => {
    it('gives every document the full documented attribute set', () => {
      for (const doc of corpus) {
        expect(Object.keys(doc.attributes).sort(), doc.key).toEqual(
          [...ATTRIBUTE_NAMES].sort(),
        );
      }
    });

    it('builds a valid sidecar for every document', () => {
      // buildSidecar throws on an empty attribute set, so this also proves none is empty.
      for (const doc of corpus) {
        expect(() => buildSidecar(doc.attributes), doc.key).not.toThrow();
      }
    });

    /**
     * The attribute has to agree with the key, because the key is the ACL boundary.
     *
     * A document under `content/finance/` carrying `department: engineering` would be
     * readable by finance and filterable as engineering, which is the kind of
     * inconsistency a reader would reasonably take for a permissions bug.
     */
    it('matches the department attribute to the department prefix', () => {
      for (const doc of corpus) {
        const fromKey = doc.key.slice(CONTENT_PREFIX.length).split('/')[0];

        expect(doc.attributes['department'], doc.key).toEqual({
          type: 'STRING',
          stringValue: fromKey,
        });
      }
    });

    it('keeps fiscalYear numeric so the range operators apply', () => {
      for (const doc of corpus) {
        const attribute = doc.attributes['fiscalYear'];

        expect(attribute?.type, doc.key).toBe('NUMBER');
        expect(
          typeof (attribute as { numberValue?: unknown }).numberValue,
          doc.key,
        ).toBe('number');
      }
    });

    /**
     * A date attribute has to be a full ISO-8601 instant.
     *
     * Range filters compare date attributes as ISO-8601 date-time strings, so `Q2 2024`
     * or `2024-04` would not compare correctly.
     */
    it('writes effectiveDate as an ISO-8601 instant', () => {
      for (const doc of corpus) {
        const value =
          (doc.attributes['effectiveDate'] as { stringValue?: string }).stringValue ??
          '';

        expect(value, doc.key).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00Z$/);
        expect(Number.isNaN(Date.parse(value)), doc.key).toBe(false);
      }
    });

    it('derives effectiveDate from the fiscal quarter and year', () => {
      const months: Record<string, string> = { Q1: '01', Q2: '04', Q3: '07', Q4: '10' };

      for (const doc of corpus) {
        const quarter =
          (doc.attributes['fiscalQuarter'] as { stringValue?: string }).stringValue ??
          '';
        const year =
          (doc.attributes['fiscalYear'] as { numberValue?: number }).numberValue ?? 0;
        const date =
          (doc.attributes['effectiveDate'] as { stringValue?: string }).stringValue ??
          '';

        expect(date, doc.key).toBe(`${String(year)}-${months[quarter]}-01T00:00:00Z`);
      }
    });

    it('gives topics at least one value so listContains has something to match', () => {
      for (const doc of corpus) {
        const attribute = doc.attributes['topics'];

        expect(attribute?.type, doc.key).toBe('STRING_LIST');
        expect(
          (attribute as { stringListValue?: readonly string[] }).stringListValue ?? [],
          doc.key,
        ).not.toHaveLength(0);
      }
    });

    /**
     * No duplicates within a topics list.
     *
     * Two picks from the same vocabulary collide often enough to show up, and a
     * two-element list holding one value twice reads as a metadata defect rather than a
     * coincidence — particularly in a sample whose subject is metadata.
     */
    it('gives every topics list distinct values', () => {
      for (const doc of corpus) {
        const values =
          (doc.attributes['topics'] as { stringListValue?: readonly string[] })
            .stringListValue ?? [];

        expect(new Set(values).size, doc.key).toBe(values.length);
      }
    });

    /**
     * Same rule as document bodies: no attribute may name a seed identity.
     *
     * Attributes are returned to the caller alongside results and, unlike a body, are
     * cheap to overlook. An identity here would disclose who may read a document to
     * everyone able to retrieve it.
     */
    it('names no seed identity in any attribute value', () => {
      for (const doc of corpus) {
        const serialized = JSON.stringify(doc.attributes);

        for (const identity of Object.values(SEED_USERS)) {
          expect(serialized, doc.key).not.toContain(identity);
        }
      }
    });
  });
});
