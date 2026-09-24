import { describe, expect, it } from 'vitest';
import {
  ATTRIBUTE_NAMES,
  buildSidecar,
  sidecarKey,
  type DocumentAttributes,
} from '../lib/seed-metadata';

const attributes: DocumentAttributes = {
  department: { type: 'STRING', stringValue: 'finance' },
  fiscalYear: { type: 'NUMBER', numberValue: 2026 },
  topics: { type: 'STRING_LIST', stringListValue: ['revenue', 'forecasting'] },
};

describe('sidecarKey', () => {
  /**
   * The connector finds a sidecar by appending `.metadata.json` to the document key, so
   * the suffix goes after the extension, not in place of it.
   */
  it('appends to the full document key, extension included', () => {
    expect(sidecarKey('content/finance/q3-review.md')).toBe(
      'content/finance/q3-review.md.metadata.json',
    );
  });

  it('does not replace the document extension', () => {
    expect(sidecarKey('content/finance/q3-review.md')).not.toBe(
      'content/finance/q3-review.metadata.json',
    );
  });
});

describe('buildSidecar', () => {
  it('wraps attributes in the metadataAttributes envelope', () => {
    expect(Object.keys(buildSidecar(attributes))).toEqual(['metadataAttributes']);
  });

  it('preserves each declared type', () => {
    const sidecar = buildSidecar(attributes);

    expect(sidecar.metadataAttributes['department']?.value).toEqual({
      type: 'STRING',
      stringValue: 'finance',
    });
    expect(sidecar.metadataAttributes['fiscalYear']?.value).toEqual({
      type: 'NUMBER',
      numberValue: 2026,
    });
    expect(sidecar.metadataAttributes['topics']?.value).toEqual({
      type: 'STRING_LIST',
      stringListValue: ['revenue', 'forecasting'],
    });
  });

  /**
   * A number has to stay a number.
   *
   * The declared type decides which operators work. `fiscalYear` written as `"2026"`
   * would be stored as a string and would not match a numeric range filter.
   */
  it('keeps a numeric attribute numeric', () => {
    const value = buildSidecar(attributes).metadataAttributes['fiscalYear']?.value;

    expect(value).toHaveProperty('numberValue');
    expect(typeof (value as { numberValue: unknown }).numberValue).toBe('number');
  });

  it('marks every attribute as excluded from the embedding', () => {
    const sidecar = buildSidecar(attributes);

    for (const entry of Object.values(sidecar.metadataAttributes)) {
      expect(entry.includeForEmbedding).toBe(false);
    }
  });

  /**
   * An empty sidecar is the case this guard exists for.
   *
   * It is valid, but it makes no attribute filterable, so every filter written against
   * the document would match nothing.
   */
  it('refuses to build an empty sidecar', () => {
    expect(() => buildSidecar({})).toThrow(/at least one attribute/);
  });

  it('serializes to JSON the connector can parse', () => {
    const json: unknown = JSON.parse(JSON.stringify(buildSidecar(attributes)));

    expect(json).toEqual({
      metadataAttributes: {
        department: {
          value: { type: 'STRING', stringValue: 'finance' },
          includeForEmbedding: false,
        },
        fiscalYear: {
          value: { type: 'NUMBER', numberValue: 2026 },
          includeForEmbedding: false,
        },
        topics: {
          value: { type: 'STRING_LIST', stringListValue: ['revenue', 'forecasting'] },
          includeForEmbedding: false,
        },
      },
    });
  });
});

describe('ATTRIBUTE_NAMES', () => {
  it('documents one attribute of each supported type', () => {
    expect(ATTRIBUTE_NAMES).toContain('fiscalYear');
    expect(ATTRIBUTE_NAMES).toContain('effectiveDate');
    expect(ATTRIBUTE_NAMES).toContain('topics');
  });

  it('has no duplicates', () => {
    expect(new Set(ATTRIBUTE_NAMES).size).toBe(ATTRIBUTE_NAMES.length);
  });
});
